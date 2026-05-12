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

  // PTY → 画面 ＋ 検出バッファ
  term.onData((data) => {
    process.stdout.write(data)
    if (logStream) logStream.write(data)
    onPtyData(data)
  })

  // 画面 → PTY
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', (d) => term.write(d.toString()))

  // リサイズ
  process.stdout.on('resize', () => {
    term.resize(process.stdout.columns || cols, process.stdout.rows || rows)
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
// 直近 PTY 出力のスライディングウィンドウ（クリーン済み）
// 800 文字あれば 1 ダイアログ分（~300 文字）+ 周辺コンテキストを十分保持できる。
// バッファを大きく取りすぎると、ダイアログが画面から消えた後も古い "Esc to cancel" が
// 残り続けて parseDialog が誤検出し、resolved-by-cli の検知が遅れる。
let cleanBuf = ''
const CLEAN_BUF_MAX = 800

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
function normalizePrompt(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
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

function stripAnsi(s) {
  return s
    // Claude Code v2.1.x はダイアログ内の半角スペースを実文字ではなく
    // CSI <n>C (Cursor Forward) で「列をジャンプ」して描画する。
    // そのまま削ると "Doyouwanttocreate..." のように単語が連結してしまうため、
    // 一般 ANSI 除去の前に <n>C / 単独 C を相応の空白へ展開しておく。
    // n が異常値の場合に備え 200 で頭打ち（行幅の上限相当）。
    .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Math.min(parseInt(n, 10) || 0, 200)))
    .replace(/\x1b\[C/g, ' ')
    .replace(/\x1b\]0;[^\x07]*\x07/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/\x7f/g, '')
}

function onPtyData(chunk) {
  cleanBuf += stripAnsi(chunk)
  if (cleanBuf.length > CLEAN_BUF_MAX) cleanBuf = cleanBuf.slice(-CLEAN_BUF_MAX)
  detectDialog().catch((e) => wlog(`detect error: ${e.message}`))
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
  // cleanBuf 全体（最大 CLEAN_BUF_MAX 文字）が候補。
  // ダイアログ自体は通常 ~300 文字程度だが、tool 行が画面上で
  // ボックスより少し上に描画されるケースに備えて広めに見る。
  const segStart = Math.max(0, endIdx - CLEAN_BUF_MAX)
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
  const lineStart =
    nlIdx >= 0
      ? nlIdx
      : Math.max(
          beforeQ.lastIndexOf('│'),
          beforeQ.lastIndexOf('─'),
          beforeQ.lastIndexOf('╌'),
          -1
        )
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
  const options = sortedMarks.map((mk, i) => {
    const nextAt = i + 1 < sortedMarks.length ? sortedMarks[i + 1].at : optionSegment.length
    return optionSegment
      .slice(mk.end, nextAt)
      .replace(/❯/g, '')
      .replace(/[\r\n]/g, ' ')
      .replace(/[─╌│╭╮╰╯]/g, '')
      .replace(/^[.\s]+/, '')
      .replace(/\s+/g, ' ')
      .trim()
  })
  if (options.every((o) => !o)) return null

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

// テスト用エクスポート (実行時には影響なし)
if (typeof module !== 'undefined') {
  module.exports = { parseDialog, stripAnsi, validateAnswer }
}

async function detectDialog() {
  const d = parseDialog(cleanBuf)
  if (d) {
    // ダイアログが見えている間は消失タイマーを止める。
    clearTimeout(dismissalTimer)
    dismissalTimer = null

    // 同一ダイアログ判定: 時間窓内 + オプション数一致 + prompt 類似 で再描画扱い。
    // ConPTY で tool 行が遅れて描画される/prompt 文字が落ちるケースに耐える。
    if (currentDialog) {
      const ago = Date.now() - currentDialog.lastSeenAt
      const sameOptionShape = currentDialog.options.length === d.options.length
      const similar = promptSimilar(currentDialog.prompt, d.prompt)
      if (ago < DEDUP_WINDOW_MS && sameOptionShape && similar) {
        // 再描画: ツール情報が遅れて揃った場合はここで補完
        if (currentDialog.tool === 'Unknown' && d.tool !== 'Unknown') {
          currentDialog.tool = d.tool
          currentDialog.args = d.args
        }
        currentDialog.lastSeenAt = Date.now()
        return
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

    // 他経路（cli/pc/smartphone）の区別は resp には含まれないので answer で判断
    // C3: answer の厳密 whitelist
    const key = validateAnswer(resp.answer, currentDialog.options)
    if (!key) {
      wlog(
        `answer "${String(resp.answer).slice(0, 40)}" は許可された値ではない。注入スキップ。`
      )
    } else {
      term.write(key + '\r')
      // 古いダイアログ本文を捨てておかないと、画面上は閉じても cleanBuf に
      // "Esc to cancel" 等が残って parseDialog が「まだダイアログがある」と
      // 誤判定し、次のダイアログ検出や dismissal 検知が遅れる。
      cleanBuf = ''
      wlog(`injected "${key}" for dialog ${id}`)
    }
    // currentDialog は PTY 出力でダイアログが消えたら自然に消える
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

// ダイアログが画面から消えた（= β 応答があった）と判定する処理
async function onDialogDismissed() {
  dismissalTimer = null
  if (!currentDialog) return
  // 発火時点で再度 parseDialog して、ウィンドウ内にまだダイアログがあればキャンセル
  if (parseDialog(cleanBuf)) return
  if (Date.now() - currentDialog.lastSeenAt < DISMISSAL_MS) return
  await resolveCurrentAsCli()
}

async function resolveCurrentAsCli() {
  const d = currentDialog
  currentDialog = null
  // dismiss 確定時点で古いダイアログ本文を捨てる。残しておくと次のダイアログ
  // 検出時に古い tool 行を拾って誤分類する原因になる。
  cleanBuf = ''
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
