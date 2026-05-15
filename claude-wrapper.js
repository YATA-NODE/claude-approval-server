#!/usr/bin/env node
/**
 * claude-wrapper.js
 *
 * Claude Code CLI を PTY で包み、承認ダイアログをスマホ／PC ブラウザから
 * 承認・拒否できるようにするラッパー。
 *
 * 動作概要:
 *   1. 起動時に approval-server (localhost) の疎通を確認する。
 *      繋がらない場合は明確なエラーで終了する。
 *   2. node-pty で claude を子プロセス起動し、標準入出力を透過する。
 *   3. PTY 出力を逐次パースし、承認ダイアログを検出したら
 *      approval-server に POST /request して id を受け取る。
 *   4. GET /status/:id?wait=60 の long-poll で応答を待つ。
 *      応答が来たら 1/2/3 のキーを PTY に注入する。
 *   5. ユーザーが CLI で直接応答（ダイアログが画面から消えた）した場合は
 *      POST /resolve/:id を resolvedBy='cli' で呼び、α 側（スマホ/ブラウザ）
 *      の表示を消す。
 *
 * 使い方:
 *   node claude-wrapper.js [claude へ渡す引数]
 *
 * 重要なセキュリティ前提:
 *   - approval-server 側が 127.0.0.1 バインド、ngrok 経由の通信前提
 *   - wrapper は answer を数字 1〜3 または options 配列の完全一致のみ受理
 *   - それ以外は破棄（PTY への任意注入を防ぐ）
 */

const pty = require('node-pty')
// v1.11.2: PTY 出力を headless terminal に write して画面バッファを正確に再現する。
// Claude Code TUI は CSI カーソル移動で in-place 差分再描画するため、ANSI を正規表現で
// 除去する旧 stripAnsi 方式では描画順序が崩れ、スピナー混在時にダイアログを取りこぼす。
// 必須依存(純 JS・native build 不要なので install 失敗リスクは低い)。
const { Terminal } = require('@xterm/headless')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const crypto = require('crypto')

// -------------------------------------------------------
// 設定読み込み
// -------------------------------------------------------
function loadConfig() {
  const configPath = path.join(__dirname, 'approval-config.json')
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (_) {
    return {}
  }
}
const config = loadConfig()
// 優先順位（approval-server.js と揃える）:
//   PORT:  env > config > 3000（ポート衝突時に一時切替したい場面が多い）
//   TOKEN: config > env > ''（長期固定値、無関係な env での上書きを防ぐ）
const APPROVAL_PORT = parseInt(process.env.APPROVAL_PORT) || config.port || 3000
const SECRET_TOKEN = config.token || process.env.APPROVAL_TOKEN || ''

// プロジェクト名: ラッパーを呼び出したターミナルの cwd から derive する。
// 複数プロジェクトで並行起動したときにスマホ側でどの依頼か識別するために使う。
// ルート直下などで basename が空になった場合は 'unknown' を充てる。
const PROJECT_NAME = path.basename(process.cwd()) || 'unknown'

// ダイアログ検出: 終端マーカー (Esc to cancel) を主アンカーに使う。
// 旧 v1.7.3 までは "Do you want to" を主トリガーにしていたが、Claude Code v2.1.x の
// Write/Edit 系ダイアログは ANSI 部分再描画の副作用で "Do you want t creat ..."
// のように 1〜2 文字単位で欠落するため、プロンプト本文ベースの検出が成立しなくなった。
// 一方 "Esc to cancel" は別行に独立描画されるため空白崩れ ("Esctocancel") のみで済む。
// 必要なら approval-config.json の dialogDetection.endMarker で上書き可能。
const END_MARKER_PATTERN =
  (config.dialogDetection && config.dialogDetection.endMarker) || 'Esc\\s*to\\s*cancel'
const END_MARKER_RE_G = new RegExp(END_MARKER_PATTERN, 'gi')

const isWindows = os.platform() === 'win32'

// -------------------------------------------------------
// HTTP ヘルパー（localhost の approval-server に対してのみ使う）
// -------------------------------------------------------
function httpRequest(method, urlPath, body, timeoutMs = 70000) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: APPROVAL_PORT,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-secret-token': SECRET_TOKEN,
          ...(data ? { 'Content-Length': data.length } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let buf = ''
        res.on('data', (d) => (buf += d))
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}: ${buf}`))
          }
          try {
            resolve(JSON.parse(buf))
          } catch (_) {
            resolve(buf)
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('request timeout')))
    if (data) req.write(data)
    req.end()
  })
}

// -------------------------------------------------------
// 起動時チェック
// -------------------------------------------------------
async function preflight() {
  if (!SECRET_TOKEN) {
    console.error('\n❌ APPROVAL_TOKEN が未設定です。')
    console.error('   approval-config.json に token を設定するか、環境変数 APPROVAL_TOKEN を設定してください。\n')
    process.exit(1)
  }
  try {
    await httpRequest('GET', '/queue', null, 3000)
  } catch (e) {
    console.error(`\n❌ approval-server (http://127.0.0.1:${APPROVAL_PORT}) に接続できません: ${e.message}`)
    console.error(`   先に別ターミナルで approval-server を起動してください:`)
    console.error(`     node approval-server.js\n`)
    process.exit(1)
  }
}

// -------------------------------------------------------
// PTY 起動
// -------------------------------------------------------
let term
// v1.11.2: PTY 出力を流し込む headless terminal。spawnClaude() で生成。
let headlessTerm = null

// getScreenText が表示領域より上に含めるスクロールバック行数。
// ダイアログボックス + その上の `● Tool(args)` 行(スクロール退避しうる)を
// カバーしつつ、過去ダイアログの古い "Esc to cancel" 混入を防ぐ妥協点。
const SCREEN_SCROLLBACK_LINES = 40

// headless terminal の画面バッファ(表示領域 + 指定行数のスクロールバック)を
// テキスト化する純粋関数。getScreenText() と test-parse-dialog.js の両方から使う。
// trimRight=true で行幅パディング(Claude TUI は cols 幅まで空白埋めする)を除去し、
// \n 区切りにすることで parseDialog の改行アンカーがそのまま効く。
function screenTextFromBuffer(buffer, rows, scrollbackLines) {
  const startLine = Math.max(0, buffer.baseY - scrollbackLines)
  const endLine = buffer.baseY + rows
  const lines = []
  for (let y = startLine; y < endLine && y < buffer.length; y++) {
    const line = buffer.getLine(y)
    if (line) lines.push(line.translateToString(true))
  }
  return lines.join('\n')
}

// 現在の画面状態をテキスト化して返す。headlessTerm 未生成時は空文字。
function getScreenText() {
  if (!headlessTerm) return ''
  return screenTextFromBuffer(
    headlessTerm.buffer.active,
    headlessTerm.rows,
    SCREEN_SCROLLBACK_LINES
  )
}

function spawnClaude() {
  const shell = isWindows ? 'cmd.exe' : '/bin/bash'
  const userArgs = process.argv.slice(2)
  const args = isWindows
    ? ['/c', 'claude', ...userArgs]
    : ['-c', ['claude', ...userArgs].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')]
  const cols = process.stdout.columns || 120
  const rows = process.stdout.rows || 30

  term = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: process.env,
  })

  // v1.11.2: 画面バッファ再現用の headless terminal を pty と同じ cols/rows で生成。
  // allowProposedApi は buffer API (proposed) アクセスに必須。
  try {
    headlessTerm = new Terminal({
      cols,
      rows,
      scrollback: 1000,
      allowProposedApi: true,
    })
  } catch (e) {
    console.error(`\n❌ @xterm/headless の初期化に失敗しました: ${e.message}`)
    console.error('   npm install を実行して依存を解決してください。\n')
    process.exit(1)
  }

  // PTY → 画面 ＋ 検出バッファ
  term.onData((data) => {
    process.stdout.write(data)
    if (logStream) logStream.write(data)
    onPtyData(data)
  })

  // 画面 → PTY
  // タブ巡回中・複合質問再生中は stdin を一時バッファして、
  // 終了後に flushStdinBuffer() で流す。ユーザの PC 入力でタブ位置がズレないようにするため。
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', (d) => pipeStdinToTerm(d.toString()))

  // リサイズ
  // v1.11.2: headless terminal も同じ cols/rows に揃える。揃えないとグリッド再現が
  // 実 TUI とズレて parseDialog の行構造が壊れる。
  process.stdout.on('resize', () => {
    const newCols = process.stdout.columns || cols
    const newRows = process.stdout.rows || rows
    term.resize(newCols, newRows)
    if (headlessTerm) {
      try {
        headlessTerm.resize(newCols, newRows)
      } catch (_) {}
    }
  })

  // 終了
  term.onExit(({ exitCode }) => {
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false)
      } catch (_) {}
    }
    if (logStream) logStream.end()
    if (wrapperLogStream) wrapperLogStream.end()
    if (headlessTerm) {
      try {
        headlessTerm.dispose()
      } catch (_) {}
    }
    process.exit(exitCode)
  })
}

// -------------------------------------------------------
// PTY ログ（開発用・通常運用では無効）
// -------------------------------------------------------
const logPath = process.env.APPROVAL_PTY_LOG
const logStream = logPath ? fs.createWriteStream(logPath, { flags: 'a' }) : null
if (logStream) logStream.write(`\n===== ${new Date().toISOString()} wrapper start =====\n`)

// -------------------------------------------------------
// 実行中ログ（dialog posted / injected / resolved by CLI 等）
// Claude Code TUI はフルスクリーン描画するため、stderr に直接書くと
// ステータスバーや選択肢と重なって表示が崩れる。既定では完全サイレントとし、
// APPROVAL_WRAPPER_LOG (env) または config.wrapperLog でファイル指定された
// 場合のみそこへ append する。tail -f で別端末から監視する想定。
// 起動時の preflight エラーと spawnClaude 直前の "project=..." 行は
// TUI が始まる前なので従来どおり stderr に出す（このヘルパーの対象外）。
const wrapperLogPath = process.env.APPROVAL_WRAPPER_LOG || config.wrapperLog || ''
const wrapperLogStream = wrapperLogPath
  ? fs.createWriteStream(wrapperLogPath, { flags: 'a' })
  : null
if (wrapperLogStream) {
  wrapperLogStream.write(`\n===== ${new Date().toISOString()} wrapper start =====\n`)
}
function wlog(msg) {
  if (!wrapperLogStream) return
  wrapperLogStream.write(`[${new Date().toISOString()}] ${msg}\n`)
}

// -------------------------------------------------------
// ダイアログ検出
// -------------------------------------------------------
// v1.11.2: 検出は headless terminal の画面バッファ(getScreenText())ベースに移行。
// 旧 cleanBuf スライディングウィンドウは廃止。
// DIALOG_SEGMENT_MAX は parseDialog が END_MARKER 手前を「ダイアログ候補領域」と
// して見る幅。getScreenText() はタブバー + prompt + options + フッタ + その上の
// tool 行(スクロールバック退避しうる)を含むので、それ全体をカバーする値。
const DIALOG_SEGMENT_MAX = 2000

// 現在有効なダイアログ（approval-server に登録済み）
// { id, options, tool, args, prompt, lastSeenAt }
let currentDialog = null

// ダイアログ消失検知用タイマー
let dismissalTimer = null
// Claude の TUI は dialog 描画後にユーザー入力待ちで止まるため、
// 単に PTY チャンク間隔が空いただけで消失判定するとスマホ応答前に
// 誤って resolved-by-cli になる。periodicCheck がアイドル中も parseDialog を
// 走らせて lastSeenAt を更新するため、この値は「本当に描画が入れ替わって
// 何秒間トリガーが見えなくなったら消失とみなすか」の窓になる。
const DISMISSAL_MS = 2000

// 同一ダイアログの再描画とみなす時間窓。ConPTY の文字落ちで
// prompt が "Do you want to create..." → "Do you want t creat..."
// のようにフレームごとに崩れるため、prompt ハッシュでは同一判定できない。
// 「直前に検出していた」かつ「オプション数が一致」かつ「prompt が類似」なら同じ扱い。
const DEDUP_WINDOW_MS = 15000

// prompt 類似度: 文字落ち（"Do you want to create" → "Do you want t creat"）に
// 耐性を持たせるため、正規化後に subsequence 一致率で判定する。
// 日本語(ひらがな/カタカナ/漢字)も比較対象にするため、空白・罫線・制御文字のみ
// 除去する。旧実装は /[^a-z0-9]/ で日本語を全削除しており、日本語 prompt が
// 常に空文字列になって promptSimilar が機能不全(常に false 返却)だった。
function normalizePrompt(s) {
  return s
    .toLowerCase()
    .replace(/[\s　│╭╮╰╯─╌\r\n]+/g, '')
}
function promptSimilar(a, b) {
  const na = normalizePrompt(a)
  const nb = normalizePrompt(b)
  if (!na.length || !nb.length) return false
  const [shorter, longer] = na.length < nb.length ? [na, nb] : [nb, na]
  if (longer.includes(shorter)) return true
  let i = 0
  for (const c of longer) {
    if (c === shorter[i]) i++
    if (i === shorter.length) break
  }
  return i / shorter.length >= 0.85
}

// 2 つのダイアログが「同じ形状」(prompt + options 長さ一致)か判定する。
// dedup / sweepTabs / waitTabStable で共通利用。exactPrompt=true なら完全一致、
// 既定は promptSimilar(部分描画・文字欠けに耐性)。a/b いずれかが null/falsy なら false。
function dialogShapeMatches(a, b, { exactPrompt = false } = {}) {
  if (!a || !b) return false
  if (a.options.length !== b.options.length) return false
  return exactPrompt ? a.prompt === b.prompt : promptSimilar(a.prompt, b.prompt)
}

// v1.11.2: 解決済みダイアログの抑制機構(旧 `cleanBuf = ''` リセットの代替)。
// 旧実装は cleanBuf を空にして「古いダイアログ本文を捨てる」ことで、回答済みなのに
// parseDialog が同じダイアログを再検出するのを防いでいた。
// headless terminal ベースでは画面が再描画されれば buffer は自然に最新化されるが、
// 「回答注入直後〜次フレーム描画まで」「ダイアログがスクロールバックに残存」する
// 一瞬は getScreenText() が解決済みダイアログを返しうる。そこで物理クリアではなく
// 「解決済み prompt を一定時間 promptSimilar で無視する」論理抑制に置き換える。
let suppressedPrompt = null
let suppressedAt = 0
const SUPPRESS_WINDOW_MS = 3000

// replayMultiAnswers のタイミング値(実機 TUI の再描画速度に依存)
const MULTI_TAB_STEP_MS = 150 // 数字キー入力 → タブ自動遷移 + 再描画の待ち
const MULTI_SUBMIT_WAIT_MS = 250 // 最終回答 → Submit 確認画面の描画待ち

function suppressCurrentDialog(prompt) {
  if (typeof prompt !== 'string' || !prompt) return
  suppressedPrompt = prompt
  suppressedAt = Date.now()
}

// 純粋判定(副作用なし)。期限切れの suppressedPrompt は次の
// suppressCurrentDialog で上書きされるか、false を返し続けるだけで実害なし。
function isSuppressed(d) {
  if (!d || suppressedPrompt === null) return false
  if (Date.now() - suppressedAt > SUPPRESS_WINDOW_MS) return false
  return promptSimilar(d.prompt, suppressedPrompt)
}

// v1.11.2: 本番検出経路は getScreenText()(headless terminal)に移行したため、
// 本関数は実行時には使われない。test-parse-dialog.js の fixture 整形と後方互換
// テスト用に定義・export を残している。
function stripAnsi(s) {
  return s
    // Claude Code v2.1.x はダイアログ内の半角スペースを実文字ではなく
    // CSI <n>C (Cursor Forward) で「列をジャンプ」して描画する。
    // そのまま削ると "Doyouwanttocreate..." のように単語が連結してしまうため、
    // 一般 ANSI 除去の前に <n>C / 単独 C を相応の空白へ展開しておく。
    // n が異常値の場合に備え 200 で頭打ち（行幅の上限相当）。
    .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Math.min(parseInt(n, 10) || 0, 200)))
    .replace(/\x1b\[C/g, ' ')
    // ↓N 行: CSI B (Cursor Down) / CSI E (Cursor Next Line) を可視的な改行へ。
    // ConPTY ではダイアログの行送りがこれで描画されるため、\n に翻訳しないと
    // parseDialog が行頭マーカーを認識できず、タブバーが prompt に混入したり
    // 同一行に並ぶオプション 2/3 を取りこぼす。n 異常値に備え 20 で頭打ち。
    .replace(/\x1b\[(\d*)[BE]/g, (_, n) => '\n'.repeat(Math.min(parseInt(n, 10) || 1, 20)))
    .replace(/\x1b\]0;[^\x07]*\x07/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/\x7f/g, '')
    // スピナー描画(Claude TUI の "Dilly-dallying…" 等)はカーソル上下移動を多用し、
    // CSI B → \n 変換後に大量の連続改行を生む。これが cleanBuf のスライディング
    // ウィンドウを埋め尽くしてダイアログ本体を押し出すため、3 個以上の連続改行は
    // 2 個に圧縮する。parseDialog の行頭マーカー判定には \n 2 個あれば十分。
    .replace(/\n{3,}/g, '\n\n')
}

function onPtyData(chunk) {
  // v1.11.2: headless terminal にそのまま write し、ANSI 解釈はライブラリに任せる。
  // write のコールバックはバッファ反映後に呼ばれるので、そこで検出を回す
  // (中途半端な描画状態で parseDialog することがなくなる)。
  // 画面透過(process.stdout.write)は本関数より前に実行済みなので、検出が失敗
  // しても TUI 表示には影響しない。
  try {
    headlessTerm.write(chunk, () => {
      detectDialog().catch((e) => wlog(`detect error: ${e.message}`))
    })
  } catch (e) {
    wlog(`headless write error: ${e.message}`)
  }
}

// ダイアログ構造パターン (Claude Code v2.1.x 以降):
//   ● <Tool>(<args>)
//   ─────...                        ← ボックス上端
//    <action description>           ← 例: "Create file"
//    <target>                       ← 例: "test.txt"
//   ╌╌╌╌...                         ← 区切り
//    <preview / diff>
//   ╌╌╌╌...
//    Do you want to <...>?          ← 質問 (新フォーマットでは部分的に文字落ちすることあり)
//    ❯ 1. <opt1>                    ← カーソル付きオプション 1
//      2. <opt2 ... shift+tab>      ← オプション 2 (常に shift+tab ヒント付き)
//      3. <opt3>                    ← オプション 3
//   Esc to cancel                   ← 終端マーカー (新フォーマットでは "Esctocancel" に潰れる)
//
// 検出戦略:
//   1. 終端マーカー (Esc to cancel) の最後の出現を主アンカーとする
//   2. その手前 ~2000 文字を「ダイアログ候補領域」とする
//   3. 偽陽性除外: "❯" + 数字 (アクティブな選択カーソル) が領域内に存在
//   4. プロンプト = 領域内の最後の "?" を含む行
//   5. オプション = "?" 以降から終端マーカーまでに並ぶ 1, 2, 3 の番号マーカー
//   6. ツール行 = プロンプトより前にある最新の `● Tool(args)`

function parseDialog(buf) {
  // 1. 終端マーカーの最終出現を取得
  const endMatches = [...buf.matchAll(END_MARKER_RE_G)]
  if (endMatches.length === 0) return null
  const endIdx = endMatches[endMatches.length - 1].index

  // 2. ダイアログ候補領域 (末尾マーカーの直前)
  // END_MARKER の手前 DIALOG_SEGMENT_MAX 文字を候補とする。
  // ダイアログ自体は通常 ~300 文字程度だが、tool 行が画面上で
  // ボックスより少し上に描画されるケースに備えて広めに見る。
  const segStart = Math.max(0, endIdx - DIALOG_SEGMENT_MAX)
  const segment = buf.slice(segStart, endIdx)

  // 3. 偽陽性除外: アクティブカーソル `❯` + 数字 1〜9 が必須
  // AskUserQuestion 型は選択肢が 4 個以上になることがあるため 1〜9 を許容。
  if (!/❯\s*[1-9]/.test(segment)) return null

  // 4. プロンプト抽出
  const qIdx = segment.lastIndexOf('?')
  if (qIdx < 0) return null
  const beforeQ = segment.slice(0, qIdx)
  // 改行を最優先で行頭とみなす。改行が見つからない場合のみボックス文字へフォールバック。
  // AskUserQuestion 型の prompt は同じ行内のボックス文字(─ など)を本文として持つ
  // ことがあるため、改行があれば必ずそちらを優先する。
  const nlIdx = beforeQ.lastIndexOf('\n')
  // タブ式 (AskUserQuestion-Multi) では ConPTY が「↓1 行」を改行文字ではなく
  // CSI B で描画するため stripAnsi 後に \n が残らず、タブバー (`← ... ✔ Submit →`)
  // が prompt に混入する。
  // hot path 削減: nlIdx >= 0 の通常パスでは isTabbedDialog を呼ばない。
  //
  // 行末アンカー優先順位:
  //   1. `Submit` 末尾 — AskUserQuestion-Multi 仕様で必ず存在し、prompt 本文より
  //      確実に手前にある(prompt 内の `→` 誤検出も Submit より後ろなので無害)
  //   2. タブマーカー (☐ ✔ □ ✓) と `→` の最終出現 — Submit が無い UI へのフォールバック
  let arrowIdx = -1
  if (nlIdx < 0 && isTabbedDialog(segment)) {
    const submitIdx = beforeQ.lastIndexOf('Submit')
    if (submitIdx >= 0) {
      arrowIdx = submitIdx + 'Submit'.length - 1
    } else {
      arrowIdx = Math.max(
        beforeQ.lastIndexOf('☐'),
        beforeQ.lastIndexOf('✔'),
        beforeQ.lastIndexOf('□'),
        beforeQ.lastIndexOf('✓'),
        beforeQ.lastIndexOf('→')
      )
    }
  }
  // 行頭アンカーの優先順: 改行 > タブバー右端(arrowIdx) > ボックス文字
  const boxCharIdx = Math.max(
    beforeQ.lastIndexOf('│'),
    beforeQ.lastIndexOf('─'),
    beforeQ.lastIndexOf('╌'),
    -1
  )
  const fallbackIdx = arrowIdx >= 0 ? arrowIdx : boxCharIdx
  const lineStart = nlIdx >= 0 ? nlIdx : fallbackIdx
  const prompt = segment
    .slice(lineStart + 1, qIdx + 1)
    .replace(/[│╭╮╰╯─╌\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!prompt) return null

  // 5. オプション抽出
  const optionSegment = segment.slice(qIdx + 1)
  // 数字 1〜9 単体を番号マーカーとして検出する。
  // 既定は厳格モード: 「行頭 / `❯` の直後 / 空白経由で行頭側」に位置するもののみ採用。
  // 本文中の「1 枚目」「2 枚目」等を誤検知しないため。
  // 厳格モードで 0 件のときは旧 regex(数字隣接のみで判定)にフォールバック =
  // ANSI 部分再描画で行頭判定がズレた旧フォーマット互換も維持する。
  const LINE_START_CHARS = '\n│╭╮╰╯─╌'
  function isStrictMarkerStart(i) {
    if (i === 0) return true
    const prev = optionSegment[i - 1]
    if (prev === '❯') return true
    if (LINE_START_CHARS.includes(prev)) return true
    if (/\s/.test(prev)) {
      // 左にさかのぼり、空白だけを跨いで行頭/`❯`/区切り文字に到達するなら OK
      for (let j = i - 2; j >= 0; j--) {
        const c = optionSegment[j]
        if (c === '❯' || LINE_START_CHARS.includes(c)) return true
        if (!/\s/.test(c)) return false
      }
      return true
    }
    return false
  }
  const found = new Map()
  // 厳格モード: 行頭限定で 1〜9 を歩く
  for (let i = 0; i < optionSegment.length; i++) {
    const ch = optionSegment[i]
    if (ch < '1' || ch > '9') continue
    const next = optionSegment[i + 1]
    if (next && next >= '0' && next <= '9') continue // 連桁(行番号など)は除外
    if (!isStrictMarkerStart(i)) continue
    if (!found.has(ch)) found.set(ch, { at: i, end: i + 1 })
  }
  // フォールバック: 厳格 0 件なら旧 regex で再試行(後方互換性)
  if (found.size === 0) {
    const fallbackRe = /(?<![A-Za-z0-9])([1-9])(?![0-9])/g
    let mm
    while ((mm = fallbackRe.exec(optionSegment)) !== null) {
      if (!found.has(mm[1])) found.set(mm[1], { at: mm.index, end: mm.index + 1 })
    }
  }
  if (found.size === 0) return null

  const sortedMarks = [...found.entries()]
    .map(([num, pos]) => ({ num: parseInt(num), at: pos.at, end: pos.end }))
    .sort((a, b) => a.at - b.at)
  // 各 option 末尾には Claude TUI のキー操作ヒント
  // ("Enter to select · Tab/Arrow keys to navigate · Esc to cancel" 等)が
  // 文字列として混入することがあるので、抽出後に tail trim で除去する。
  // ※ Claude TUI 組み込みの "Type something" / "Chat about this" 自体は v1.11.1
  //   以降スマホ側に表示する(v1.12.0 でテキスト送信経路追加予定)。
  const TUI_TAIL_HINT_RE =
    /(?:Enter\s+to\s+select|Tab\s*\/\s*Arrow\s+keys|Esc\s+to\s+cancel)[\s\S]*$/i
  const options = sortedMarks.map((mk, i) => {
    const nextAt = i + 1 < sortedMarks.length ? sortedMarks[i + 1].at : optionSegment.length
    return optionSegment
      .slice(mk.end, nextAt)
      .replace(/❯/g, '')
      .replace(/[\r\n]/g, ' ')
      .replace(/[─╌│╭╮╰╯]/g, '')
      .replace(/^[.\s]+/, '')
      .replace(/\s+/g, ' ')
      .replace(TUI_TAIL_HINT_RE, '')
      .trim()
  })
  if (options.length === 0 || options.every((o) => !o)) return null

  // 6. ツール行: プロンプトより前にある最新の `● Tool(args)` を採用
  const promptAbsStart = segStart + lineStart + 1
  const beforeDialog = buf.slice(0, promptAbsStart)
  const toolMatches = [...beforeDialog.matchAll(/●\s*([A-Za-z_]+)\s*\(([\s\S]*?)\)/g)]
  const lastTool = toolMatches[toolMatches.length - 1]
  let tool = lastTool ? lastTool[1] : 'Unknown'
  let args = lastTool
    ? lastTool[2].replace(/[\r\n]/g, ' ').replace(/\s+/g, ' ').trim()
    : ''

  // 6b. tool が拾えなかった場合の fallback: ダイアログボックス内のアクションラベルから推測。
  // 新フォーマットでは初回ダイアログ時に `● Tool(args)` 行がまだ描画されていないことがあり、
  // その場合でもスマホ側に何のツールか伝わるようにする。
  if (tool === 'Unknown') {
    const boxText = segment.slice(0, qIdx)
    const labelTable = [
      [/Bash\s*command|Run\s*command/i, 'Bash'],
      [/Create\s*file/i, 'Write'],
      [/Update|Edit/i, 'Edit'],
      [/Delete/i, 'Bash'],
      [/Read\s*file/i, 'Read'],
      [/Search|Grep/i, 'Grep'],
    ]
    for (const [re, t] of labelTable) {
      if (re.test(boxText)) {
        tool = t
        // ラベルの直後にある対象パスっぽい文字列を args として拾う
        const m = boxText.match(
          /(?:Bash\s*command|Create\s*file|Update|Edit|Delete|Read\s*file|Search|Grep)[\s│╭╮╰╯─╌:]*([^\n│╭╮╰╯─╌?]{2,80})/i
        )
        if (m && !args) args = m[1].replace(/\s+/g, ' ').trim()
        break
      }
    }
  }

  // 6c. それでも tool が Unknown のままなら AskUserQuestion 型ダイアログと推定する。
  // 判定シグナル: shift+tab ヒント不在 ∧ (選択肢 4 個以上 ∨ 平均長 25 文字以上 ∨ prompt が "Do you want to" で始まらない)。
  // 既存ツール系を AskUserQuestion と誤判定しないよう、必ず fallback テーブル不一致時のみ評価する。
  if (tool === 'Unknown') {
    const hasShiftTab = /shift\s*\+\s*tab/i.test(optionSegment)
    const avgLen =
      options.reduce((s, o) => s + o.length, 0) / Math.max(options.length, 1)
    const looksLikeAUQ =
      !hasShiftTab &&
      (options.length >= 4 || avgLen >= 25 || !/Do you want to/i.test(prompt))
    if (looksLikeAUQ) tool = 'AskUserQuestion'
  }

  return { prompt, options, tool, args }
}

// タブ式 AskUserQuestion(複合質問)の特徴判定。
// 画面上部に `□タブ1 □タブ2 ✓タブ3 ✓Submit →` のタブバー + 下部に
// "Tab/Arrow keys to navigate" ヘルプが出る形式を検出する。
// `parseDialog` が単一ダイアログとして検出した上で、本関数が true なら
// `sweepTabs` で全タブを巡回するパスに進む。
function isTabbedDialog(buf) {
  // Claude TUI は U+2610 (☐) / U+2714 (✔) を使う環境が多いが、フォント未対応の
  // 環境で U+25A1 (□) / U+2713 (✓) にフォールバックされる場合もあるため両方拾う。
  const boxMarks = (buf.match(/[□☐✓✔]/g) || []).length
  const hasNav = /→|Tab\s*\/\s*Arrow\s+keys/i.test(buf)
  return boxMarks >= 2 && hasNav
}

// v1.12.0 (D1): approval-server.js / approval-ui.html の同名定数と完全同期。
// Defense in depth として wrapper 側にも持つ(サーバ防御を信頼しすぎず、
// 注入直前の最後の関門で再検証)。
const FREE_TEXT_OPTION_RE = /^Type\s+something\.?$/i
const CHAT_ABOUT_RE = /^Chat\s+about\s+this\.?$/i

// 複合質問の回答配列バリデータ。
// answers は次の要素を含む配列(長さは tabs.length と一致):
//   - 文字列 "1"〜"9"(=数字キーのみ送信、Type something 以外のオプション)
//   - { num: "1"〜"9", text?: string }(=text あれば「数字キー → モード遷移
//     待ち → 1 文字ずつ → Enter」で TUI に Type something を注入)
// 後方互換: v1.11.x 時点の「string 配列」呼び出しもそのまま受容する。
// 戻り値は常に { num, text? } 形式に正規化された配列(replayMultiAnswers の
// 単一処理パスに揃えるため)。違反は null。
function validateMultiAnswer(answers, tabs) {
  if (!Array.isArray(answers) || !Array.isArray(tabs)) return null
  if (answers.length !== tabs.length) return null
  if (tabs.length === 0 || tabs.length > 9) return null
  const out = []
  for (let i = 0; i < answers.length; i++) {
    const item = answers[i]
    let num, rawText
    if (typeof item === 'string') {
      num = item.trim()
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      num = String(item.num == null ? '' : item.num).trim()
      if (item.text != null) rawText = item.text
    } else {
      return null
    }
    if (!/^[1-9]$/.test(num)) return null
    if (!tabs[i] || !Array.isArray(tabs[i].options)) return null
    const idx = parseInt(num, 10) - 1
    if (idx >= tabs[i].options.length) return null
    const selectedOpt = tabs[i].options[idx]
    // D1 (codex B002 修正 defense in depth): Chat about this を指す回答は遠隔不能
    if (CHAT_ABOUT_RE.test(selectedOpt)) return null
    if (rawText !== undefined) {
      // D1 (codex B002 修正 defense in depth): text 添付は Type something 限定
      if (!FREE_TEXT_OPTION_RE.test(selectedOpt)) return null
      const safeText = validateFreeText(rawText)
      if (!safeText) return null
      out.push({ num, text: safeText })
    } else {
      out.push({ num })
    }
  }
  return out
}

// テスト用エクスポート (実行時には影響なし)
if (typeof module !== 'undefined') {
  module.exports = {
    parseDialog,
    stripAnsi,
    validateAnswer,
    isTabbedDialog,
    validateMultiAnswer,
    screenTextFromBuffer,
    validateFreeText,
  }
}

// -------------------------------------------------------
// タブ式 AskUserQuestion(複合質問)対応
// -------------------------------------------------------
//
// 複数質問を 1 ダイアログにまとめた「タブ式」UI に対応するため、
// wrapper 側で各タブを巡回してキャプチャ → サーバー登録 → スマホで全件回答
// → wrapper が PTY に再生して Submit するフローを実装する。
//
// 巡回・再生中は:
//   - detectDialog の通常パスをガード(tabSweepInProgress / tabReplayInProgress)
//   - process.stdin の入力を一時バッファ → 完了後に flush
//
// 注入する制御コード(Tab/Shift-Tab/Enter)は wrapper 内部生成のみ。
// HTTP 経路から任意の制御コードが流れ込まないよう validateMultiAnswer で
// 数字のみを許可する。

let tabSweepInProgress = false
let tabReplayInProgress = false
const stdinBuffer = []

function pipeStdinToTerm(data) {
  if (tabSweepInProgress || tabReplayInProgress) {
    stdinBuffer.push(data)
    return
  }
  term.write(data)
}

function flushStdinBuffer() {
  while (stdinBuffer.length > 0) {
    term.write(stdinBuffer.shift())
  }
}

// 1 タブ進めた後、parseDialog が 2 回連続同結果を返したら確定とみなす。
// 80ms ポーリング、上限 timeoutMs。null 連続 3 回でも早期脱出(描画停止検知)。
// previous{Prompt,OptionsLen} が与えられた場合、それと類似する間は「タブ切替後の
// 再描画がまだ完了していない」とみなし安定判定しない。完全一致ではなく
// promptSimilar を使うのは、部分描画・文字欠け等で「前タブにかなり似てるが完全
// 一致しない」状態を新タブと誤確定するのを防ぐため。
async function waitTabStable(
  timeoutMs = 600,
  previousPrompt = null,
  previousOptionsLen = -1
) {
  const t0 = Date.now()
  let prev = null
  let stableCount = 0
  let nullCount = 0
  while (Date.now() - t0 < timeoutMs) {
    await sleep(80)
    const d = parseDialog(getScreenText())
    if (!d) {
      nullCount++
      if (nullCount >= 3) return prev
      stableCount = 0
      prev = d
      continue
    }
    // 前のタブとプロンプト類似 + 選択肢長さ一致 = 再描画未完了 → 待ち継続
    if (
      previousPrompt !== null &&
      promptSimilar(d.prompt, previousPrompt) &&
      (previousOptionsLen < 0 || d.options.length === previousOptionsLen)
    ) {
      stableCount = 0
      prev = d
      continue
    }
    nullCount = 0
    if (dialogShapeMatches(prev, d, { exactPrompt: true })) {
      stableCount++
      if (stableCount >= 2) return d
    } else {
      stableCount = 0
    }
    prev = d
  }
  return prev
}

// 現在の dialog から Tab で順送りしながら各タブを収集する。
// 1 周完了の判定は「先頭タブと一致」または「直前タブと一致(Submit にフォーカスが
// 移って Tab で動かなくなった状態)」のいずれか。最大 9 周で打ち切り。
// 巡回後は Shift+Tab で元の位置(=先頭タブ)に戻す。
// finally で flushStdinBuffer() を呼ぶことで、単一質問フォールバック時にも
// 巡回中の PC 入力がバッファに残らないようにする。
// Shift+Tab を 3 回打って先頭タブ(タブ 1)へフォーカスを戻す。
// Shift+Tab はタブ 1 から先には進まないので、余分に押しても副作用なし。
// Submit にフォーカスがある状態から先頭まで戻るのに必要な回数 = タブ数 + 1。
// 典型タブ数 2-3 のときは 3 回で十分。タブ数増加時はここを再調整する。
async function rewindToFirstTab() {
  for (let i = 0; i < 3; i++) {
    term.write('\x1b[Z')
    await sleep(50)
  }
}

async function sweepTabs() {
  tabSweepInProgress = true
  try {
    // 巡回開始前にフォーカスを先頭タブに戻す。初期フォーカスがタブ 2 等に
    // あると、Tab で右回りに巡回して Submit に到達した時点で break してしまい、
    // 戻る側のタブ(タブ 1 等)が漏れるため。
    await rewindToFirstTab()
    // 戻し後の再描画が安定するまで待つ
    await waitTabStable(400)

    const first = parseDialog(getScreenText())
    if (!first) return null
    const tabs = [first]
    for (let i = 0; i < 9; i++) {
      term.write('\t')
      // 前のタブの prompt + options 長さを渡し、再描画未完了の中間状態を
      // 安定判定から除外する(部分描画・文字欠けでも promptSimilar で類似判定)。
      const last = tabs[tabs.length - 1]
      const next = await waitTabStable(600, last.prompt, last.options.length)
      if (!next) break
      if (dialogShapeMatches(next, tabs[0])) break // 先頭に戻ってきた → 1 周完了
      if (dialogShapeMatches(next, last)) break // Tab で動かない(Submit フォーカス等)
      tabs.push(next)
    }
    // 巡回終了後も先頭タブに戻す
    await rewindToFirstTab()
    return tabs
  } finally {
    tabSweepInProgress = false
    // v1.11.2: getScreenText() はステートレス(常に「現在の画面」を返す)なので
    // 巡回後の特別な後始末は不要。flushStdinBuffer のみ行う。
    flushStdinBuffer()
  }
}

// 複合質問の応答キー列を PTY に再生する。
// answers は validateMultiAnswer 通過済の { num, text? } 配列。
//   - text なし: 数字キー押下で「選択肢選択 + 自動で次のタブへ移動」
//     (実機確認済 2026-05-14)
//   - text あり: 数字キー(Type something モードへ遷移)→ MODE_TRANSITION_MS
//     待ち → 1 文字ずつ → Enter → TUI が自動で次タブへ遷移
//     (実機確認済 2026-05-15)
// 最後のタブ回答完了で自動的に Submit 確認画面(「Review your answers」)
// へ遷移するので '1\r' で確定。
async function replayMultiAnswers(answers) {
  tabReplayInProgress = true
  try {
    for (let i = 0; i < answers.length; i++) {
      const a = answers[i]
      term.write(a.num) // 数字 1 文字
      if (a.text != null) {
        await sleep(MODE_TRANSITION_MS)
        let j = 0
        for (const ch of a.text) {
          term.write(ch)
          await sleep(j < CHAR_INJECT_WARMUP ? CHAR_INJECT_MS_SLOW : CHAR_INJECT_MS_FAST)
          j++
        }
        term.write('\r')
      }
      // Enter 後 / 数字キー後ともに次タブの描画安定を待つ
      await sleep(MULTI_TAB_STEP_MS)
    }
    await sleep(MULTI_SUBMIT_WAIT_MS)
    term.write('1\r')
    // v1.11.2: 回答済みダイアログを次フレーム描画まで再検出しないよう論理抑制
    if (currentDialog) suppressCurrentDialog(currentDialog.prompt)
  } finally {
    tabReplayInProgress = false
    flushStdinBuffer()
  }
}

// v1.12.0: スマホからのキャンセル指示を PC TUI の Esc キーで再現する。
// 単一質問・複合質問・Type something 入力モードのいずれの状態でもダイアログ
// を抜けて通常チャットへ戻る(TUI のフッタ「Esc to cancel」と同等の操作)。
async function replayCancel() {
  tabReplayInProgress = true
  try {
    term.write('\x1b') // Esc
    if (currentDialog) suppressCurrentDialog(currentDialog.prompt)
  } finally {
    tabReplayInProgress = false
    flushStdinBuffer()
  }
}

async function registerMultiDialog(tabs, projectName) {
  const description = `[${projectName}][AskUserQuestion-Multi] 複合質問 ${tabs.length} 件`
  const tabsPayload = tabs.map((t, i) => ({
    label: t.tool && t.tool !== 'Unknown' ? t.tool : `Q${i + 1}`,
    prompt: t.prompt,
    options: t.options,
  }))
  // タブ式ダイアログのために専用スロットを予約してから POST する。
  currentDialog = {
    prompt: tabs[0].prompt,
    options: tabs[0].options,
    tabs,
    id: null,
    lastSeenAt: Date.now(),
  }
  try {
    const resp = await httpRequest('POST', '/request', {
      description,
      options: ['Submit'], // sentinel
      tabs: tabsPayload,
    })
    if (currentDialog && currentDialog.id === null && currentDialog.tabs === tabs) {
      currentDialog.id = resp.id
      // POST 完了直後、最後に見た時刻も更新して dismissal 早発火を防ぐ。
      // PTY 再描画が遅延しても 2 秒の猶予が確実に取れる。
      currentDialog.lastSeenAt = Date.now()
      clearTimeout(dismissalTimer)
      dismissalTimer = null
      wlog(`multi dialog posted: id=${resp.id}, tabs=${tabs.length}`)
      pollForResponse(resp.id).catch((e) => wlog(`poll error: ${e.message}`))
    }
  } catch (e) {
    wlog(`POST /request (multi) failed: ${e.message} (継続: CLI 応答のみ有効)`)
    if (currentDialog && currentDialog.id === null) currentDialog = null
  }
}

async function detectDialog() {
  // タブ巡回 / 再生中は通常検出をスキップ(dedup・誤登録を回避)
  if (tabSweepInProgress || tabReplayInProgress) return

  // 画面バッファのテキストを 1 回取得し、detectDialogSingle にも引数で渡す
  // (同一 onPtyData 内での二度取りを避ける)
  const screen = getScreenText()

  // タブ式の判定: parseDialog が non-null かつ isTabbedDialog が真なら sweep に進む
  // ただし currentDialog が既にあって同じ複合質問が回答待ちなら通常パスに戻る
  if (!currentDialog && isTabbedDialog(screen)) {
    const probe = parseDialog(screen)
    if (probe) {
      const tabs = await sweepTabs()
      if (tabs && tabs.length >= 2) {
        await registerMultiDialog(tabs, PROJECT_NAME)
        return
      }
      // タブが 1 件しか拾えなければ単一質問として通常パスへフォールバック
    }
  }

  await detectDialogSingle(screen)
}

// screen は detectDialog から渡される。単独テスト等のため未指定なら自前取得。
async function detectDialogSingle(screen = getScreenText()) {
  const parsed = parseDialog(screen)
  // v1.11.2: 解決済みダイアログ(suppressCurrentDialog で抑制中)は「見えていない」
  // 扱いにする。これにより消失タイマー設定パスに落ち、回答後の自然な dismiss が進む。
  const d = parsed && !isSuppressed(parsed) ? parsed : null
  if (d) {
    // ダイアログが見えている間は消失タイマーを止める。
    clearTimeout(dismissalTimer)
    dismissalTimer = null

    // 同一ダイアログ判定: 時間窓内 + オプション数一致 + prompt 類似 で再描画扱い。
    // ConPTY で tool 行が遅れて描画される/prompt 文字が落ちるケースに耐える。
    if (currentDialog) {
      const ago = Date.now() - currentDialog.lastSeenAt
      if (ago < DEDUP_WINDOW_MS && dialogShapeMatches(currentDialog, d)) {
        // 再描画: ツール情報が遅れて揃った場合はここで補完
        if (currentDialog.tool === 'Unknown' && d.tool !== 'Unknown') {
          currentDialog.tool = d.tool
          currentDialog.args = d.args
        }
        currentDialog.lastSeenAt = Date.now()
        return
      }
      // 複合ダイアログ: いずれかの tab と一致 or タブバーがまだ画面にあれば
      // 「ユーザーが ←/→ で別タブに動いただけ」とみなし、dedup pass + lastSeenAt 更新。
      // これがないと初期フォーカスが tabs[0] 以外のタブにある場合に prompt 不一致で
      // resolveCurrentAsCli に直行してダイアログが消える。
      if (currentDialog.tabs && ago < DEDUP_WINDOW_MS) {
        const tabMatched = currentDialog.tabs.some((t) => dialogShapeMatches(t, d))
        if (tabMatched || isTabbedDialog(screen)) {
          currentDialog.lastSeenAt = Date.now()
          return
        }
      }
    }

    // 別ダイアログに切り替わった → 旧ダイアログは CLI 応答済み扱い
    if (currentDialog) await resolveCurrentAsCli()

    await registerDialog(d)
    return
  }

  // ウィンドウ内にダイアログが見えない → 消失タイマーを仕掛ける（既に仕掛かっていれば放置）
  if (currentDialog && currentDialog.id && !dismissalTimer) {
    dismissalTimer = setTimeout(onDialogDismissed, DISMISSAL_MS)
  }
}

// アイドル中（PTY 出力が来ない間）もダイアログ状態を追跡するための定期チェック。
// onPtyData 経由だけだと、ユーザー入力待ちで止まっている間に detectDialog が
// 呼ばれず、消失判定が実態と乖離する。
setInterval(() => {
  detectDialog().catch((e) => wlog(`periodic detect error: ${e.message}`))
}, 400)

async function registerDialog(d) {
  const shortArgs = d.args.length > 200 ? d.args.slice(0, 200) + '…' : d.args
  // args が空のとき "tool]  —" のような空白の間延びが起きるのを避ける
  const description = shortArgs
    ? `[${PROJECT_NAME}][${d.tool}] ${shortArgs} — ${d.prompt}`
    : `[${PROJECT_NAME}][${d.tool}] ${d.prompt}`
  // POST /request 中に別の PTY チャンクで detectDialog が走ると
  // currentDialog=null のまま二重登録されてしまう。先にスロットを予約する。
  currentDialog = { ...d, id: null, lastSeenAt: Date.now() }
  try {
    const resp = await httpRequest('POST', '/request', { description, options: d.options })
    // スロットが別物に置き換わっていなければ id を埋める
    if (currentDialog && currentDialog.id === null && currentDialog.prompt === d.prompt) {
      currentDialog.id = resp.id
      wlog(`dialog posted: id=${resp.id}`)
      pollForResponse(resp.id).catch((e) => wlog(`poll error: ${e.message}`))
    }
  } catch (e) {
    wlog(`POST /request failed: ${e.message} (継続: CLI 応答のみ有効)`)
    // サーバー連携断時は予約スロットを解放（誤って resolve を投げないため）
    if (currentDialog && currentDialog.id === null) currentDialog = null
  }
}

async function pollForResponse(id) {
  while (currentDialog && currentDialog.id === id) {
    let resp
    try {
      resp = await httpRequest('GET', `/status/${id}?wait=60`, null, 70000)
    } catch (e) {
      // 接続断・一時エラー。少し待って再試行
      await sleep(3000)
      continue
    }
    if (resp.status !== 'resolved') {
      // タイムアウト（pending）で返ってきただけ → 再ループ
      continue
    }
    // resolve された。CLI で既に応答済みなら注入しない。
    if (!currentDialog || currentDialog.id !== id) return

    // v1.12.0: スマホからキャンセル指示が来た場合、Esc キーを TUI に注入して
    // ダイアログを破棄する。complete/single 両方の経路で使える。
    if (resp.action === 'cancel') {
      await replayCancel()
      wlog(`cancelled dialog ${id} by remote`)
      return
    }

    // 複合質問: answers 配列を validateMultiAnswer で検証し replay
    if (Array.isArray(currentDialog.tabs)) {
      const validated = validateMultiAnswer(resp.answers, currentDialog.tabs)
      if (!validated) {
        wlog(
          `multi answers "${JSON.stringify(resp.answers).slice(0, 80)}" は許可された値ではない。注入スキップ。`
        )
      } else {
        await replayMultiAnswers(validated)
        // text 内容はログに出さず、長さのみ記録(defense in depth)
        const summary = validated.map((a) =>
          a.text != null ? { num: a.num, text_len: a.text.length } : { num: a.num }
        )
        wlog(`injected multi answers ${JSON.stringify(summary)} for dialog ${id}`)
      }
      return
    }

    // 他経路（cli/pc/smartphone）の区別は resp には含まれないので answer で判断
    // C3: answer の厳密 whitelist
    const key = validateAnswer(resp.answer, currentDialog.options)
    if (!key) {
      wlog(
        `answer "${String(resp.answer).slice(0, 40)}" は許可された値ではない。注入スキップ。`
      )
      return
    }

    // D1 (codex B003 修正 defense in depth): key が指す option が Chat about this なら注入拒否
    const selectedOpt = currentDialog.options[parseInt(key, 10) - 1]
    if (CHAT_ABOUT_RE.test(selectedOpt)) {
      wlog(`answer points to "Chat about this" which is not remote-controllable. 注入スキップ。`)
      return
    }

    // v1.12.0: スマホからフリーテキストが添付されている場合の経路。
    // resp.text を validateFreeText で再検証(defense in depth)し、
    // replayFreeText で「キー → モード遷移待ち → 1 文字ずつ → Enter」で注入。
    // text なしの通常経路は従来通り「数字 + Enter」のみ。
    if (resp.text != null) {
      // D1 (codex B001 修正 defense in depth): text 添付は Type something option 限定
      if (!FREE_TEXT_OPTION_RE.test(selectedOpt)) {
        wlog(
          `text is attached but selected option "${selectedOpt}" is not "Type something". 注入スキップ。`
        )
        return
      }
      const safeText = validateFreeText(resp.text)
      if (!safeText) {
        wlog(
          `text "${String(resp.text).slice(0, 40)}" は許可された値ではない。注入スキップ。`
        )
        return
      }
      await replayFreeText(key, safeText)
      wlog(
        `injected free text (key="${key}", len=${safeText.length}) for dialog ${id}`
      )
      return
    }

    term.write(key + '\r')
    // v1.11.2: 回答済みダイアログを次フレーム描画まで再検出しないよう論理抑制。
    // (旧実装の cleanBuf='' の代替。詳細は suppressCurrentDialog のコメント参照)
    suppressCurrentDialog(currentDialog.prompt)
    wlog(`injected "${key}" for dialog ${id}`)
    return
  }
}

// answer を「1〜9 の文字」または「options 完全一致」→ 対応する番号に正規化
// AskUserQuestion 型ダイアログでは選択肢が最大 9 個になり得るため、1〜9 を許容する。
function validateAnswer(answer, options) {
  if (typeof answer !== 'string') return null
  const a = answer.trim()
  if (/^[1-9]$/.test(a)) {
    const idx = parseInt(a) - 1
    if (idx >= 0 && idx < options.length) return a
    return null
  }
  const idx = options.indexOf(a)
  if (idx >= 0 && idx < 9) return String(idx + 1)
  // 'resolved-by-cli' 等は CLI 側で既に応答済みを意味するので注入しない
  return null
}

// v1.12.0: フリーテキスト送信(Type something 経路)用の defense in depth 検証。
// v1.12.0 (codex 3rd s2 / D2 反映): server の sanitizeFreeText は現在 strict reject
// 型(v1.11.x までの「削除整形」から v1.12.0 で挙動変更)= wrapper の本関数と同じ
// 契約。UI 側は事前削除型(ユーザー入力ミスを優しく整形)。
// 検査: 文字列 / 長さ 1〜MAX_FREE_TEXT_LEN / C0 + DEL + C1 制御文字を含まない /
//      trim 後 length>0(空白のみ拒否)。
// v1.12.0 (codex 3rd W002 修正): C1 制御文字(\x80-\x9F)も server と統一して拒否。
const MAX_FREE_TEXT_LEN = 2000
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F\x80-\x9F]/
function validateFreeText(text) {
  if (typeof text !== 'string') return null
  if (text.length === 0 || text.length > MAX_FREE_TEXT_LEN) return null
  if (CONTROL_CHARS_RE.test(text)) return null
  if (text.trim().length === 0) return null
  return text
}

// v1.12.0 注入タイミング定数。Claude TUI のテキスト入力欄が値を受け取れる
// ペース。MODE_TRANSITION_MS は「数字キーで Type something モードへ切替 →
// 入力欄表示完了」までの待ち。CHAR_INJECT_MS_SLOW は遷移直後のウォームアップ
// 用(入力欄バッファが安定するまで)、CHAR_INJECT_MS_FAST は定常時。
const MODE_TRANSITION_MS = 200
const CHAR_INJECT_MS_SLOW = 30
const CHAR_INJECT_MS_FAST = 10
const CHAR_INJECT_WARMUP = 30 // 最初の N 文字を SLOW、以後 FAST

// v1.12.0: フリーテキストを PTY に「1 文字ずつ + 遅延」で再生する。
// 1. 該当数字キー(Type something など)を注入して Claude TUI をテキスト入力モードへ
// 2. モード遷移完了を待つため sleep MODE_TRANSITION_MS
// 3. text を 1 文字ずつ term.write、最初 CHAR_INJECT_WARMUP 文字は SLOW、以後 FAST
// 4. 最後に Enter で確定
// 200 文字テキストの場合: 30*30 + 170*10 = 2.6 秒。固定 30ms (6 秒) より速い。
async function replayFreeText(key, text) {
  tabReplayInProgress = true
  try {
    term.write(key)
    await sleep(MODE_TRANSITION_MS)
    // for-of は Unicode code point ベース(サロゲートペアの絵文字も 1 文字扱い)
    let i = 0
    for (const ch of text) {
      term.write(ch)
      await sleep(i < CHAR_INJECT_WARMUP ? CHAR_INJECT_MS_SLOW : CHAR_INJECT_MS_FAST)
      i++
    }
    term.write('\r')
    // v1.11.2: 回答済みダイアログを次フレーム描画まで再検出しないよう論理抑制
    if (currentDialog) suppressCurrentDialog(currentDialog.prompt)
  } finally {
    tabReplayInProgress = false
    flushStdinBuffer()
  }
}

// ダイアログが画面から消えた（= β 応答があった）と判定する処理
async function onDialogDismissed() {
  dismissalTimer = null
  if (!currentDialog) return
  // 発火時点で再度 parseDialog して、画面にまだ(抑制対象でない)ダイアログが
  // あればキャンセルしない
  const d = parseDialog(getScreenText())
  if (d && !isSuppressed(d)) return
  if (Date.now() - currentDialog.lastSeenAt < DISMISSAL_MS) return
  await resolveCurrentAsCli()
}

async function resolveCurrentAsCli() {
  const d = currentDialog
  currentDialog = null
  // v1.11.2: dismiss 確定したダイアログを次フレーム描画まで再検出しないよう論理抑制。
  // (旧実装の cleanBuf='' の代替。残しておくと次の検出で古い tool 行を拾う原因に)
  if (d && d.prompt) suppressCurrentDialog(d.prompt)
  if (!d || !d.id) return
  try {
    await httpRequest('POST', `/resolve/${d.id}`, {
      answer: 'resolved-by-cli',
      resolvedBy: 'cli',
    })
    wlog(`dialog ${d.id} resolved by CLI`)
  } catch (e) {
    // すでに resolved 済み等は無視
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// -------------------------------------------------------
// メイン (require された場合は副作用を起こさない)
// -------------------------------------------------------
if (require.main === module) {
  ;(async () => {
    await preflight()
    process.stderr.write(`[wrapper] project="${PROJECT_NAME}" (cwd=${process.cwd()})\n`)
    spawnClaude()
  })()

  process.on('exit', () => {
    try {
      if (term) term.kill()
    } catch (_) {}
  })
}
