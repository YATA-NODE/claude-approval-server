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
  // APPROVAL_CONFIG で別の設定ファイルを指定できる(既定は同梱の approval-config.json)。
  // 例: codex 用に APPROVAL_CONFIG=approval-config.codex.json を渡し、claude 用と
  //     port / token / 検出マーカーを分離して同時併用する。
  const configPath = process.env.APPROVAL_CONFIG || path.join(__dirname, 'approval-config.json')
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

// ダイアログ検出: 終端マーカー (Esc to cancel 等) を主アンカーに使う。
// 旧 v1.7.3 までは "Do you want to" を主トリガーにしていたが、Claude Code v2.1.x の
// Write/Edit 系ダイアログは ANSI 部分再描画の副作用で "Do you want t creat ..."
// のように 1〜2 文字単位で欠落するため、プロンプト本文ベースの検出が成立しなくなった。
// 一方 "Esc to cancel" は別行に独立描画されるため空白崩れ ("Esctocancel") のみで済む。
//
// ExitPlanMode(プラン承認)プロンプトだけは例外で、フッタが "Esc to cancel" ではなく
// "shift+tab to approve with this feedback" になり Esc to cancel が出ない。このため
// 終端マーカーを OR で拡張して両方を主アンカーにする。"shift+tab to approve" は
// ExitPlanMode 固有で通常ダイアログには出ないため誤検出しにくい。なお終端マーカーは
// 検出領域(segment)の末尾アンカーなので、shift+tab 行で切れる結果フッタ2行
// (shift+tab… / ctrl+g to edit…)は options に混入しない。
// 必要なら approval-config.json の dialogDetection で終端マーカーを調整できる:
//   - 推奨: dialogDetection.endMarkers = { default, exitPlan }(型付き)。default は通常
//     ダイアログ用("Esc to cancel" 相当)、exitPlan は ExitPlanMode 用。省略時は各既定値。
//   - 互換: dialogDetection.endMarker(文字列)は default 部分として扱い、ExitPlanMode
//     マーカーは常に OR される(旧仕様の「shift+tab を含め忘れると ExitPlanMode 検出が死ぬ」
//     footgun を構造的に解消)。非推奨のため load 時に warn。
// ExitPlanMode 固有の終端マーカー。endMarkers の既定値とツール分類(EXIT_PLAN_END_RE)の
// 両方で同じ定数を使い、検出条件と分類条件が乖離しないようにする(単一ソース)。
const EXIT_PLAN_END_PATTERN = 'shift\\+tab\\s+to\\s+approve'
const EXIT_PLAN_END_RE = new RegExp(EXIT_PLAN_END_PATTERN, 'i')
const DEFAULT_END_MARKER = 'Esc\\s*to\\s*cancel'
// v1.17.0 (Phase 3b): codex プランモードの選択肢質問(= AskUserQuestion 相当)のフッタは
// "tab to add notes | enter to submit answer | esc to interrupt"。既定 endMarker
// "Esc to cancel" に非一致なので、config なしでは検出できなかった。質問型に最も特異な
// "enter to submit answer" を ExitPlanMode マーカーと同様に常時 OR-in して既定検出可能にする
// (`esc to interrupt` は他文脈でも出うるため主キーにしない)。claude UI はこの語を出さない
// ため誤検出ゼロ(233 fixture で回帰確認)。
// v1.17.0 (Phase 3d): 複数質問フローの最後の問(Question M/M)はフッタが "enter to submit all"
// に変わる(実機確認: ユーザー画面)。これを拾えないと sweep が最後の問を読めず M-1 問しか
// 登録できない。よって submit (answer|all) を両方マッチさせる。claude UI は両語とも出さない
// ため誤検出ゼロを維持。
const CODEX_QUESTION_END_PATTERN = 'enter\\s+to\\s+submit\\s+(?:answer|all)'
const CODEX_QUESTION_END_RE = new RegExp(CODEX_QUESTION_END_PATTERN, 'i')
// codex プランモードの選択肢質問のヘッダ "Question N/N (M unanswered)"。prompt 抽出時に
// この行を段落境界として扱い、prompt 本文(ヘッダの下の行)に混入させない。
const CODEX_QUESTION_HEADER_RE = /^Question\s+\d+\/\d+/i
// 同ヘッダの N(現在番号)と M(総数)を取る global RE。M>1 = 複数質問フロー(←/→ で巡回する
// タブ式相当)。sweep の Q1 復帰回数 (N-1) と巡回 loop bound(M)、および M>1 判定に使う。
// m[1]=N / m[2]=M。**行頭アンカー必須**(`m` フラグ + `^\s*`): codex の実ヘッダは行頭(インデント
// 込み)に描画される。非アンカーだと prompt/options 本文に紛れた "Question 9/9" 等をヘッダ誤認し、
// 単一質問を multi 扱いで検出抑止 / sweep の移動数・総数汚染が起きうる(codex adversarial review B001)。
// 既存 CODEX_QUESTION_HEADER_RE(`^Question…`)と整合。誤認時も fail-safe(PC フォールバック)だが
// 行頭限定で誤認面を最小化する。
const CODEX_QUESTION_POS_RE_G = /^\s*Question\s+(\d+)\/(\d+)/gim

// v1.17.0 (Phase 3d): segment 内に分母 M>1 の "Question N/M" が 1 つでもあるか(global 走査で全件
// some)。先頭マッチ依存だと画面上方に残る stale な "Question 1/1" が現 "Question 2/3" より先に
// 当たりすり抜けるため全件走査する。parseDialog の M>1 抑止ガード(:734)と isCodexMultiQuestion の
// 前段ゲートが共有する唯一の述語(二重持ち = drift 源を回避)。
function hasMultiCodexQuestion(segment) {
  return [...String(segment).matchAll(CODEX_QUESTION_POS_RE_G)].some((m) => parseInt(m[2], 10) > 1)
}

// 終端マーカー正規表現パターンを組み立てる純関数(テスト seam)。ExitPlanMode マーカーと
// codex 質問型マーカーが構成から脱落しないよう常に OR-in する。
// 優先順: 型付き endMarkers > legacy endMarker > 既定。
function composeEndMarkerPattern(dialogDetection) {
  const dd = dialogDetection || {}
  if (dd.endMarkers && typeof dd.endMarkers === 'object') {
    const def = dd.endMarkers.default || DEFAULT_END_MARKER
    const exit = dd.endMarkers.exitPlan || EXIT_PLAN_END_PATTERN
    return `${def}|${exit}|${CODEX_QUESTION_END_PATTERN}`
  }
  if (typeof dd.endMarker === 'string' && dd.endMarker) {
    return `${dd.endMarker}|${EXIT_PLAN_END_PATTERN}|${CODEX_QUESTION_END_PATTERN}`
  }
  return `${DEFAULT_END_MARKER}|${EXIT_PLAN_END_PATTERN}|${CODEX_QUESTION_END_PATTERN}`
}
const _dialogDetection = config && config.dialogDetection
if (
  _dialogDetection &&
  typeof _dialogDetection.endMarker === 'string' &&
  _dialogDetection.endMarker &&
  !_dialogDetection.endMarkers
) {
  console.warn(
    '[claude-wrapper] dialogDetection.endMarker は非推奨です。dialogDetection.endMarkers.default を' +
      '使ってください(ExitPlanMode マーカーは自動で OR されます)。'
  )
}
const END_MARKER_PATTERN = composeEndMarkerPattern(_dialogDetection)
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
            // statusCode を error に持たせ、呼び出し側で 404(登録喪失)等を判別可能にする。
            const err = new Error(`HTTP ${res.statusCode}: ${buf}`)
            err.statusCode = res.statusCode
            return reject(err)
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

// 起動対象 CLI コマンドの解決。既定は 'claude'。codex 等へ切り替える場合は
// approval-config.json の target.command か 環境変数 APPROVAL_TARGET_CMD で指定する。
// この値は下の shell 引数文字列('-c' / '/c')に挿入されるため、シェルメタ文字を含む
// 値は拒否して任意コマンド注入(踏み台化)を防ぐ。許可は英数と . _ - / のみ。
function resolveTargetCommand() {
  const raw =
    process.env.APPROVAL_TARGET_CMD || (config.target && config.target.command) || 'claude'
  if (typeof raw !== 'string' || !/^[A-Za-z0-9._\/-]+$/.test(raw)) {
    console.error(`\n❌ 不正な起動コマンドです: ${JSON.stringify(raw)}(許可文字: 英数 . _ - /)\n`)
    process.exit(1)
  }
  return raw
}

// v1.16.0 (Phase 3a): 起動対象 CLI をモジュールロード時に 1 回だけ解決して保持する。
// 注入関数(pollForResponse 等)は spawnClaude のローカルスコープ外で動くため、
// codex 向けのキー注入分岐に必要な「いま codex を相手にしているか」をここで確定させる。
// IS_CODEX は basename 一致(パス付き起動・実行ファイル拡張子を許容)。claude では
// false で既存経路が完全不変。判定漏れ(例 Windows の codex.cmd / codex.exe)は危険:
// IS_CODEX=false で番号 + Enter 経路に落ち、codex の既定 option1(承認)を誤確定しうる
// (拒否のはずが承認 = failure #Z 同型)ため、起動形態の揺れを広めに codex と判定する。
// resolveTargetCommand が許可するのは英数 . _ - / のみ(バックスラッシュは exit(1) 拒否)
// なので path.basename は / 区切りで安定。純関数化してテストで判定境界を固定する。
function isCodexCommand(cmd) {
  return /^codex(?:\.(?:exe|cmd))?$/i.test(path.basename(String(cmd)))
}
const TARGET_CMD = resolveTargetCommand()
const IS_CODEX = isCodexCommand(TARGET_CMD)

function spawnClaude() {
  const shell = isWindows ? 'cmd.exe' : '/bin/bash'
  const userArgs = process.argv.slice(2)
  const targetCmd = TARGET_CMD
  const args = isWindows
    ? ['/c', targetCmd, ...userArgs]
    : ['-c', [targetCmd, ...userArgs].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')]
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

// -------------------------------------------------------
// 境界文字集合(罫線 / ボックス枠 / タブ印 / カーソル)の単一ソース。
// 各検出箇所でリテラル直書きすると、片方だけ直し忘れて検出が drift する。
// ※ メンバーを変えると検出挙動が変わる。test-parse-dialog.js [22] が membership を固定する。
// -------------------------------------------------------
const BOX_CHARS = '│╭╮╰╯─╌' // ボックス枠 + 罫線(7文字)
const RULE_CHARS = '─╌' // 横罫線のみ
const PROMPT_BOX_ANCHOR_CHARS = '│─╌' // prompt 行頭アンカー探索用の意図的サブセット(╭╮╰╯ を含まない)
const TAB_MARK_CHARS = '☐✔□✓' // タブバーのチェック印(U+2610/U+2714 と □/✓ フォールバック)
const TAB_ARROW_CHAR = '→'
const CURSOR_CHAR = '❯' // アクティブ選択カーソル(claude)
// 起動対象 CLI でカーソル記号が異なる(claude=❯ U+276F / codex=› U+203A)。検出は
// この集合のいずれかをカーソルとして扱う。新しい CLI のカーソルはここに足す。
// char class へ直挿入するため、正規表現メタ文字(- ^ ] \)は含めないこと。
const CURSOR_CHARS = CURSOR_CHAR + '›'
const BULLET_CHAR = '●' // Claude の tool/message 行の行頭マーカー = ターン境界(box 描画文字に含まれない)
const LINE_START_CHARS = '\n' + BOX_CHARS // 行頭とみなす文字(改行 + ボックス枠)

// 派生 RegExp(上記集合に正規表現メタ文字 `- ^ ] \` は含まれないため char class 直挿入で安全)。
const BOX_CHARS_G = new RegExp(`[${BOX_CHARS}]`, 'g')
const BOX_OR_NEWLINE_G = new RegExp(`[${BOX_CHARS}\\r\\n]`, 'g')
const PROMPT_NORMALIZE_STRIP_RE = new RegExp(`[\\s　${BOX_CHARS}\\r\\n]+`, 'g')
const RULE_LINE_RE = new RegExp(`^[${RULE_CHARS}\\s]+$`)
const TAB_BAR_RE = new RegExp(`[${TAB_MARK_CHARS}${TAB_ARROW_CHAR}]`)
const CURSOR_G = new RegExp(`[${CURSOR_CHARS}]`, 'g')
const CURSOR_NUM_RE = new RegExp(`[${CURSOR_CHARS}]\\s*[1-9]`)
const CURSOR_ANY_RE = new RegExp(`[${CURSOR_CHARS}]`) // 行内カーソル有無(非 global の membership 判定)
const TAB_MARK_G = new RegExp(`[${TAB_MARK_CHARS}]`, 'g') // チェック印のみ(→ を含まない)
const TAB_NAV_RE = new RegExp(`${TAB_ARROW_CHAR}|Tab\\s*/\\s*Arrow\\s+keys`, 'i')
// ●Tool() 行未描画時のラベル推測 fallback。ラベル直後の対象パスを args に拾う。
const LABEL_ARGS_RE = new RegExp(
  `(?:Bash\\s*command|Create\\s*file|Update|Edit|Delete|Read\\s*file|Search|Grep)` +
    `[\\s${BOX_CHARS}:]*([^\\n${BOX_CHARS}?]{2,80})`,
  'i'
)

// ツール承認分類シグナル(W002 = AUQ 文言依存の解消)。
// ●Tool() 行のマーカー。AUQ は専用 ●AskUserQuestion() 行を持たない。
const TOOL_LINE_RE = /●\s*([A-Za-z_]+)\s*\(([\s\S]*?)\)/g
// 既知のツール承認 / ExitPlanMode 定型句(弱シグナル)。文言追加はここ 1 箇所で。
const APPROVAL_PHRASE_RE = /Do you want to/i
// ●Tool 行未描画フレームでも承認に倒すための box 内 multi-word アクションラベル。
// 汎用 1 語(Edit/Update/Delete/Search)は AUQ 本文で誤爆するため multi-word 限定。
const ACTION_LABEL_RE = /\b(?:Bash command|Run command|Create file|Read file)\b/i
// hasActionLabel の走査窓(prompt 直上のみ。scrollback 混入による誤爆を抑える)。
const ACTION_LABEL_WINDOW = 200
// glued 判定: ツール行の直後が(空白を除き)ボックス上端の罫線で始まるか。出力行を挟むと
// 不成立 = scrollback の古い ●Tool が AUQ を承認に化けさせる経路を断つ。
const TOOL_GLUE_BORDER_RE = new RegExp(`^\\s*[${BOX_CHARS}]`)

// 文字集合のいずれかの文字の最終出現 index(全て不在なら -1)。
// 旧 Math.max(s.lastIndexOf(a), s.lastIndexOf(b), ..., -1) と等価。
function lastIndexOfAnyChar(s, chars) {
  let idx = -1
  for (const ch of chars) {
    const at = s.lastIndexOf(ch)
    if (at > idx) idx = at
  }
  return idx
}

// prompt 類似度: 文字落ち（"Do you want to create" → "Do you want t creat"）に
// 耐性を持たせるため、正規化後に subsequence 一致率で判定する。
// 日本語(ひらがな/カタカナ/漢字)も比較対象にするため、空白・罫線・制御文字のみ
// 除去する。旧実装は /[^a-z0-9]/ で日本語を全削除しており、日本語 prompt が
// 常に空文字列になって promptSimilar が機能不全(常に false 返却)だった。
function normalizePrompt(s) {
  return s
    .toLowerCase()
    .replace(PROMPT_NORMALIZE_STRIP_RE, '')
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

// 行頭の数字 1-9 を option 番号マーカーとして歩き、{sortedMarks, options} を返す。
// parseDialog から切り出した補助関数(肥大化した parseDialog の見通し改善)。
// optionSegment = 「?」より後ろの領域。挙動は従来 parseDialog のインライン実装と同一。
function extractOptions(optionSegment) {
  function isStrictMarkerStart(i) {
    if (i === 0) return true
    const prev = optionSegment[i - 1]
    if (CURSOR_CHARS.includes(prev)) return true
    if (LINE_START_CHARS.includes(prev)) return true
    if (/\s/.test(prev)) {
      for (let j = i - 2; j >= 0; j--) {
        const c = optionSegment[j]
        if (CURSOR_CHARS.includes(c) || LINE_START_CHARS.includes(c)) return true
        if (!/\s/.test(c)) return false
      }
      return true
    }
    return false
  }
  const found = new Map()
  // 同一番号が strict マーカーとして 2 回以上出現 = 重畳/部分再描画フレーム(旧フレームの
  // "1.2.3." に新フレームの "1.2.3." が重なる等)。連番ガードは dedupe 後の集合を見るため
  // これを握り潰すと連番ガードを擦り抜けるため、duplicate を立てて呼び出し側で fail-closed。
  let duplicate = false
  for (let i = 0; i < optionSegment.length; i++) {
    const ch = optionSegment[i]
    if (ch < '1' || ch > '9') continue
    const next = optionSegment[i + 1]
    if (next && next >= '0' && next <= '9') continue // 連桁(行番号など)は除外
    if (!isStrictMarkerStart(i)) continue
    if (found.has(ch)) {
      duplicate = true
      continue
    }
    found.set(ch, { at: i, end: i + 1 })
  }
  // フォールバック: 厳格 0 件なら旧 regex で再試行(後方互換性)
  if (found.size === 0) {
    const fallbackRe = /(?<![A-Za-z0-9])([1-9])(?![0-9])/g
    let mm
    while ((mm = fallbackRe.exec(optionSegment)) !== null) {
      if (!found.has(mm[1])) found.set(mm[1], { at: mm.index, end: mm.index + 1 })
    }
  }
  const sortedMarks = [...found.entries()]
    .map(([num, pos]) => ({ num: parseInt(num), at: pos.at, end: pos.end }))
    .sort((a, b) => a.at - b.at)
  // 最後の選択肢に紛れ込む TUI フッタヒントを末尾から除去する。
  // claude: "Enter to select" / "Tab/Arrow keys" / "Esc to cancel"
  // codex : "Press enter to confirm"(承認型フッタの前置き)/ 選択肢質問型の
  //         "enter to submit answer" / "tab to add notes" / "esc to interrupt"
  const TUI_TAIL_HINT_RE =
    /(?:Enter\s+to\s+select|Tab\s*\/\s*Arrow\s+keys|Esc\s+to\s+cancel|Press\s+enter\s+to\s+confirm|enter\s+to\s+submit\s+answer|tab\s+to\s+add\s+notes|esc\s+to\s+interrupt)[\s\S]*$/i
  const options = sortedMarks.map((mk, i) => {
    const nextAt = i + 1 < sortedMarks.length ? sortedMarks[i + 1].at : optionSegment.length
    return optionSegment
      .slice(mk.end, nextAt)
      .replace(CURSOR_G, '')
      .replace(/[\r\n]/g, ' ')
      .replace(BOX_CHARS_G, '')
      .replace(/^[.\s]+/, '')
      .replace(/\s+/g, ' ')
      .replace(TUI_TAIL_HINT_RE, '')
      .trim()
  })
  return { sortedMarks, options, duplicate }
}

// 全ダイアログ種別(ExitPlanMode / AUQ / ツール承認)対応: prompt が端末幅で hard-wrap
// (実改行込み)され複数行になる場合に、prompt 段落の開始位置(改行 index)を求める。
// startNl(? を含む行の直前の改行)から上方へ走査する。
// 連結を採用するのは「box 内部の構造境界」に当たったときのみ:
//   空行 / 罫線行(行全体が罫線文字+空白、短い区切り ╌╌╌╌ 等も含めて >= 3 文字)/
//   タブバー(☐✔□✓→)/ 選択肢(❯)。境界行自体は段落に含めない。
// 「tool/ターン境界」(● を含む行 = Claude の tool/message 行 / ツール承認ラベル)に当たった、
// または box 境界に当たらず先頭到達 / MAX_LINES 超過の場合は、prompt の box 上端が無い
// 断片フレーム = 連結を破棄して単一行(startNl)に倒す(過剰連結を防ぎ、hard-wrap した
// ●Tool 行の args 続き行〔Authorization 等〕が prompt に混入するのを構造的に断つ)。
function expandPromptStart(beforeQ, startNl) {
  const MAX_LINES = 5
  let lineStart = startNl
  for (let i = 0; i < MAX_LINES; i++) {
    const prevNl = beforeQ.lastIndexOf('\n', lineStart - 1)
    const line = beforeQ.slice(prevNl + 1, lineStart).trim()
    // tool/ターン境界(● 行 = Claude の tool/message 行 / ツール承認ラベル)を最優先で判定する。
    // box 上端より上にはみ出した = 連結破棄して単一行に倒す。box 境界文字(→/❯/罫線)を
    // 併せ持つ ●Tool 行(hard-wrap した args エコー等)でも turn 境界を優先する(順序が重要 =
    // 先に box 境界判定すると args 続き行が prompt に混入する)。
    if (line.includes(BULLET_CHAR) || ACTION_LABEL_RE.test(line)) return startNl
    const isRule = RULE_LINE_RE.test(line) && line.replace(/\s/g, '').length >= 3
    const isTabBar = TAB_BAR_RE.test(line)
    const isOption = CURSOR_ANY_RE.test(line)
    // v1.17.0 (Phase 3b): codex 質問ヘッダ "Question N/N (..)" も段落境界 = prompt 本文に
    // 含めない(claude は本行を出さないため claude 経路に影響なし)。
    const isCodexQHeader = CODEX_QUESTION_HEADER_RE.test(line)
    // box 内部境界 = ここまでを 1 段落として連結採用。
    if (line === '' || isRule || isTabBar || isOption || isCodexQHeader) return lineStart
    lineStart = prevNl
    if (prevNl < 0) return startNl // box 境界に当たらず先頭到達 = 連結破棄
  }
  return startNl // MAX_LINES 内に box 境界なし = 連結破棄
}

// opts.allowMultiCodex(既定 false): true のとき codex 複数質問(Question N/M, M>1)を null で
// 弾かず「現在表示中の 1 問」を返す。sweepCodexQuestions が各問を読むためだけに使う。既定経路
// (detectDialogSingle / waitTabStable の既定 等)は false のままで挙動完全不変(M>1 は従来どおり
// 検出せず PC に倒す)。
function parseDialog(buf, opts = {}) {
  // 1. 終端マーカーの最終出現を取得
  const endMatches = [...buf.matchAll(END_MARKER_RE_G)]
  if (endMatches.length === 0) return null
  const endIdx = endMatches[endMatches.length - 1].index

  // ExitPlanMode は終端マーカーが "shift+tab to approve"(Esc to cancel ではない)。
  // 終端マーカー種別で分類し、かつ prompt が端末幅で hard-wrap(実改行込み)されても
  // 複数行を 1 段落に連結するため、prompt 抽出より前に判定する。
  const endMarkerText = endMatches[endMatches.length - 1][0]
  const isExitPlanMode = EXIT_PLAN_END_RE.test(endMarkerText)

  // 2. ダイアログ候補領域 (末尾マーカーの直前)
  // END_MARKER の手前 DIALOG_SEGMENT_MAX 文字を候補とする。
  // ダイアログ自体は通常 ~300 文字程度だが、tool 行が画面上で
  // ボックスより少し上に描画されるケースに備えて広めに見る。
  const segStart = Math.max(0, endIdx - DIALOG_SEGMENT_MAX)
  const segment = buf.slice(segStart, endIdx)

  // 2b. v1.17.0 (Phase 3b): codex の複数質問フロー(Question N/M, M>1 = ←/→ で巡回するタブ式
  //   相当)は、単一質問として中途半端に注入すると先頭 1 問だけ答えて残りが PC に残る(実機で
  //   混乱を確認)。完全対応(全問 sweep + タブ登録 + submit all)は Phase 3d。それまでは検出せず
  //   (null)PC 側で処理させる(スマホで半端に答える事故を防ぐ)。codex 質問型 endMarker が
  //   立つ場合のみ判定するため claude / codex 承認には無影響。
  // v1.17.0 (Phase 3d): allowMultiCodex=true のときはこの抑止を外し、現在表示中の 1 問を返す
  // (sweepCodexQuestions が ←/→ 巡回で各問を読むため)。M>1 判定は isCodexMultiQuestion 前段
  // ゲートと同じ共有述語 hasMultiCodexQuestion を使う(あちらは detectDialog 用の前段検出、ここは
  // parseDialog 内の安全ガード)。保守的に「複数質問マーカーが見えたら出さない」= 半端回答事故防止。
  if (CODEX_QUESTION_END_RE.test(endMarkerText) && !opts.allowMultiCodex) {
    if (hasMultiCodexQuestion(segment)) return null
  }

  // 3. 偽陽性除外: アクティブカーソル `❯` + 数字 1〜9 が必須
  // AskUserQuestion 型は選択肢が 4 個以上になることがあるため 1〜9 を許容。
  if (!CURSOR_NUM_RE.test(segment)) return null

  // 4. プロンプト抽出
  // 質問末尾は claude/codex 承認 = ASCII '?'、codex 選択肢質問 = 全角 '？'(U+FF1F)。両方探す。
  // v1.17.0 (Phase 3b): codex プランモードの選択肢質問は丁寧形(「…ください。」)で ? を
  // 持たないことがある。質問型 endMarker(enter to submit answer)が立つ場合のみ、最初の
  // 選択肢の直前を prompt 末尾アンカーに代用する。claude / codex 承認は本フォールバックに
  // 入らない(? がある限り従来の ? アンカー不変)。
  let qIdx = Math.max(segment.lastIndexOf('?'), segment.lastIndexOf('？'))
  if (qIdx < 0 && CODEX_QUESTION_END_RE.test(endMarkerText)) {
    qIdx = codexQuestionPromptEnd(segment)
  }
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
      arrowIdx = lastIndexOfAnyChar(beforeQ, TAB_MARK_CHARS + TAB_ARROW_CHAR)
    }
  }
  // 行頭アンカーの優先順: 改行 > タブバー右端(arrowIdx) > ボックス文字
  const boxCharIdx = lastIndexOfAnyChar(beforeQ, PROMPT_BOX_ANCHOR_CHARS)
  const fallbackIdx = arrowIdx >= 0 ? arrowIdx : boxCharIdx
  const lineStart = nlIdx >= 0 ? nlIdx : fallbackIdx
  // hard-wrap で複数行になった prompt を 1 段落に連結する(全種別: ExitPlanMode / AUQ / ツール承認)。
  // 構造境界(罫線 / タブバー / ❯ / ラベル)で停止するため、prompt 1 行のみのときは即停止 = 不変。
  // タブ式(nlIdx < 0)は連結対象外(fallback アンカーのまま)。
  // promptStart は prompt 抽出と tool 継承の beforeDialog 切り出し(下記 6b)で共用し、整合させる。
  const promptStart = nlIdx >= 0 ? expandPromptStart(beforeQ, nlIdx) : lineStart
  const prompt = segment
    .slice(promptStart + 1, qIdx + 1)
    .replace(BOX_OR_NEWLINE_G, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!prompt) return null

  // 5. オプション抽出(共有関数 extractOptions に委譲)。抽出処理自体は従来のインライン実装と
  //    同一(厳格行頭マーカー walk + 旧 regex フォールバック + tail hint 除去)。ただし
  //    parseDialog 全体の受理条件は下記 5b で追加検証する(従来より厳格 = 安全側)。
  const optionSegment = segment.slice(qIdx + 1)
  const { sortedMarks, options, duplicate } = extractOptions(optionSegment)
  if (sortedMarks.length === 0) return null
  if (options.length === 0 || options.every((o) => !o)) return null

  // 5b. 内容完全性ガード(安全側 fail): 部分描画 / 重畳フレームを null で弾く(転送しない、
  //   次フレームを待つ)。Claude Code v2.1.x の Agent View + スピナーが毎フレーム再描画し、
  //   ダイアログが断片的にしか描画されない瞬間がある。
  //   (i) duplicate: 同一番号が 2 回以上 = 旧フレームに新フレームが重なった重畳。
  //   (ii) 番号が 1..N の完全集合でない: 途中(例 "2. 青")や先頭("1. 赤")の欠落 = 隣接
  //        option への説明文融合 / 選択肢消失のシグナル。
  //   どちらかに該当すれば承認対象の取り違え(融合・消失・混在した選択肢の転送)を防ぐため棄却。
  //   1-9 の相異なる整数で max===個数 ⟺ ちょうど {1..N}(先頭 1 始まりも同時に要求)。
  if (duplicate) return null
  const optNums = sortedMarks.map((mk) => mk.num)
  const completeFromOne =
    new Set(optNums).size === optNums.length && Math.max(...optNums) === optNums.length
  if (!completeFromOne) return null

  // 6. ツール判定。AUQ を「ツール承認シグナルがどれも立たない」と定義する合成判定(W002)。
  //   AskUserQuestion は専用の ●AskUserQuestion() 行を持たず、上方スクロールバックに前ターンの
  //   ●Bash() 等が残る。先に ●Tool() を継承すると誤ツール名(例「Bash uname -a」)を AUQ に
  //   転送してしまう(実機で観測)。一方、prompt 文言("Do you want to")単独依存は Claude Code の
  //   UI 文言変更に脆く、ツール承認を AUQ と誤分類 → args(危険コマンド)がスマホ側で空欄=承認
  //   内容の秘匿の恐れ。よって以下を OR で合成し、どれかが立てばツール承認に
  //   倒す(各シグナルは AUQ から外す方向のみ = 安全側):
  //     - hasShiftTab       : option 領域に shift+tab ヒント
  //     - promptIsApproval  : 既知定型句 "Do you want to"(弱シグナル。多層防御として残す)
  //     - hasGluedToolLine  : ●Tool 行とこのダイアログの間に別の生 ● が無い(直前注釈=同フレーム)
  //     - hasActionLabel    : ●Tool 行未描画でも box 直上の multi-word ラベルで承認に倒す
  //   ※ box 描画文字(│╭╮╰╯─╌❯☐✔→)に ● は含まれないため、区間内の生 ● は Claude の
  //     tool/message 行に限る = ターン境界の指標(glued 判定の前提)。
  const promptAbsStart = segStart + promptStart + 1
  const beforeDialog = buf.slice(0, promptAbsStart)
  const toolMatches = [...beforeDialog.matchAll(TOOL_LINE_RE)]
  const lastTool = toolMatches[toolMatches.length - 1]

  const hasShiftTab = /shift\s*\+\s*tab/i.test(optionSegment)
  const promptIsApproval = APPROVAL_PHRASE_RE.test(prompt)
  let hasGluedToolLine = false
  if (lastTool) {
    const toolEnd = lastTool.index + lastTool[0].length
    const between = buf.slice(toolEnd, promptAbsStart)
    // glued = (a) ツール行とこのダイアログの間に別の生 ● が無い(ターン境界なし)かつ
    //   (b) ツール行の直後が空白を除いてボックス上端の罫線で始まる(出力行を挟まず box に密着)。
    //   (b) を欠くと scrollback の古い ●Tool が出力行越しに継承され AUQ を承認に化けさせる。
    hasGluedToolLine = !between.includes(BULLET_CHAR) && TOOL_GLUE_BORDER_RE.test(between)
  }
  const hasActionLabel = ACTION_LABEL_RE.test(beforeQ.slice(-ACTION_LABEL_WINDOW))
  const looksLikeAUQ =
    !hasShiftTab && !promptIsApproval && !hasGluedToolLine && !hasActionLabel

  // 終端マーカー種別を最優先(ExitPlanMode は optionSegment に shift+tab が残らず、prompt も
  // "Do you want to" 非含のため、合成判定だけだと AUQ と誤判定される。args は持たない)。
  let tool = 'Unknown'
  let args = ''
  if (isExitPlanMode) {
    tool = 'ExitPlanMode'
  } else if (IS_CODEX && isCodexCommandApprovalOptions(options)) {
    // v1.17.0 (Phase 3b / TODO 3): codex コマンド承認は合成判定だと looksLikeAUQ に倒れ
    // AskUserQuestion と誤表示される(prompt "Would you like to run" を APPROVAL_PHRASE_RE が
    // 拾わないため)。全 option がショートカットを持つ = コマンド承認として Bash ラベル + コマンド
    // 本文で表示する(注入経路は別途 option ラベルのショートカット抽出で振り分けるため不変)。
    tool = 'Bash'
    args = extractCodexCommand(segment, qIdx)
    // 表示側 fail-safe(#Z 秘匿側): コマンド本文を確証できない(断片フレームで `$` 行が未描画 等)
    // なら、コマンド空欄のブラインド承認になるため承認可能化しない。null を返し次の完全フレームで
    // 再検出させる(injection 側の reRegisterUninjectableDialog と対称の保守的挙動)。5b 完全性
    // ガードが options のみ検証し `$` 行を見ないため、ここで補う。
    if (!args) return null
  } else if (looksLikeAUQ) {
    tool = 'AskUserQuestion'
  } else {
    // 6b. ツール承認: プロンプトより前にある最新の `● Tool(args)`(hoist 済 lastTool)を採用。
    if (lastTool) {
      tool = lastTool[1]
      args = lastTool[2].replace(/[\r\n]/g, ' ').replace(/\s+/g, ' ').trim()
    }
    // 6c. `● Tool()` 行が未描画の初回フレーム fallback: ボックス内アクションラベルから推測。
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
          const m = boxText.match(LABEL_ARGS_RE)
          if (m && !args) args = m[1].replace(/\s+/g, ' ').trim()
          break
        }
      }
    }
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
  const boxMarks = (buf.match(TAB_MARK_G) || []).length
  const hasNav = TAB_NAV_RE.test(buf)
  return boxMarks >= 2 && hasNav
}

// v1.12.0 (D1): approval-server.js / approval-ui.html の同名定数と完全同期。
// Defense in depth として wrapper 側にも持つ(サーバ防御を信頼しすぎず、
// 注入直前の最後の関門で再検証)。
const FREE_TEXT_OPTION_RE = /^Type\s+something\.?$/i
const CHAT_ABOUT_RE = /^Chat\s+about\s+this\.?$/i

// v1.16.0 (Phase 3a): codex のコマンド承認 option ラベル末尾に内包されるショートカット
// 文字を抽出する純関数。codex の承認 TUI は claude と異なり「番号 + Enter」型でなく
// カーソル(›)+ Enter / ショートカットキー(y/p/esc)型のため、番号を送ると末尾 Enter が
// 既定 option1(承認)を誤確定する(拒否のはずが承認 = failure #Z 同型)。これを避け、
// ラベル `Yes, proceed (y)` / `...(p)` / `No, ... (esc)` の末尾括弧からキーを取り出す。
//   入力例: "Yes, proceed (y)" → { kind: 'char', char: 'y' }
//           "No, and tell Codex... (esc)" → { kind: 'esc' }
//           "春 (Recommended)" / 括弧なし → null(= 安全側。注入しない判断に倒す)
// 末尾アンカー (\s*$) なのでラベル本文中の括弧は無視し、末尾の 1 個だけを見る。
// esc は特例、それ以外は単一英数字(y/p/1 等)のみ受理。複数文字や記号は null。
function extractCodexShortcut(optionLabel) {
  const m = String(optionLabel).match(/\(([^)]+)\)\s*$/)
  if (!m) return null
  const tok = m[1].trim().toLowerCase()
  if (tok === 'esc') return { kind: 'esc' }
  if (/^[a-z0-9]$/.test(tok)) return { kind: 'char', char: tok }
  return null
}

// v1.16.0 (Phase 3a): 抽出したショートカットを実際に PTY へ書き込むバイト列へ変換する純関数。
// esc → ESC(\x1b)、char → その文字そのもの。**末尾 \r は付けない**(char 自体が確定
// ショートカットのため。E2E で「Enter 必須」が判明したときに限り char にだけ \r を足す)。
// 抽出失敗(null)時は null を返し、呼び出し側は番号 + Enter にフォールバックせず注入を
// 行わない(reRegister に倒す)= #Z 再発防止の中核。
function resolveCodexInjection(optionLabel) {
  const sc = extractCodexShortcut(optionLabel)
  if (!sc) return null
  if (sc.kind === 'esc') return { bytes: '\x1b' }
  return { bytes: sc.char }
}

// v1.17.0 (Phase 3b / TODO 3): codex の「コマンド承認」を「選択肢質問(AskUserQuestion)」と
// 区別する純関数。コマンド承認の option は必ず全件が末尾ショートカット (y)/(p)/(esc) を持つ
// (`Yes, proceed (y)` / `...(p)` / `No, ... (esc)`)。一方プランモードの選択肢質問は
// `春 (Recommended)` / `None of the above ... (tab)` のように末尾が複数文字 = extractCodexShortcut
// が null。よって「全 option がショートカットを持つ」をコマンド承認の十分条件にできる。
// これで従来コマンド承認が AskUserQuestion と誤分類されスマホに args 空で表示された問題を是正する。
function isCodexCommandApprovalOptions(options) {
  return (
    Array.isArray(options) &&
    options.length >= 2 &&
    options.every((o) => extractCodexShortcut(o) !== null)
  )
}

// 選択肢行(行頭の任意カーソル + 数字 1-9 + 区切り . / ))の最初の出現。カーソル文字集合は
// 他の派生 RegExp(CURSOR_NUM_RE 等)と同様に CURSOR_CHARS から生成し drift を避ける
// (新 CLI のカーソルを CURSOR_CHARS に足せば本 RegExp も自動追従)。
const CODEX_OPTION_LINE_RE = new RegExp(`(?:^|\\n)[ \\t]*[${CURSOR_CHARS}]?[ \\t]*[1-9][.)]`)

// v1.17.0 (Phase 3b): codex プランモードの選択肢質問は丁寧形(「…ください。」等)で末尾に
// ? / ？ を持たないことがある(実機確認: codex 0.142.x)。その場合の prompt/option 境界
// アンカーとして「最初の選択肢行の直前にある最後の非空白文字」の index を返す純関数(= ? の
// 代替。? がある claude/codex 承認は本関数を使わず従来の ? アンカー不変)。選択肢行が無い /
// 手前に非空白が無ければ -1。
function codexQuestionPromptEnd(segment) {
  const m = String(segment).match(CODEX_OPTION_LINE_RE)
  if (!m) return -1
  let i = m.index - 1
  while (i >= 0 && /\s/.test(segment[i])) i--
  return i
}

// codex コマンド承認のコマンド本文を `$ ...` 行から抽出する純関数(**スマホ表示専用 = display only,
// never execute**。注入は番号→ショートカット経路で、本文字列は実行に使わない)。
// codex は "Would you like to run the following command?"(= prompt, qIdx)の直後に `$ <command>` を
// 描画し、その下に選択肢が続く。**現ダイアログ領域(prompt 直後 〜 最初の選択肢の手前)に限定**して
// 抽出する: segment 全体の先頭 `$` を拾うと画面上方に残る別(実行済み)コマンドを誤って拾い、
// 表示と実際の承認内容が食い違う(#Z 取り違え)。確証できなければ空文字(呼び出し側が承認可能化を
// 抑止 = #Z 秘匿側の fail-safe)。
function extractCodexCommand(segment, qIdx) {
  const s = String(segment)
  const after = s.slice((qIdx | 0) + 1)
  // 最初の選択肢行の手前までに範囲を絞る(コマンドは prompt と選択肢の間にある)。
  const optM = after.match(CODEX_OPTION_LINE_RE)
  const region = optM ? after.slice(0, optM.index) : after
  const m = region.match(/^\s*\$\s+(.+)$/m)
  // 内部の連続空白を 1 個に畳み、行末の余白を除去(罫線描画由来の trailing space 対策)。
  return m ? m[1].replace(/\s+/g, ' ').trim() : ''
}

// v1.17.0 (Phase 3d): 画面が codex の複数質問フロー(Question N/M, M>1)かを判定する純関数
// (detectDialog の前段ゲート)。最終 endMarker が codex 質問型(enter to submit answer)で、
// かつ現ダイアログ領域(末尾マーカー手前 DIALOG_SEGMENT_MAX)に分母 M>1 の "Question N/M" が
// あれば true。M>1 判定は parseDialog の抑止ガード(:734)と共有述語 hasMultiCodexQuestion を
// 共用する(IS_CODEX 判定は呼び出し側 detectDialog が行う = 本関数は CLI 種別非依存の純関数)。
function isCodexMultiQuestion(buf) {
  const s = String(buf)
  // 早期ガード: codex 質問型マーカーが画面のどこにも無ければ即 false。毎フレーム + 400ms tick で
  // 走る detectDialog ホットパスで、全 endMarker の matchAll spread を idle/claude 風画面で回避する
  // (test() は最初の一致で停止)。マーカーが在れば下で last マッチの種別を厳密判定する。
  if (!CODEX_QUESTION_END_RE.test(s)) return false
  const endMatches = [...s.matchAll(END_MARKER_RE_G)]
  if (endMatches.length === 0) return false
  const last = endMatches[endMatches.length - 1]
  if (!CODEX_QUESTION_END_RE.test(last[0])) return false
  const segStart = Math.max(0, last.index - DIALOG_SEGMENT_MAX)
  const segment = s.slice(segStart, last.index)
  return hasMultiCodexQuestion(segment)
}

// v1.17.0 (Phase 3d): 画面に見えている最新(最後)の "Question N/M" の N と M を返す純関数。
// sweep で Q1 へ戻す回数 (N-1) と巡回の loop bound(M)に使う。見つからなければ null。最後の
// マッチを採るのは、画面上方に stale な旧ヘッダが残っても最下=現在の問を優先するため。
function codexQuestionPos(screen) {
  const ms = [...String(screen).matchAll(CODEX_QUESTION_POS_RE_G)]
  if (ms.length === 0) return null
  const last = ms[ms.length - 1]
  return { n: parseInt(last[1], 10), m: parseInt(last[2], 10) }
}

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
    extractOptions,
    composeEndMarkerPattern,
    isLostRegistration,
    extractCodexShortcut,
    resolveCodexInjection,
    isCodexCommand,
    isCodexCommandApprovalOptions,
    extractCodexCommand,
    isCodexMultiQuestion,
    codexQuestionPos,
    codexMultiKeySequence,
    // 境界文字定数(test-parse-dialog.js [22] の membership 固定用)
    BOX_CHARS,
    RULE_CHARS,
    PROMPT_BOX_ANCHOR_CHARS,
    TAB_MARK_CHARS,
    TAB_ARROW_CHAR,
    CURSOR_CHAR,
    CURSOR_CHARS,
    LINE_START_CHARS,
    TAB_NAV_RE,
    EXIT_PLAN_END_PATTERN,
    DEFAULT_END_MARKER,
    CODEX_QUESTION_END_PATTERN,
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
  previousOptionsLen = -1,
  parseOpts = {}
) {
  const t0 = Date.now()
  let prev = null
  let stableCount = 0
  let nullCount = 0
  while (Date.now() - t0 < timeoutMs) {
    await sleep(80)
    const d = parseDialog(getScreenText(), parseOpts)
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

// v1.17.0 (Phase 3d): ← (左矢印) を n 回送って codex の質問を前方(Q1 方向)へ戻す。各送出後に
// TUI 再描画を待つ sleep を挟む。sweep の前半(現在位置→Q1)と後半(巡回後→Q1 復帰)で共用。
async function pressLeftArrow(n) {
  for (let i = 0; i < n; i++) {
    term.write('\x1b[D') // ←
    await sleep(50)
  }
}

// v1.17.0 (Phase 3d): codex プランモードの複数質問(Question N/M, M>1)を巡回キャプチャする。
// sweepTabs の codex 版。claude は ☐✔ タブ式 UI を Tab/Shift+Tab で巡回するが、codex は 1 問ずつ
// 表示し ←/→ で問を移動する(実機確認: codex 0.142.x、フッタ "←/→ to navigate questions")。
// 各問は parseDialog(..., {allowMultiCodex:true}) で読む(既定の M>1 抑止を外す)。終了判定は
// claude の shape-match でなく分母 M を loop bound に使う(より堅牢)。巡回後は Q1 へ戻して
// 注入(replayCodexMultiAnswers が Q1 から番号を順送り)に備える。finally で sweep フラグ解除 +
// stdin flush(巡回中の PC 入力を取りこぼさない)。
async function sweepCodexQuestions() {
  tabSweepInProgress = true
  try {
    const parseOpts = { allowMultiCodex: true }
    // 現在位置を Q1 へ戻す。Q1 で ← を押したときラップするか止まるかは未確定なので、画面の現在 N
    // を読んで (N-1) 回だけ ← を送る(過剰送出でラップする事故を避ける保守的算出)。
    const startPos = codexQuestionPos(getScreenText())
    if (!startPos) return null
    await pressLeftArrow(startPos.n - 1)
    await waitTabStable(400, null, -1, parseOpts)

    const first = parseDialog(getScreenText(), parseOpts)
    if (!first) return null
    // 分母 M は巡回中不変なので rewind 前に読んだ startPos.m を流用(画面の再読取を避ける)。
    const total = startPos.m
    if (total < 2) return null // 単一は通常パスへフォールバック
    const tabs = [first]
    // → で残りの問を順に読む。上限 9(registerMultiDialog / validateMultiAnswer の tabs 上限)。
    for (let i = 1; i < total && i < 9; i++) {
      term.write('\x1b[C') // →
      const last = tabs[tabs.length - 1]
      const next = await waitTabStable(600, last.prompt, last.options.length, parseOpts)
      if (!next) break
      tabs.push(next)
    }
    // 巡回後は Q1 へ戻す(注入は Q1 から番号を順送りするため)。
    await pressLeftArrow(tabs.length - 1)
    // 全問(分母 M)を捕捉できなかった場合(waitTabStable が null で break / M>9 で 9 打ち切り)は
    // 半端登録を避けて null を返す → detectDialogSingle が parseDialog 既定(allowMultiCodex=false で
    // M>1 抑止)で PC 側に倒す。2≤tabs.length<M の半端帯で未回答の残り問に submit all の \r が入る
    // ブラインド承認(#Z 退行)を構造的に閉じる(3 段レビュー security/codex の収束指摘)。
    if (tabs.length !== total) return null
    return tabs
  } finally {
    tabSweepInProgress = false
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

// v1.17.0 (Phase 3d): codex 複数質問の注入キー列を組み立てる純関数(テスト seam)。#Z(承認取り
// 違え)防止の不変条件を単体で固定する = 中間問は番号のみ(Enter を一切挟まない)/ submit は最後に
// \r を 1 回だけ。中間で Enter を挟むと別問の既定 option を誤確定しうる(#Z)。answers は
// validateMultiAnswer 通過済の { num }(codex 質問型に Type something は無く a.text は不使用 = 番号
// のみ = 安全側)。戻り値 = ["1","2",...,"\r"]。replayCodexMultiAnswers がこの列を PTY に流す。
function codexMultiKeySequence(answers) {
  const keys = answers.map((a) => a.num)
  keys.push('\r') // enter to submit all(全問送信、最後に 1 回だけ)
  return keys
}

// v1.17.0 (Phase 3d): codexMultiKeySequence のキー列を PTY に再生する(replayMultiAnswers の codex 版)。
// 実機 E2E verified(codex 0.142.x, 案A): ある問で番号キーを押すと選択確定 + 自動で次問へ遷移(claude
// タブ式と同じ)。全問回答が揃うとフッタが "enter to submit all" になり \r で全送信(claude の
// "数字列 → 1\r" と同型、codex は \r 単独)。3 問バッチで 番号列 [1,3,2] → \r が全問確定・誤確定なしを
// 実機確認。#Z 不変条件(中間 Enter なし / submit 1 回)は codexMultiKeySequence が純粋化・テスト固定。
async function replayCodexMultiAnswers(answers) {
  tabReplayInProgress = true
  try {
    // 各問送出後に次問描画を待ち、submit \r の前にまとめ待ちを入れて流す(タイミングは従来と同一)。
    const keys = codexMultiKeySequence(answers)
    const submitIdx = keys.length - 1
    for (let i = 0; i < keys.length; i++) {
      if (i === submitIdx) await sleep(MULTI_SUBMIT_WAIT_MS) // submit 直前のまとめ待ち
      term.write(keys[i]) // 中間 = 番号(codex が自動で次問へ)/ 末尾 = \r(submit all)
      if (i < submitIdx) await sleep(MULTI_TAB_STEP_MS) // 各問送出後の次問描画待ち
    }
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

// v1.17.0 (Phase 3d): 登録済みの codex 複数質問が画面に出続けている「生存中」状態の述語。
// detectDialog の生存短絡(dismissal タイマー武装阻止)と onDialogDismissed の発火時 veto が共有し、
// 逐語重複による drift を防ぐ(hasMultiCodexQuestion を共有述語にしたのと同じ思想)。currentDialog /
// IS_CODEX のモジュール状態に依存するため純関数でない点に注意。
function isLiveCodexMulti(screen) {
  return !!(currentDialog && currentDialog.tabs && IS_CODEX && isCodexMultiQuestion(screen))
}

async function detectDialog() {
  // タブ巡回 / 再生中は通常検出をスキップ(dedup・誤登録を回避)
  if (tabSweepInProgress || tabReplayInProgress) return

  // 画面バッファのテキストを 1 回取得し、detectDialogSingle にも引数で渡す
  // (同一 onPtyData 内での二度取りを避ける)
  const screen = getScreenText()

  // v1.17.0 (Phase 3d): 登録済みの codex 複数質問(currentDialog.tabs)が画面に出続けている間は
  // 「生存」とみなす。codex multi は parseDialog 既定が M>1 抑止で null を返すため detectDialogSingle
  // の生存パス(lastSeenAt 更新)に乗れず、dismissal タイマー → onDialogDismissed が resolve-by-cli →
  // 再 sweep + 再登録の無限ループ(id が ~3 秒ごとに入れ替わりスマホは 409「他端末で処理済」)に陥る。
  // ここで dismissal を止め lastSeenAt を更新して再 sweep させない。claude(IS_CODEX=false)/ codex
  // 単一質問(tabs なし)は不該当で完全不変。回答注入は tabReplayInProgress ガードで別管理。
  if (isLiveCodexMulti(screen)) {
    clearTimeout(dismissalTimer)
    dismissalTimer = null
    currentDialog.lastSeenAt = Date.now()
    return
  }

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

  // v1.17.0 (Phase 3d): codex の複数質問(Question N/M, M>1)は claude の ☐✔ タブ式 UI を
  // 持たないため isTabbedDialog では拾えない。専用ゲート isCodexMultiQuestion で検出し、
  // sweepCodexQuestions で ←/→ 巡回 → registerMultiDialog(tool 非依存で流用)。拾えなければ
  // 素通り → detectDialogSingle。そこでは parseDialog 既定(allowMultiCodex=false)が M>1 を
  // null にするため、半端な単一注入は起きず PC 側に残る(安全側フォールバック)。
  if (!currentDialog && IS_CODEX && isCodexMultiQuestion(screen)) {
    const tabs = await sweepCodexQuestions()
    if (tabs && tabs.length >= 2) {
      await registerMultiDialog(tabs, PROJECT_NAME)
      return
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

// サーバー応答エラーが「登録喪失」(= サーバーがこの id を失った, 主に再起動/クラッシュで
// メモリキューが揮発したケース)を表すかの純判定。404 かつ、現在追跡中のダイアログが
// まさにこの id のときだけ真 = 別ダイアログに切り替わった後の遅延 404 で誤再登録しない。
function isLostRegistration(err, dialog, id) {
  return !!(err && err.statusCode === 404 && dialog && dialog.id === id)
}

// v1.15.6: server-resolved な応答を wrapper が注入できない場合の永続オーファン対策。
// 単一質問の answer がこの currentDialog.options に一致しない(= サーバー側と wrapper
// 側で別々の parse 瞬間に凍結した options スナップショットが食い違う等)とき、サーバーは
// 既に当該 id を resolved 化しキューから除外している(スマホ不可視)一方、PC にはダイアログ
// が残るため、何もしなければ恒久オーファンになる(404 経路 isLostRegistration と同型の症状
// だがトリガが異なる)。まだ画面に出ている現ダイアログを再登録して新しい id を採番し直し、
// スマホへ再提示できるようにする。ただし不正 answer が繰り返されると無限ループになるため、
// 再登録回数を MAX_ORPHAN_REREGISTER で制限し、超過時は再登録せず現状(PC 残存)のまま
// 放置する(= 従来動作にフォールバック)。本 helper は単一質問経路からのみ呼ばれる
// (複合質問は番号送信で不一致が起きないため)。
const MAX_ORPHAN_REREGISTER = 2
async function reRegisterUninjectableDialog(id, reason) {
  if (!currentDialog || currentDialog.id !== id) return
  const prevCount = currentDialog.reRegisterCount || 0
  if (prevCount >= MAX_ORPHAN_REREGISTER) {
    wlog(`uninjectable dialog id=${id} (${reason}); 再登録上限到達につき放置`)
    return
  }
  const d = currentDialog
  d.reRegisterCount = prevCount + 1 // registerDialog の {...d} 経由で新スロットへ引継ぐ
  currentDialog = null // register 系が自前でスロット予約するため一旦解放する
  wlog(`uninjectable dialog id=${id} (${reason}); 再登録 (#${prevCount + 1})`)
  if (Array.isArray(d.tabs)) {
    await registerMultiDialog(d.tabs, PROJECT_NAME)
  } else {
    await registerDialog(d)
  }
}

async function pollForResponse(id) {
  while (currentDialog && currentDialog.id === id) {
    let resp
    try {
      resp = await httpRequest('GET', `/status/${id}?wait=60`, null, 70000)
    } catch (e) {
      // サーバーが当該 id を失った(プロセス再起動・クラッシュでメモリキューが揮発した等)
      // 場合は 404 が返る。同じ死んだ id を回し続けても依頼はスマホへ二度と出ないため、
      // まだ画面に出ている現ダイアログを即時に再登録して新しい id を採番し直す。
      // これがオーファン化(PC にダイアログ残存・サーバー queue 空・スマホ不可視)の解消点。
      if (isLostRegistration(e, currentDialog, id)) {
        const d = currentDialog
        currentDialog = null // register 系が自前でスロット予約するため一旦解放する
        wlog(`status 404 (server lost id=${id}); re-registering dialog`)
        // tabs の有無 = 複合スナップショットか否かの不変条件で振り分ける。
        // 複合 currentDialog は registerMultiDialog 経由(tabs.length>=2 保証)でのみ作られ
        // args を持たない一方、単一 currentDialog は args を持ち tabs を持たない。
        // よって length>=2 でなく Array.isArray で判定する(length 条件に変えると複合を
        // registerDialog へ誤送し d.args 参照でクラッシュする)。
        if (Array.isArray(d.tabs)) {
          await registerMultiDialog(d.tabs, PROJECT_NAME)
        } else {
          await registerDialog(d)
        }
        // 再登録側が新しい pollForResponse を起動する(or POST 失敗時は currentDialog を
        // null に戻し、400ms 定期検出が同頻度でリトライする)。本ループはここで終了。
        return
      }
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
        // v1.17.0 (Phase 3d): codex は注入キーが claude と異なる(番号で自動次問 + \r で submit all)
        // ため IS_CODEX で振り分ける。claude(IS_CODEX=false)は従来経路で完全不変。
        if (IS_CODEX) await replayCodexMultiAnswers(validated)
        else await replayMultiAnswers(validated)
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
      // v1.15.6: サーバーは resolved 済(スマホ不可視)だが wrapper は注入不能。
      // 永続オーファンを避けるため現ダイアログを再登録してスマホへ再提示する。
      await reRegisterUninjectableDialog(id, 'answer 不一致')
      return
    }

    // D1 (codex B003 修正 defense in depth): key が指す option が Chat about this なら注入拒否
    const selectedOpt = currentDialog.options[parseInt(key, 10) - 1]
    if (CHAT_ABOUT_RE.test(selectedOpt)) {
      wlog(`answer points to "Chat about this" which is not remote-controllable. 注入スキップ。`)
      return
    }

    // v1.17.0 (Phase 3b): codex は注入方式が claude と全く異なるため、claude 用の経路
    // (フリーテキスト / 数字 + Enter)より前に最前段で分岐する。IS_CODEX=false の claude では
    // 本ブロックに入らず以降の既存経路が完全不変。振り分けキー = 選択された option ラベルの
    // ショートカット抽出可否(コマンド承認の option は必ず (y/p/esc) を持ち、質問型は持たない)。
    // 判定順は安全性のため固定(① → ② → ③):
    //   ① ショートカット抽出可 → コマンド承認(ショートカットキーのみ、Enter 不送出 = #Z 回避)
    //   ② resp.text あり      → 質問型の自由記入(選択 → Tab → テキスト → Enter)
    //   ③ それ以外(番号選択肢) → 質問型(番号 → Enter)
    // 注: 分類は parseDialog(全 option がショートカット ⟺ Bash)が既に出しているが、注入側は
    //   それに依存せず「選択 option のショートカット抽出可否」で独立に再判定する(defense in depth)。
    //   分類が万一誤ってもコマンド承認(ショートカット持ち)を番号+Enter 経路に落とさないため = #Z
    //   再発防止の核。tool ラベル駆動に寄せると分類ミス時に承認が番号+Enter で誤確定しうる。
    if (IS_CODEX) {
      // ① コマンド承認(選択 option がショートカットを持つ)を最優先で判定。text が添付されて
      //    いてもショートカット専用経路に倒す(Enter 不送出)。これより前に text 経路を置くと、
      //    クライアントが {answer, text} を投げてコマンド承認を番号+Enter 経路に落とし末尾 Enter で
      //    既定 option1(承認)を誤確定させうる(#Z 同型・API 直叩き迂回)。codex コマンドに
      //    notes は無いので text は無視するのが正(server 側も Type something 限定で text を 400)。
      if (resolveCodexInjection(selectedOpt)) {
        await replayCodexApproval(key, currentDialog.options, id)
        return
      }
      // ② 質問型の自由記入(Tab notes)。①を通過した = 選択 option はショートカットを持たない
      //    質問型のみ。text 健全性を再検証(defense in depth)。
      //    Phase 3c 予定: 現状 server の D1 ゲートで codex 質問型の text は 400 = 本分岐は未到達。
      //    UI + server 緩和後に活きる(defense in depth として今は安全側に置いておく)。
      if (resp.text != null) {
        const safeText = validateFreeText(resp.text)
        if (!safeText) {
          // W001: 入力内容そのものはログに出さない(自由記入に機密が入りうる)。型/長さのみ記録。
          wlog(
            `codex notes text rejected (type=${typeof resp.text}, len=${
              typeof resp.text === 'string' ? resp.text.length : 'n/a'
            })。注入スキップ。`
          )
          return
        }
        await replayCodexQuestion(key, safeText, id)
        return
      }
      // ③ 質問型の通常選択(番号 → Enter)。
      await replayCodexQuestion(key, null, id)
      return
    }

    // v1.12.0: スマホからフリーテキストが添付されている場合の経路(claude)。
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

// v1.16.0 (Phase 3a): codex のコマンド承認(Yes/proceed・don't-ask・No の 3 択)を注入する。
// key(番号 "1"〜"9")を option ラベルへ写し、末尾括弧のショートカット(y/p/esc)を抽出して
// そのキーだけを送る(番号 + Enter は送らない = 既定 option 誤確定を構造的に回避)。
// 抽出失敗時(option 構成が想定外でショートカットを取れない等)は注入せず、現ダイアログを
// 再登録(reRegisterUninjectableDialog、404 経路と対称)してスマホ/PC の手動処理に倒す。
// fail-safe = 承認にも拒否にも勝手に倒さない。これが failure #Z(承認取り違え)再発防止の核。
async function replayCodexApproval(key, options, id) {
  const inj = resolveCodexInjection(options[parseInt(key, 10) - 1])
  if (!inj) {
    wlog(`codex shortcut 抽出失敗(key="${key}")。注入スキップ + 再登録。`)
    await reRegisterUninjectableDialog(id, 'codex shortcut 不明')
    return
  }
  tabReplayInProgress = true
  try {
    term.write(inj.bytes)
    // v1.11.2: 回答済みダイアログを次フレーム描画まで再検出しないよう論理抑制
    if (currentDialog) suppressCurrentDialog(currentDialog.prompt)
    wlog(`injected codex shortcut for key="${key}" dialog ${id}`)
  } finally {
    tabReplayInProgress = false
    flushStdinBuffer()
  }
}

// v1.17.0 (Phase 3b): codex プランモードの選択肢質問(= AskUserQuestion 相当)を注入する。
// コマンド承認(replayCodexApproval)と違い、option ラベルにショートカット文字が無いため、
// 番号で選択肢へ移動 → Enter で確定(フッタ "enter to submit answer")する。
// text 付き(自由記入 = Tab notes)は codex 仕様で「選択 → Tab で notes 欄を開く → テキスト →
// Enter」(フッタ "tab to add notes")。claude の replayFreeText とは Tab の有無/順序が異なる。
// 注 1: text 経路は Phase 3c へ分離(現状 server の D1 ゲート〔approval-server.js: text は
//   "Type something" option 限定〕が codex 質問型 option の text を 400 で拒否するため未到達。
//   3c で UI + server(codex 質問型への安全な text 許可)+ 本経路を一体で出す)。本実装は
//   defense in depth として残し、ゲート緩和後に即活きる形にしておく。
// 注 2: 番号キーが「移動」か「即選択確定」か、Enter 要否、Tab notes の順序/待ちは E2E(U1-U3)で
//   確定する unknown。確定するまでは安全側既定(番号 → Enter)で出す。誤確定の主リスクは
//   コマンド承認側(#Z)で、質問型は最悪でも誤った選択肢/notes の送信に留まる(承認取り違えでない)。
async function replayCodexQuestion(key, text, id) {
  tabReplayInProgress = true
  try {
    term.write(key) // 番号で選択肢へ
    if (text != null) {
      // 自由記入: Tab で notes 欄を開いてから 1 文字ずつ注入(replayFreeText と同ペース)
      await sleep(MODE_TRANSITION_MS)
      term.write('\t')
      await sleep(MODE_TRANSITION_MS)
      let j = 0
      for (const ch of text) {
        term.write(ch)
        await sleep(j < CHAR_INJECT_WARMUP ? CHAR_INJECT_MS_SLOW : CHAR_INJECT_MS_FAST)
        j++
      }
    }
    await sleep(MULTI_SUBMIT_WAIT_MS)
    term.write('\r') // enter to submit answer
    // v1.11.2: 回答済みダイアログを次フレーム描画まで再検出しないよう論理抑制
    if (currentDialog) suppressCurrentDialog(currentDialog.prompt)
    wlog(
      `injected codex question (key="${key}"${
        text != null ? `, notes len=${text.length}` : ''
      }) for dialog ${id}`
    )
  } finally {
    tabReplayInProgress = false
    flushStdinBuffer()
  }
}

// ダイアログが画面から消えた（= β 応答があった）と判定する処理
async function onDialogDismissed() {
  dismissalTimer = null
  if (!currentDialog) return
  const screen = getScreenText()
  // v1.17.0 (Phase 3d): codex 複数質問は parseDialog 既定が null(M>1 抑止)= 下の d チェックを
  // すり抜けて誤 dismiss(resolve-by-cli)し、スマホが持つ id を奪う。まだ画面に出ていれば生存と
  // みなしキャンセル(detectDialog の生存短絡と同じ盲点への defense in depth)。
  if (isLiveCodexMulti(screen)) return
  // 発火時点で再度 parseDialog して、画面にまだ(抑制対象でない)ダイアログが
  // あればキャンセルしない
  const d = parseDialog(screen)
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
