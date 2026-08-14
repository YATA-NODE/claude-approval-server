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
// PTY 出力を headless terminal に write して画面バッファを正確に再現する。
// Claude Code TUI は CSI カーソル移動で in-place 差分再描画するため、ANSI を正規表現で
// 除去する旧 stripAnsi 方式では描画順序が崩れ、スピナー混在時にダイアログを取りこぼす。
// 必須依存(純 JS・native build 不要なので install 失敗リスクは低い)。
const { Terminal } = require('@xterm/headless')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const { performance } = require('perf_hooks')

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

// **承認取り違え** = スマホに表示した承認と、実際にキーが入るダイアログが別物になること
// (拒否のつもりが承認になる / 表示と実行内容がずれる)。以下でこの語が出る箇所は、
// すべてこの事故を防ぐための不変条件を指している。
//
// ダイアログ検出: 終端マーカー (Esc to cancel 等) を主アンカーに使う。
// プロンプト本文("Do you want to")を主トリガーにはできない。Claude Code v2.1.x の
// Write/Edit 系ダイアログは ANSI 部分再描画の副作用で "Do you want t creat ..."
// のように 1〜2 文字単位で欠落するため。
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
// codex プランモードの選択肢質問(= AskUserQuestion 相当)のフッタは
// "tab to add notes | enter to submit answer | esc to interrupt"。既定 endMarker
// "Esc to cancel" に非一致なので、config なしでは検出できなかった。質問型に最も特異な
// "enter to submit answer" を ExitPlanMode マーカーと同様に常時 OR-in して既定検出可能にする
// (`esc to interrupt` は他文脈でも出うるため主キーにしない)。claude UI はこの語を出さない
// ため誤検出ゼロ(233 fixture で回帰確認)。
// 複数質問フローの最後の問(Question M/M)はフッタが "enter to submit all"
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
// 単一質問を multi 扱いで検出抑止 / sweep の移動数・総数汚染が起きうる。
// 既存 CODEX_QUESTION_HEADER_RE(`^Question…`)と整合。誤認時も fail-safe(PC フォールバック)だが
// 行頭限定で誤認面を最小化する。
const CODEX_QUESTION_POS_RE_G = /^\s*Question\s+(\d+)\/(\d+)/gim

// segment 内に分母 M>1 の "Question N/M" が 1 つでもあるか(global 走査で全件
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
// 行単位の判定用(非 global)。global 版を test() で回すと lastIndex が持ち越されて
// 1 行おきに取りこぼす。行を走査する側は必ずこちらを使う。
const END_MARKER_LINE_RE = new RegExp(END_MARKER_PATTERN, 'i')

const isWindows = os.platform() === 'win32'

// -------------------------------------------------------
// HTTP ヘルパー（localhost の approval-server に対してのみ使う）
// -------------------------------------------------------
// id はサーバー応答由来の値。パス要素へそのまま連結すると、
// 応答が壊れた / 改ざんされた場合に意図しないパスへ要求を出しうる。形式を許可リストで
// 検証し、パス要素としても符号化する。形式外なら送らない(fail closed)。
// サーバーの採番は crypto.randomUUID() だが、将来の変更に備えて文字種で許可する。
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
function safeIdPath(id) {
  const s = String(id == null ? '' : id)
  return SAFE_ID_RE.test(s) ? encodeURIComponent(s) : null
}

// 状態機械テストは検出 tick を直接回すため、登録経路が **実際に動いている
// approval-server** へ POST しうる(テスト用のダミー依頼がスマホに飛ぶ)。差し替え点を
// 1 つ設けて、テストからは必ずスタブに向ける。実行時は素通し。
let httpRequestImpl = null
function httpRequest(method, urlPath, body, timeoutMs) {
  return (httpRequestImpl || httpRequestReal)(method, urlPath, body, timeoutMs)
}

// 不正な ms(NaN / 0 以下 / 70000 超)は 70000 に丸める。無期限化と即時破棄の
// 両方向を封じる。本体を export しない代わりに、この純関数だけ __test seam から検証する。
function clampRequestTimeoutMs(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 70000 ? timeoutMs : 70000
}

function httpRequestReal(method, urlPath, body, timeoutMs = 70000) {
  const ms = clampRequestTimeoutMs(timeoutMs)
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null
    let settled = false
    let destroyed = false
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
        timeout: ms,
      },
      (res) => {
        let buf = ''
        res.on('data', (d) => (buf += d))
        // 解除は応答本文の完全受信後のみ(ヘッダー受信時に解除しない)。
        res.on('end', () => {
          if (res.statusCode >= 400) {
            // statusCode を error に持たせ、呼び出し側で 404(登録喪失)等を判別可能にする。
            const err = new Error(`HTTP ${res.statusCode}: ${buf}`)
            err.statusCode = res.statusCode
            return finalize(() => reject(err))
          }
          try {
            const parsed = JSON.parse(buf)
            finalize(() => resolve(parsed))
          } catch (_) {
            finalize(() => resolve(buf))
          }
        })
        res.on('error', (e) => finalize(() => reject(e)))
      }
    )
    // 終了処理を 1 箇所に集約する。end / req error / res error / 早期 close / deadline の
    // どれが先に来ても冪等(settled 後の resolve/reject は無視)。
    function finalize(action) {
      if (settled) return
      settled = true
      clearTimeout(dl)
      action()
    }
    // destroy も 1 回だけに絞る(inactivity timeout と絶対 deadline の両方から
    // 呼ばれうるため、二重 destroy を自前のフラグで防ぐ)。
    function destroyReq(err) {
      if (destroyed) return
      destroyed = true
      req.destroy(err)
    }
    // 呼出開始起点の絶対 deadline。既存の timeout オプションは非活動タイマーのため
    // 断続応答で回避できる。経過時間そのもので打ち切る安全弁を別に持つ。
    // 打ち切り 2 経路(deadline / 非活動 timeout)はどちらも destroy + 直接 finalize の
    // 同形にする: destroy → 'error' 発火の cascade に依存しない(destroy 済み stream は
    // error を emit しない場合がある)。二重呼出は settled / destroyed フラグが吸収する。
    const dl = setTimeout(() => {
      destroyReq(new Error('request deadline'))
      finalize(() => reject(new Error('request deadline')))
    }, ms)
    dl.unref?.()
    req.on('error', (e) => finalize(() => reject(e)))
    req.on('timeout', () => {
      destroyReq(new Error('request timeout'))
      finalize(() => reject(new Error('request timeout')))
    })
    // 応答完了(finalize 済み)より前に接続が切れた場合の安全網。正常完了後の
    // close は finalize が既に settled 済みなので no-op。
    req.on('close', () => finalize(() => reject(new Error('request closed before response'))))
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
// PTY 出力を流し込む headless terminal。spawnClaude() で生成。
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

// 表示領域のみ(スクロールバック 0 行)のテキスト。
// 「いま画面に出ているか」を判定する用途は必ずこちらを使う。getScreenText() は
// スクロールバック 40 行を含むため、既に閉じたダイアログのタブバーが残っていると
// 「まだ出ている」と誤判定し、依頼が永久に解決しなくなる。
function getViewportText() {
  if (!headlessTerm) return ''
  return screenTextFromBuffer(headlessTerm.buffer.active, headlessTerm.rows, 0)
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

// 起動対象 CLI をモジュールロード時に 1 回だけ解決して保持する。
// 注入関数(pollForResponse 等)は spawnClaude のローカルスコープ外で動くため、
// codex 向けのキー注入分岐に必要な「いま codex を相手にしているか」をここで確定させる。
// IS_CODEX は basename 一致(パス付き起動・実行ファイル拡張子を許容)。claude では
// false で既存経路が完全不変。判定漏れ(例 Windows の codex.cmd / codex.exe)は危険:
// IS_CODEX=false で番号 + Enter 経路に落ち、codex の既定 option1(承認)を誤確定しうる
// (拒否のはずが承認 = 承認取り違えと同型)ため、起動形態の揺れを広めに codex と判定する。
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

  // 画面バッファ再現用の headless terminal を pty と同じ cols/rows で生成。
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

  // アイドル中のダイアログ状態追跡を開始する(実行経路はここだけ)。
  startPeriodicDetect()

  // リサイズ
  // headless terminal も同じ cols/rows に揃える。揃えないとグリッド再現が
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
// 検出は headless terminal の画面バッファ(getScreenText())ベースに移行。
// 旧 cleanBuf スライディングウィンドウは廃止。
// DIALOG_SEGMENT_MAX は parseDialog が END_MARKER 手前を「ダイアログ候補領域」と
// して見る幅。getScreenText() はタブバー + prompt + options + フッタ + その上の
// tool 行(スクロールバック退避しうる)を含むので、それ全体をカバーする値。
const DIALOG_SEGMENT_MAX = 2000

// 現在有効なダイアログ（approval-server に登録済み）
// { id, options, tool, args, prompt, lastSeenAt }
let currentDialog = null

// currentDialog を変える処理(検出 / 登録 / 解決 / 再登録)を直列化する。
// これらは onPtyData のコールバックと 400ms tick から fire-and-forget で呼ばれるため、
// await(HTTP 往復)を跨いで交錯し、二重登録やスロット上書きが起こりうる。
let dialogLock = Promise.resolve()
function withDialogLock(fn) {
  const run = dialogLock.then(fn, fn)
  // 例外でチェーンを止めない(次の呼び出しがデッドロックしないように)
  dialogLock = run.catch(() => {})
  return run
}

// currentDialog が入れ替わるたびに増える世代番号。await を跨いだ処理は再開時にこれを
// 照合し、世代が変わっていたら自分の結果を捨てる(そのとき採番済みの id は明示解決する)。
let dialogGeneration = 0
function bumpDialogGeneration() {
  dialogGeneration++
  return dialogGeneration
}

// 登録済みダイアログのライフサイクルが実際に終わったことを 1 回だけ伝える one-shot フラグ。
// 巡回 latch の解除条件に使う。「currentDialog が null」と同一視してはいけない:
// 巡回に失敗した(= そもそも登録に至らなかった)状態も null なので、同一視すると
// latch が毎 tick 解除され、同じ画面を 400ms ごとに巡回し続ける(実機でタブ 1↔2 の
// 往復として再現)。立てるのは resolveCurrentAsCli のみ = 登録済みの依頼が終わった点。
// 登録のロールバック(id 採番失敗)や再登録のためのスロット解放では立てない。
let dialogLifecycleEnded = false

// parseDialog が連続して null を返し始めた時刻(成功でリセット)。
// 「タブ UI は見えているのに読めない」状態がどれだけ続いたかの計測にだけ使い、
// **これを根拠にダイアログを解決しない**(可視中の解決は Type something の
// 長い入力を取りこぼすため)。
let blindSince = 0
const MULTI_BLIND_GRACE_MS = 30000

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
// タブバーのチェック印。U+2610 ☐ / U+2714 ✔ と、フォントフォールバックの □ / ✓。
// 「回答済み」を示す印(☒ U+2612 / ⊠ U+22A0)を追加。実機での実文字は未確認だが、
// 追加しないと回答が進むにつれ印の個数が減り、①タブバー検出(>=2 個)が落ちる
// ②expectedTabCount が過少になる、の 2 つが起きる。過少側は完全性ゲートで
// 「転送しない」に倒れるだけなので安全側だが、検出が落ちると生存判定まで崩れる。
const TAB_MARK_CHARS = '☐✔□✓☒⊠'
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
// 行の **両端** の枠描画文字 + 空白(行の途中は触らない)。
const BOX_EDGE_G = new RegExp(`^[\\s${BOX_CHARS}]+|[\\s${BOX_CHARS}]+$`, 'g')
const PROMPT_NORMALIZE_STRIP_RE = new RegExp(`[\\s　${BOX_CHARS}\\r\\n]+`, 'g')
const RULE_LINE_RE = new RegExp(`^[${RULE_CHARS}\\s]+$`)
const TAB_BAR_RE = new RegExp(`[${TAB_MARK_CHARS}${TAB_ARROW_CHAR}]`)
const CURSOR_G = new RegExp(`[${CURSOR_CHARS}]`, 'g')
const CURSOR_NUM_RE = new RegExp(`[${CURSOR_CHARS}]\\s*[1-9]`)
const CURSOR_ANY_RE = new RegExp(`[${CURSOR_CHARS}]`) // 行内カーソル有無(非 global の membership 判定)
const TAB_MARK_G = new RegExp(`[${TAB_MARK_CHARS}]`, 'g') // チェック印のみ(→ を含まない)
// タブ移動ヒントの文言(CLI が描く)。ナビ判定はここを単一の出所にする。
const TAB_NAV_HINT_PATTERN = 'Tab\\s*/\\s*Arrow\\s+keys'
const TAB_NAV_HINT_RE = new RegExp(TAB_NAV_HINT_PATTERN, 'i')
const TAB_NAV_RE = new RegExp(`${TAB_ARROW_CHAR}|${TAB_NAV_HINT_PATTERN}`, 'i')
// Submit へフォーカスが移った直後に CLI が出す確認画面の文言(こちらも CLI が描く)。
// 実機ではこの画面に終端マーカーもナビ表示も無く、タブバーだけが残る。
const REVIEW_TITLE_RE = /Review\s+your\s+answers/i
const REVIEW_SUBMIT_OPTION_RE = /Submit\s+answers/i
// 確認画面の文言を探す窓(タブバー行の直下から何行ぶんか)。実機はバー行の 1〜4 行下に
// 並ぶので、再描画の空行を見込んで少しだけ余裕を持たせる。広げるほど会話ログの文言を
// 拾いやすくなる = 偽装しやすくなるので、必要最小限に留める。
const REVIEW_REGION_LINES = 10
// 承認枠のラベルと tool 名の対応。**語彙の出所はここ 1 箇所**にする(以前は枠の同定 /
// tool 判定 / 承認シグナルの 3 つに同じ語彙が分散し、`Run command` の欠落として実際に
// drift した = その箱では tool だけ分かって args が空のまま承認できた)。
// `action: true` = multi-word の強いラベル。AUQ / タブ式の本文には現れないので
// 「対象が空なら承認可能化しない」の根拠にしてよい。単語 1 語のラベル(Update / Delete /
// Search)は質問文やタブのラベルでも当たるため false(承認シグナルには使わない)。
const BOX_LABELS = [
  { re: /Bash\s*command|Run\s*command/i, tool: 'Bash', action: true },
  { re: /Create\s*file/i, tool: 'Write', action: true },
  { re: /Read\s*file/i, tool: 'Read', action: true },
  { re: /Update|Edit/i, tool: 'Edit', action: false },
  { re: /Delete/i, tool: 'Bash', action: false },
  { re: /Search|Grep/i, tool: 'Grep', action: false },
  { re: /Tool\s*use/i, tool: 'MCP', action: false },
]
// **行全体アンカー**で判定する。ラベル語は普通の英単語なので、行の一部に現れただけで
// 「ここが箱のラベル行」と決めると、コマンド本文に書いた単語で枠の境界を動かせる。
const BOX_LABEL_ALT = BOX_LABELS.map((l) => `(?:${l.re.source})`).join('|')
const BOX_LABEL_LINE_RE = new RegExp(`^[\\s${BOX_CHARS}]*(?:${BOX_LABEL_ALT})[\\s:]*$`, 'i')
function boxLabelToolFor(line) {
  const hit = BOX_LABELS.find((l) => l.re.test(line))
  return hit || null
}

// ツール承認分類シグナル。●Tool() 行のマーカー。
// AUQ は専用 ●AskUserQuestion() 行を持たない。
//
// **行頭アンカー**である理由: `●` は CLI が tool 行の行頭に描くマーカーで、行の途中に現れる
// `● Tool(` は **コマンド本文に書かれた文字列**でしかない。行の途中まで候補にすると
// `● Bash(危険なコマンド) ; : ● Read(README.md)` の内側が最後のマッチになり、スマホには
// 無害な `Read README.md` だけが出て危険なコマンドが承認できてしまう(実行で再現済み)。
// **桁 0 厳密**(`^[ \t]*●` にしない)。実測(2026-08-01、実録画をセル属性ごと再生)では
// CLI が描く `●` は必ず x=0 で、モデルの本文は CLI の bullet の後ろ(x=2)か、継続行の
// 字下げに来る。字下げを許すと `● 説明します。` の次行に `  ● Read(x)` と書くだけで
// 偽の tool 行を作れる。なお **端末の折り返しで作られる偽の行頭は塞げない**
// (`screenTextFromBuffer` が isWrapped を捨てるため)= 採用可否は glue との AND で決める。
const TOOL_LINE_OPEN_RE = /^●[ \t]*([A-Za-z_]+)[ \t]*\(/gm
// tool 名の上限。実在する最長は MCP 系(`mcp__server__tool` 形式)でも 64 字に収まる。
const TOOL_NAME_MAX_LEN = 64

// 承認枠(prompt 直前の罫線から prompt まで)を切り出す。**この束縛が無いと箱の外が読める**:
// 箱の上には会話ログが 2000 字ぶん入っており、モデルが `Bash command` と無害なコマンドを
// 2 行書くだけで、実体が `rm -rf ...` でもスマホには無害なコマンドが出る(実行で再現)。
// 戻り値は `{ lines, labelSeen, ambiguous }`。罫線が見つからない = 箱を同定できていないので
// `lines` は空(ラベル推測を行わない)。`ambiguous` はラベル行が 2 本以上見えている状態で、
// 呼出側はこれを **args の有無に関係なく** 転送しない根拠にする。
function boxBodyLines(segment, qIdx, wideText) {
  // **残る既知の欠陥**: prompt が端末幅で複数の物理行に折り返されると、`qIdx`(末尾の `?`)
  // で切って最後の 1 行だけ落とすため、質問文の前半が箱の本文として残り args に混ざる
  // (実機の形で再現。args = "curl … Do you want to run this command against the production")。
  // 右端を promptStart にする案は不可: `expandPromptStart` は構造境界が無いとコマンド行まで
  // 遡るため、弱ラベルの箱で本文ごと失って転送不能になった(実行で再現)。
  // 直すなら prompt 段落の同定そのものを構造境界で行う必要があり、別リリースで扱う。
  const lines = String(segment)
    .slice(0, qIdx | 0)
    .split('\n')
  lines.pop() // qIdx は prompt 末尾の `?` の位置。最後の要素は prompt 本文なので落とす
  const none = (labelSeen, ambiguous) => ({ lines: [], labelSeen, ambiguous })
  // **ラベルの計数は segment(prompt 直上 2000 字)ではなく画面全体で行う**。segment も窓なので、
  // コマンド本文を 2000 字より長くすれば本物のラベルを窓の外へ押し出せる(実行で再現。
  // 実体 `rm -rf ~` の承認が `[Read] README.md` としてスマホに出た)。窓を根拠にした判定は
  // 「窓の外へ押し出す」で必ず破れるので、根拠は窓に依存しないものだけにする。
  // 右端は `lines` と揃える(prompt 本文の行は落とす)。左端だけを画面全体へ広げる。
  let countLines = lines
  if (wideText !== undefined) {
    countLines = String(wideText).split('\n')
    countLines.pop()
  }
  // **ラベル行が 2 本以上見えるフレームは、どれが本物の枠か決められないので転送しない**。
  // 罫線もラベルもモデルがコマンド本文に書ける普通の文字なので、コマンドの中に
  // 「罫線だけの行 + 偽ラベル + 無害なコマンド」を書くと、枠の上端がその偽罫線までずれて
  // 実際のラベルとコマンドが枠の外へ押し出される(実行で再現。実コマンドが 1 文字も出ない)。
  // 端末の折り返しでも同じ形を作れるため、行頭や桁では弁別できない。曖昧なら PC で答える。
  const labelCount = countLines.filter((l) => BOX_LABEL_LINE_RE.test(l)).length
  if (labelCount > 1) return none(true, true)
  const isRule = (l) => RULE_LINE_RE.test(l) && l.replace(/\s/g, '').length >= 3
  let ruleIdx = -1
  for (let i = lines.length - 1; i >= 0 && ruleIdx === -1; i--) if (isRule(lines[i])) ruleIdx = i
  if (ruleIdx === -1) return none(labelCount > 0, false)
  // **1 本上の罫線へ遡らない**。遡りは「罫線 → ラベル → 本文 → 区切り線 → prompt」という
  // 形の箱を通すために入れていたが、実機の箱(実録画で確認)は下端の区切り線を持たず、
  // 遡りは「実際の枠がまだラベルを描いていないフレームで、会話ログ側の偽ラベルまで届く」
  // 経路そのものだった(実行で再現)。ラベルが見つからなければ本文は空のまま返し、
  // 対象が空のツール承認として承認可能化しない(6d)= PC 側で答える。
  // `labelSeen` = 段落内にラベル行が見えているか。**枠の中に入っているかは問わない**のが要点で、
  // 「ラベルは見えているのに、選んだ枠の中には無い」= 枠の同定に失敗している状態を
  // 呼出側が fail-close の根拠にできる。ここを prompt 直上の固定窓で判定すると、
  // 本文を長くしてラベルを窓の外へ押し出すだけでガードを外せた(実行で再現)。
  return { lines: lines.slice(ruleIdx + 1), labelSeen: labelCount > 0, ambiguous: false }
}

// 承認枠の中からコマンド本文を採る。**単一の正規表現で 1 行だけ拾わない**:
// 旧実装は `?`・80 字・罫線相当の文字で無印のまま切っており、`curl "http://x/?a=b" &&
// rm -rf ~` が 15 字で切れて後半がスマホに出なかった(実行で再現)。ラベル行より下の
// 非空行を **すべて** 連結し、切るのは最後の 1 箇所(表示枠)だけにする。
// 注: 実機の箱ではコマンド行の下にツールの説明行が続く(コマンド = 既定色 / 説明 = 減光で
// 属性上は弁別できるが、parseDialog はテキストしか受け取らない)。**説明まで含めて出す**のは
// 「多く見せる」方向で、隠す方向より安全という判断。属性で分ける案は別リリース。
function extractBoxCommand(body) {
  const empty = { text: '', truncated: false }
  if (!body) return empty
  const labelIdx = body.findIndex((l) => BOX_LABEL_LINE_RE.test(l))
  if (labelIdx === -1) return empty
  const parts = []
  for (const raw of body.slice(labelIdx + 1)) {
    // 罫線文字を落とすのは **行の両端だけ**。行の途中まで空白にすると `echo a─b` が
    // `echo a b` になり、別のコマンドと同じ args = 同じダイアログと判定される(実行で確認)。
    // 枠の描画文字は行の端にしか来ないので、端だけで足りる。
    const line = raw.replace(BOX_EDGE_G, '').replace(/\s+/g, ' ').trim()
    if (line) parts.push(line)
  }
  // 打ち切るときは **印を付ける**。無印で切ると、先頭が同じで後半だけ違う 2 つのコマンドが
  // 同じ `args` に潰れ、`sameDialogIdentity` / `strictDialogIdentity` が「同じダイアログ」と
  // 判定する(表示は `&& ls` のまま `&& rm -rf ~` を承認できた = 承認取り違えの再発。実行で再現)。
  // 印が付いた本文は codex 経路と同じく承認可能化しない(下記 6e)。
  return truncateCommandText(parts.join(' '))
}

// 直近の `● Tool(...)` を 1 つ返す。args は **括弧の対応を数えて**閉じ括弧まで採る。
// 最初の `)` で打ち切ると `echo "(x)" && ls` と `echo "(x)" && rm -rf ~` が同じ `echo "(x`
// に化け、`sameDialogIdentity` が別承認を「再描画」と誤認する(承認取り違え、実行で再現済み)。
// 折り返した tool 行(args が次行へ続く)を扱うため、走査は行をまたぐ。
//
// readable=false の意味は「このフレームでは本文を読み切れなかった」:
//   - 閉じ括弧に到達しない(描画途中 / 折り返しの続きが未着)
//   - 閉じたが **同じ行に本文が続く**(引用符内の `)` で閉じた等 = どこまでが本文か確定しない)
//
// **この戻り値だけでは安全性を判断できない**(重要)。`● Tool(` を行頭で探すが、
// `screenTextFromBuffer` が isWrapped を捨てて物理行を連結するため、ここでいう「行頭」は
// **論理行の行頭ではない** = 端末の折り返し位置を選べば偽の行頭を作れる。表示に採用してよいかは
// 呼出側が `hasGluedToolLine`(box 罫線への密着)と AND して決める。args を使ってよいのは
// readable=true のときだけ(false のとき args は空か、途中で切れた文字列)。
// 本関数を使うのはツール承認分岐のみ。ExitPlanMode / codex コマンド承認 / AskUserQuestion は
// args の出所が別なので readable を見ない。
function findLastToolLine(text) {
  const s = String(text)
  TOOL_LINE_OPEN_RE.lastIndex = 0
  let open = null
  for (let m; (m = TOOL_LINE_OPEN_RE.exec(s)); ) open = m
  if (!open) return null
  const argStart = open.index + open[0].length
  let depth = 1
  let close = -1
  for (let i = argStart; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) {
      close = i
      break
    }
  }
  // tool 名にも上限を置く。`([A-Za-z_]+)` は無制限なので、長い tool 名を書くだけで
  // スマホの 1 行がそれで埋まり、**コマンド本文も質問文も表示から消える**(実行で再現)。
  if (open[1].length > TOOL_NAME_MAX_LEN) return null
  const base = { tool: open[1], index: open.index }
  if (close === -1) return { ...base, args: '', end: s.length, readable: false }
  const eol = s.indexOf('\n', close + 1)
  const rest = s.slice(close + 1, eol === -1 ? s.length : eol)
  const args = s
    .slice(argStart, close)
    .replace(/[\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 引用符の対応が取れていない = 引用符の内側の `)` で閉じたということ。この形は
  // **rest が空でも readable にしてはいけない**: 端末の折り返しが閉じ括弧の直後に来ると
  // 残りが次の物理行へ行くので rest は空になり、その行が罫線文字で始まれば密着も成立して
  // 途中で切れた args が採用される(`● Bash(echo "safe)` + `─" && rm -rf ~` で再現)。
  // 折り返し位置は本文の長さで選べるので、攻撃者が作れる形。
  const balanced = (ch) => (args.split(ch).length - 1) % 2 === 0
  return {
    ...base,
    args,
    end: close + 1,
    readable: rest.trim() === '' && balanced('"') && balanced("'"),
  }
}
// 既知のツール承認 / ExitPlanMode 定型句(弱シグナル)。文言追加はここ 1 箇所で。
const APPROVAL_PHRASE_RE = /Do you want to/i
// ●Tool 行未描画フレームでも承認に倒すための box 内 multi-word アクションラベル。
// 汎用 1 語(Edit/Update/Delete/Search)は AUQ 本文で誤爆するため multi-word 限定 =
// BOX_LABELS の `action: true` から導出する(語彙の出所を 1 箇所にする)。
// **行アンカーを掛けない**のは意図的で、`Bash\ncommand` のように端末の折り返しで割れた
// ラベルも拾う。この判定が真になって困るのは fail-close 側だけ(= 転送しない方向)。
const ACTION_LABEL_RE = new RegExp(
  `\\b(?:${BOX_LABELS.filter((l) => l.action)
    .map((l) => `(?:${l.re.source})`)
    .join('|')})\\b`,
  'i'
)
// hasActionLabel の走査窓(prompt 直上のみ。scrollback 混入による誤爆を抑える)。
const ACTION_LABEL_WINDOW = 200
// glued 判定: ツール行の **次の行** がボックス上端の罫線で始まるか。出力行を挟むと不成立 =
// scrollback の古い ●Tool が AUQ を承認に化けさせる経路を断つ。
// `\s*` にしない(= 空行を跨がせない)。跨がせると、モデル本文の最後に `● Bash(ls -la)` を
// 置いて空行を挟むだけで、別コマンドの承認枠にその tool 行が継承される(実行で再現)。
const TOOL_GLUE_BORDER_RE = new RegExp(`^[ \\t]*\\r?\\n[ \\t]*[${BOX_CHARS}]`)

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

// 解決済みダイアログの抑制機構(旧 `cleanBuf = ''` リセットの代替)。
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

// 本番検出経路は getScreenText()(headless terminal)に移行したため、
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
  // headless terminal にそのまま write し、ANSI 解釈はライブラリに任せる。
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
    // codex 質問ヘッダ "Question N/N (..)" も段落境界 = prompt 本文に
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

  // 2b. codex の複数質問フロー(Question N/M, M>1 = ←/→ で巡回するタブ式
  //   相当)は、単一質問として中途半端に注入すると先頭 1 問だけ答えて残りが PC に残る(実機で
  //   混乱を確認)。全問 sweep + タブ登録 + submit all が使えない経路では検出せず
  //   (null)PC 側で処理させる(スマホで半端に答える事故を防ぐ)。codex 質問型 endMarker が
  //   立つ場合のみ判定するため claude / codex 承認には無影響。
  // allowMultiCodex=true のときはこの抑止を外し、現在表示中の 1 問を返す
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
  // codex プランモードの選択肢質問は丁寧形(「…ください。」)で ? を
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
  // hot path 削減: nlIdx >= 0 の通常パスでは hasTabBarText を呼ばない。
  //
  // 行末アンカー優先順位:
  //   1. `Submit` 末尾 — AskUserQuestion-Multi 仕様で必ず存在し、prompt 本文より
  //      確実に手前にある(prompt 内の `→` 誤検出も Submit より後ろなので無害)
  //   2. タブマーカー (☐ ✔ □ ✓) と `→` の最終出現 — Submit が無い UI へのフォールバック
  let arrowIdx = -1
  if (nlIdx < 0 && hasTabBarText(segment)) {
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

  // 6. ツール判定。AUQ を「ツール承認シグナルがどれも立たない」と定義する合成判定。
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
  const lastTool = findLastToolLine(beforeDialog)

  const hasShiftTab = /shift\s*\+\s*tab/i.test(optionSegment)
  const promptIsApproval = APPROVAL_PHRASE_RE.test(prompt)
  let hasGluedToolLine = false
  if (lastTool) {
    const toolEnd = lastTool.end
    const between = buf.slice(toolEnd, promptAbsStart)
    // glued = (a) ツール行とこのダイアログの間に別の生 ● が無い(ターン境界なし)かつ
    //   (b) ツール行の **次の行** がボックス上端の罫線で始まる(空行も出力行も挟めない)。
    //   (b) を欠くと scrollback の古い ●Tool が出力行越しに継承され AUQ を承認に化けさせる。
    hasGluedToolLine = !between.includes(BULLET_CHAR) && TOOL_GLUE_BORDER_RE.test(between)
  }
  const hasActionLabel = ACTION_LABEL_RE.test(beforeQ.slice(-ACTION_LABEL_WINDOW))
  const looksLikeAUQ =
    !hasShiftTab && !promptIsApproval && !hasGluedToolLine && !hasActionLabel

  // 終端マーカー種別を最優先(ExitPlanMode は optionSegment に shift+tab が残らず、prompt も
  // "Do you want to" 非含のため、合成判定だけだと AUQ と誤判定される。args は持たない)。
  // codex 判定は opts.codex 優先・既定 IS_CODEX(opts.allowMultiCodex と同じく opts 経由で
  // 渡せるようにし parseDialog を test から純関数として検証可能に。本番は呼出側が省略 =
  // IS_CODEX で不変)。分類と freeTextOptions 付与の両方で同じ値を使う。
  const codexMode = opts.codex !== undefined ? opts.codex : IS_CODEX
  let tool = 'Unknown'
  let args = ''
  // 「読めたが転送してはいけない」理由。null を返すかどうかは 6e で 1 箇所にまとめて決める。
  let unforwardable = null
  if (isExitPlanMode) {
    tool = 'ExitPlanMode'
  } else if (codexMode && isCodexCommandApprovalOptions(options)) {
    // codex コマンド承認は合成判定だと looksLikeAUQ に倒れ
    // AskUserQuestion と誤表示される(prompt "Would you like to run" を APPROVAL_PHRASE_RE が
    // 拾わないため)。全 option がショートカットを持つ = コマンド承認として Bash ラベル + コマンド
    // 本文で表示する(注入経路は別途 option ラベルのショートカット抽出で振り分けるため不変)。
    tool = 'Bash'
    const cmd = extractCodexCommand(segment, qIdx)
    args = cmd.text
    // 表示側 fail-safe(取り違え秘匿側): コマンド本文を確証できない(断片フレームで `$` 行が未描画 等)
    // なら、コマンド空欄のブラインド承認になるため承認可能化しない。null を返し次の完全フレームで
    // 再検出させる(injection 側の reRegisterUninjectableDialog と対称の保守的挙動)。5b 完全性
    // ガードが options のみ検証し `$` 行を見ないため、ここで補う。
    if (!args) unforwardable = 'codex-unreadable'
    else if (cmd.truncated) unforwardable = 'truncated'
  } else if (looksLikeAUQ) {
    tool = 'AskUserQuestion'
  } else {
    // 6b. ツール承認: `● Tool(args)` 行を採用するのは **box 上端の罫線に密着している** ときだけ
    //   (hasGluedToolLine)。密着を要求しないと、次の 3 つがそのまま表示のすり替えになる:
    //     - 前のターンの `● Bash(ls)` が出力行を挟んで残っている(scrollback からの継承)
    //     - コマンド本文に書かれた `● Read(README.md)` が、端末の折り返しで物理行の先頭に来る
    //       (`screenTextFromBuffer` は isWrapped を捨てるので「行頭」は論理行の行頭ではない)
    //     - 引用符内の `)` で閉じたと誤認し、残りの本文が後ろに続いている
    //   前 2 つは「閉じ括弧の直後が罫線でない」= 非密着で閉じるが、**3 つ目は密着判定を通る**
    //   (誤クローズした残りが罫線文字で始まりうる)ので readable との AND が要る(下記)。
    //   **さらに、密着 + readable が揃っても `● Tool()` 行は箱の中身に優先しない**(下記 6b)。
    //   行頭 `●` は CLI が assistant メッセージの先頭に描くマーカーなので、モデルが
    //   メッセージを `Bash(ls -la)` で始めるだけで桁 0 の正規な tool 行が描かれ、次の行に
    //   罫線を 1 つ置けば密着も成立する(実行で再現)。**箱の中身のほうが権威がある**
    //   (実機の claude はコマンド本文を box に描く)ので、読めた側を採るのが正しい。
    //   **readable も独立に必要**(密着には含意されない)。引用符内の `)` で誤って閉じた残りが
    //   罫線文字で始まると密着判定を通ってしまい、途中で切れた args が採用されうる
    //   (`● Bash(echo ")─" && rm -rf ~/important)` で再現。テスト [6u] が含意の不成立を固定)。
    // 承認枠の切り出しは 6b / 6d の両方が使うので 1 回だけ計算する。
    // ラベルの計数だけは画面全体を渡す = segment の窓に依存させない(右端は qIdx で揃える)。
    const box = boxBodyLines(segment, qIdx, buf.slice(0, segStart + qIdx))
    // 6c. `● Tool()` 行を採らなかった場合の本命経路: **承認枠の中身** から読む。
    //   実機の箱は罫線 + ラベル + コマンド本文 + 説明、という形(実測 2026-08-01)。
    //   ラベルの探索も箱の中に束縛する = 会話ログに書いた偽ラベルで tool を騙せない。
    const labelLine = box.lines.find((l) => BOX_LABEL_LINE_RE.test(l))
    const label = labelLine ? boxLabelToolFor(labelLine) : null
    if (label) {
      // ラベル行より下の非空行を連結して本文にする(切るのは表示枠だけ)。
      tool = label.tool
      const extracted = extractBoxCommand(box.lines)
      if (extracted.truncated) unforwardable = 'truncated'
      args = extracted.text
      // 「本文を読めないまま `[Bash]` と断定しない」ためのガードはここには要らない。
      // ラベルが見えていて対象が空なら、下の 6d が種類を問わず fail-close するため。
    } else if (!box.labelSeen && lastTool && hasGluedToolLine && lastTool.readable) {
      // 枠にラベルが無い(BOX_LABELS 外のツール = WebFetch / MCP 系)ときだけ tool 行を使う。
      // **`!box.labelSeen` が要る**: 箱の中にラベルが無い状態は 2 つの意味を持つ。
      //   (a) そもそもラベルを持たない種類の枠 = ここで tool 行を使うのが正しい
      //   (b) ラベルは画面に見えているのに箱の中に入らなかった = **枠の切り出しに失敗している**
      // (b) は、コマンド本文の中に罫線だけの行を 1 本書けば作れる(上端がその偽罫線までずれ、
      // 本物のラベルとコマンドが枠の外へ出る)。偽ラベルを書かないので ambiguous に掛からず、
      // 自作の tool 行が args を埋めるので 6d の empty-target にも掛からない = 単独では
      // 塞がっているガード 2 つを同時に迂回できた(実行で再現。実コマンドが 1 文字も出ない)。
      // labelSeen は segment(prompt 直上 2000 字)でなく画面テキスト全体で数える。
      // **ただし画面テキスト自体も窓**(表示領域 + スクロールバック 40 行)なので、
      // 窓依存が消えたわけではない = 押し出しのコストが 2000 字から 1 画面ぶんへ上がっただけ。
      // このガード自体は本文を ~73 行(cols120/rows40)まで伸ばせば外れる(実行で確認)。
      // ただしその先で表示すり替えが成立するには、偽の `● Tool()` 行が桁 0 厳密 + glue の
      // 両方を満たす必要があり、実機の箱本文(罫線 `│` prefix / 字下げ)で成立するかは未確認。
      // **代償**: ラベル無し枠の承認でも、画面のどこかに BOX_LABELS の語が 1 行でも残っていれば
      // 転送しない。fail-close 方向だが、可用性は落ちる(README の既知の制約に記載)。
      tool = lastTool.tool
      args = lastTool.args
    }
    // 6d. **対象が空のツール承認は承認可能化しない**(codex 側 `if (!args) return null` と対称)。
    //   何を実行するのかが見えないまま「はい」を押せる状態を作らない。描画途中(ラベルだけ
    //   先に出てコマンド行が未着)なら次の完全フレームで再検出されるし、PC 側には全文がある。
    //   条件を `tool !== 'Unknown'` にしてはいけない: ラベルが見えているのに対象行が
    //   まだ描画されていない(描画途中)フレームでも `label` は付き `tool` は確定するため、
    //   `tool` の確定だけでは「対象を読めた」ことの証明にならない。
    //   判定は「**対象を持つツール承認**だと分かる根拠が立っているか」で行う。
    //   `hasShiftTab` は入れない: タブ式の各タブも option 領域に shift+tab ヒントを持つため、
    //   入れるとタブ式ダイアログが丸ごと転送されなくなる(実行で確認)。
    //   BOX_LABELS にも ACTION_LABEL_RE にも無いツール種別で `● Tool()` 行の継承も
    //   成立しない場合は `tool` が 'Unknown' のまま残るが、これは下の 6f が一括で塞ぐ。
    //   **窓に依存しないこと**: 旧実装は `hasActionLabel`(prompt 直上 200 字)だけを根拠に
    //   していたため、本文を長くしてラベルを窓の外へ押し出すだけでガードが外れた(実行で再現。
    //   スマホには `[Unknown]` と無関係な行だけが出て、実体は `rm -rf ~` を承認できた)。
    //   段落内にラベルが見えている(`box.labelSeen`)/ 枠を同定できない(`box.ambiguous`)なら、
    //   窓の外でも「ツール承認の枠がそこにある」と扱う。
    if ((hasActionLabel || hasGluedToolLine || box.labelSeen) && !args) {
      unforwardable = 'empty-target'
    }
    // **枠を同定できないフレームは `args` の有無に関係なく転送しない**。`&& !args` と
    // AND すると、偽ラベルで `ambiguous` にした上で自作の `● Tool()` 行から args を
    // 埋めるだけで両方のガードを同時にすり抜けられる(実行で再現。箱の実コマンドが
    // 1 文字も出ずに `ls -la` がスマホへ出た)。ラベルが 2 本見えている時点で
    // 「どの枠の承認か」が決まらないので、何を表示しても正しさを保証できない。
    // **多層防御の記録**: このガードは上の empty-target と重なる。
    // ラベル 2 本フレームは lines 空 → box から args 読めず、`!box.labelSeen` が lastTool 経由の
    // args も塞ぐため必ず empty-target(!args)にも掛かる。ambiguous-box 固有(ambiguous かつ
    // args あり)は現状 parseDialog では到達不能で、変異テストでこの行を消しても empty-target が
    // 代替して SURVIVED になる。だが削除しない = `!box.labelSeen` や解析順序が将来変わって
    // args 経路が復活したときの独立した fail-closed バックアップ。外部契約は「転送不能」であって、unforwardable の
    // 理由文字列(empty-target / ambiguous-box)の優先順位は診断用で仕様外。
    if (box.ambiguous) unforwardable = 'ambiguous-box'
    // 6f. 残余の fail-close: ラベルも ●Tool 継承も成立せず tool が確定しないまま抜けた
    //   (BOX_LABELS に無いツール種別の枠で、glue した ●Tool 行も無い等)。この形は
    //   上の 6d/ambiguous-box のどのガードにも掛からず tool='Unknown' / args='' が
    //   素通りしていた(実測: MCP 系ツールの枠で再現)。「何のツールか分からない」を
    //   読めない扱いにする(fail-close)。
    if (tool === 'Unknown' && !unforwardable) unforwardable = 'unknown-tool'
  }

  // **転送してよいか**の判定はここ 1 箇所に集める。理由は code(`truncated` / `empty-target` /
  // `codex-unreadable`)で持ち、3 経路とも同じログ経路で観測できるようにする(「なぜスマホに
  // 出ないのか」をフィールドで切り分けられないと運用で詰む)。
  // `screenOnly` は「この画面はダイアログとして読めるか」だけを問う呼出(タブ巡回のキー送出
  // ガード等)のためのモード。転送可否のポリシーを増やしても、そちらの述語が裏返らないように
  // する(裏返ると、描画途中の承認画面が「ダイアログではない」と見なされて Shift+Tab の
  // 送出先になる。実行で再現)。
  if (unforwardable && !opts.screenOnly) {
    logUnforwardableOnce(unforwardable, args)
    return null
  }

  const dlg = { prompt, options, tool, args }
  // codex 自由記入 option(末尾 (tab))の番号宣言を付与。
  // claude / コマンド承認((tab) 不在)は付かず key 自体が出ない = 下流の挙動・body 不変。
  if (codexMode) {
    const fto = codexFreeTextOptions(options)
    if (fto) dlg.freeTextOptions = fto
  }
  return dlg
}

// 「この画面はダイアログとして読めるか」。**転送してよいか(fail-close の増減)とは別問題**で、
// キー送出のガードはこちらを使う。parseDialog の戻り値が null かどうかで代用すると、
// 「対象が空だから転送しない」フレームが「ダイアログではない画面」に見え、実在する承認画面へ
// Shift+Tab(= このセッションの編集をすべて許可)を送る経路が開く(実行で再現)。
function screenHasDialog(text) {
  return parseDialog(text, { screenOnly: true }) !== null
}

// フッタ(END_MARKER の最終出現)の行 index。無ければ -1。
// ダイアログ領域の下端アンカーで、`parseDialog` が使う「末尾マーカーの最終出現」と同じもの。
// タブバー探索の窓もこれに束縛する = 2 つの経路が別々のアンカーで別々の行を指す食い違いを消す。
function findFooterIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (END_MARKER_LINE_RE.test(lines[i])) return i
  }
  return -1
}

// フッタ行そのものにタブ移動ヒントがあるか。フッタは **CLI が描く** ので、
// タブバーが折り返しで 2 行に割れても / 長い選択肢で表示領域の外へ出ても残る。
// 単一承認のフッタは "Esc to cancel" だけなので、ここで両者を弁別できる。
function hasTabNavFooter(text) {
  const lines = String(text).split('\n')
  const i = findFooterIndex(lines)
  return i >= 0 && TAB_NAV_HINT_RE.test(lines[i])
}

// Submit へフォーカスが移ったときに CLI が出す確認画面か(形だけの判定)。
// この画面はタブバーを残したまま終端マーカーを持たないため、parseDialog は null になり
// フッタ由来の判定も全て偽になる。両方の症状が同じ 1 つの状態から来ることを明示する。
// 本番では sweepTabs の `endedAtReview`(完全性ゲート `reachedSubmit` の必須条件)で使う。
// **ここを緩めると半端登録の防波堤が外れる**(収集数の一致だけが残る)。文言はモデル生成
// テキストでも作れるので、呼び出し側で CLI 描画の構造条件と AND を取っている。
// テスト [S15] は同じ述語を「偽 TUI の確認画面が実機と同じ形か」の oracle にも使う。
function isReviewScreenText(text) {
  const s = String(text)
  const lines = s.split('\n')
  // findTabBarLine と同じ窓・同じ一意性で選ぶ(片方だけ判定が違うと、テキスト側が
  // 拒否した行を起点に確認画面と誤認する)。
  const scan = tabBarScan(lines)
  if (scan.state !== 'tabbed') return false
  // **文言はバー行の直下に限る**。画面のどこかにあれば真にすると、モデルが会話ログへ
  // 2 語書くだけで「Submit に着いた証拠」を作れる(完全性ゲートの柱が収集数だけに戻る)。
  // 実機の確認画面はバー行の 1〜4 行下に両方が並ぶ(cols=120 の採取)。
  const region = lines.slice(scan.indices[0] + 1, scan.indices[0] + 1 + REVIEW_REGION_LINES).join('\n')
  return REVIEW_TITLE_RE.test(region) && REVIEW_SUBMIT_OPTION_RE.test(region)
}

// ExitPlanMode の **可能性がある** 画面か。この画面では Shift+Tab がプラン承認の
// 確定操作なので、巡回・位置検証のどちらから来ても 1 バイトも送ってはいけない。
//
// 「末尾マーカーの最終出現」で種別を決めると、モデル生成テキストに別の終端マーカーを
// 1 行描かれるだけで判定が裏返る(実行で確認)。承認確定キーを送るかどうかの判断では
// **画面のどこかに出ていれば送らない** に倒す。誤検知の被害は「巡回しない = 転送しない」
// だけで、取り違えより軽い。
function isExitPlanScreen(text) {
  return EXIT_PLAN_END_RE.test(String(text))
}

// フッタ **行そのもの** が ExitPlanMode 型か。
// 巡回するかどうかの判断は送出側と同じ広い述語(isExitPlanScreen)に
// 統一したため、この関数は本番経路から呼ばれていない(判定は parseDialog 側の
// テストで固定されている)。狭い述語に戻すと、開始判断と送出判断が食い違って
// 「開始できるのに戻れない」画面が生まれるため、戻さないこと。
// 広い述語による可用性の低下(会話ログに文言が 1 行あるだけで巡回しない)は、
// latch を消費しないことで受けている = 文言が流れれば同じ出現をやり直せる。
function isExitPlanFooter(text) {
  const lines = String(text).split('\n')
  const i = findFooterIndex(lines)
  return i >= 0 && EXIT_PLAN_END_RE.test(lines[i])
}

// 断片(segment)に「タブバーらしい文字列」があるか、だけを見る字句判定。
// prompt 抽出でタブバー文字を本文へ混入させないためのアンカー選択に使う用途専用で、
// 「画面がタブ式か」(= 転送や巡回の可否)の判断には使わない。両者を同じ述語にすると、
// 一方を安全側へ締めた途端に他方が壊れる(prompt へバー文字が漏れる)。
function hasTabBarText(buf) {
  const s = String(buf)
  return (s.match(TAB_MARK_G) || []).length >= 2 && TAB_NAV_RE.test(s)
}

// タブ式 AskUserQuestion(複合質問)の **粗い** 特徴判定。
// 画面上部に `□タブ1 □タブ2 ✓タブ3 ✓Submit →` のタブバー + 下部に
// "Tab/Arrow keys to navigate" ヘルプが出る形式を検出する。
//
// 役割 = 「単一質問として扱ってはいけない画面か」の判定。偽陽性寄りに倒す
// (誤って単一登録すると、表示中の 1 タブだけが転送されて回答位置がずれる = 承認取り違え)。
// **キーを実際に送ってよいか** の判定には使わない(そちらは tabBarScan の 'tabbed')。
//
// 判定は 2 系統の OR:
//   1. フッタのタブ移動ヒント。**CLI が描く** = モデル生成で偽造できない最も強い根拠で、
//      バーが折り返しても表示領域の外へ出ても残る。
//   2. 印 2 個以上 + `Submit` + タブ移動ヒントが画面のどこかにある。フッタが読めない
//      フレーム(再描画途中 等)のための保険。
//
// `→` の有無だけをナビ材料にすると、通常の承認画面の会話ログへ `☐ a ☐ b ✔ Submit →` を
// 1 行出すだけで真になり、**通常の承認が単一として登録されなくなる**(モデルが自分の
// 承認要求を隠せる)。ナビはヒント文言に限定する。ヒント文言を本文に書かれた場合も
// 真にはなるが、その被害は「転送せず PC で回答」= fail-close 側に留まる。
function isTabbedDialog(buf) {
  const s = String(buf)
  if (hasTabNavFooter(s)) return true
  // Claude TUI は U+2610 (☐) / U+2714 (✔) を使う環境が多いが、フォント未対応の
  // 環境で U+25A1 (□) / U+2713 (✓) にフォールバックされる場合もあるため両方拾う。
  const boxMarks = (s.match(TAB_MARK_G) || []).length
  return boxMarks >= 2 && s.includes('Submit') && TAB_NAV_HINT_RE.test(s)
}

// 登録済みの依頼 dialog が「まだ画面に出ている」か(生存判定)。Submit の確認画面では
// 終端マーカーもナビ表示も消え、**タブバー行だけが残る**。文言だけを見ると「消えた」と
// 誤判定して、ユーザーが Submit にフォーカスを置いただけで入力途中の依頼を時間経過で
// 失う(実機で観測)。そこでバー行の有無も根拠に加えるが、**バー行は会話ログの 1 行でも
// 成立する**(モデル生成テキストで作れる)ので、有無だけでは依頼を無期限に延命させて
// しまい、後から出た別のダイアログへ回答が入る余地を残す。見出し列の一致まで求める。
// 見出しは回答しても変わらない(変わるのは印だけ)ので、同一性の鍵として使える。
function isTabbedUiOfDialog(text, dialog) {
  const want = dialog && dialog.barLabels
  if (!Array.isArray(want) || want.length === 0) return false
  const now = tabBarLabels(text)
  return Array.isArray(now) && now.length === want.length && now.every((l, i) => l === want[i])
}

// -------------------------------------------------------
// タブバー行の読み取り(巡回の 1 回化 / 完全性ゲート / 位置検証の土台)
// -------------------------------------------------------

// 選択肢行(`  1. …` / `❯ 1. …`)。本文は **モデル生成 = 信頼できない入力** で、印や
// `Submit` を含む文字列を出力させられる。タブバー行の候補から必ず除外する。
// カーソル文字集合は CURSOR_CHARS から生成し、他の派生 RegExp(CURSOR_NUM_RE 等)と
// drift させない(新 CLI のカーソルを CURSOR_CHARS に足せば本 RegExp も自動追従)。
// ASCII `>` は素朴なフォールバック描画のために残す。
const OPTION_LINE_RE = new RegExp(`^\\s*[${CURSOR_CHARS}>]?\\s*\\d+\\.\\s`)

// タブバー行らしさの判定。印 2 個以上だけでは足りない: 選択肢テキストに
// `☐ x ☐ y ✔ Submit →` のような行を出力させると、それがタブバーとして採用され、
// 実バーの印が変わっても指紋が変わらない = 注入直前の「タブバー不変」ゲートが素通りする
// (レビューで実際に再現)。実 UI のタブバーは必ず `✔ Submit` を含み、選択肢行ではない。
function isTabBarLine(line) {
  if ((line.match(TAB_MARK_G) || []).length < 2) return false
  if (OPTION_LINE_RE.test(line)) return false
  return line.includes('Submit')
}

// フッタは表示領域の最下部付近にある。本文中に書かれた偽のフッタ文字列が「最終出現」に
// 化けるのは、実フッタが未描画 / 表示領域外のときに限られる。フッタより下に
// この行数(空行は数えない)を超える中身があれば、その画面は信用しない。
const FOOTER_BOTTOM_SLACK = 10
// フッタから上へ選択肢ブロックを探す範囲。フッタとの間にはヒント行のほか
// **最後の選択肢の折り返し行** も入る(コマンド行が折り返す実測がある以上、選択肢も折り返す)。
// 狭くすると実画面で選択肢ブロックを見失うが、見失っても下のフォールバックが効くだけで
// 安全性は変わらない(候補の数え上げが選択肢ブロックを含む方向 = 候補が増える方向)。
const OPTION_BLOCK_SCAN_LINES = 12

// フッタから上へ辿って選択肢ブロックの先頭行を返す(見つからなければ -1)。
// 連続する選択肢行だけを遡る。途中に非選択肢行(折り返しの続き等)が挟まればそこで止め、
// 窓を必要以上に上へ広げない。
function findOptionBlockTop(lines, bottom) {
  let last = -1
  for (let i = bottom - 1; i >= 0 && bottom - 1 - i <= OPTION_BLOCK_SCAN_LINES; i--) {
    if (OPTION_LINE_RE.test(lines[i])) {
      last = i
      break
    }
  }
  if (last < 0) return -1
  let top = last
  while (top - 1 >= 0 && OPTION_LINE_RE.test(lines[top - 1])) top--
  return top
}

// タブバーの同定。窓の中に候補がちょうど 1 本のときだけ「決まった」とみなす。
//   'tabbed'    候補 1 本 = 指紋 / タブ数 / 位置検証にこのバーを使ってよい
//   'ambiguous' 候補 2 本以上、またはフッタが下端から離れている = 実バーを決められない
//   'none'      候補 0 本
// ambiguous と none を分けるのは、呼び出し側で倒す方向が逆だから。ambiguous では
// 「キーを送らない」と「単一として登録しない」の **両方** に倒す必要がある。
//
// 窓を選択肢行ではなくフッタに束縛するのが要点。選択肢行はモデル生成 = 攻撃者が
// 位置を動かせるため、それをアンカーにすると実バーを窓の外へ追い出せる。
// フッタは CLI が描き、`parseDialog` が使うアンカーと同一。
function tabBarScan(lines) {
  const footIdx = findFooterIndex(lines)
  // フッタより下に残っている中身の行数。実測値をそのまま持ち回してログに出す
  // (E2E でフッタが表示領域のどこに来るかを測るための材料)。
  let below = 0
  if (footIdx >= 0) {
    for (let i = footIdx + 1; i < lines.length; i++) if (lines[i].trim() !== '') below++
    if (below > FOOTER_BOTTOM_SLACK) {
      return { state: 'ambiguous', indices: [], footIdx, below, reason: 'footer-not-at-bottom' }
    }
  }
  // フッタが無いテキスト(バー単体を渡す純関数テスト等)は末尾を下端に縮退させる。
  // 実画面では END_MARKER が無ければ parseDialog が null = 巡回にも注入にも入らない。
  const bottom = footIdx >= 0 ? footIdx : lines.length
  // 窓の上端は「選択肢ブロックの直上」。選択肢と prompt 本文はモデル生成なので、
  // 窓に含めると そこへ書いた行が候補になる。フッタから上へ選択肢ブロックを辿り、
  // その先頭より上だけを見る(下端 = CLI 由来のフッタに束縛したまま、中身は外す)。
  // 上端は切らない。「実バーの近くだけ見る」形にすると、prompt の行数(モデル生成)を
  // 伸ばして実バーを窓の外へ押し出し、窓内に偽バーを 1 本置くだけで なりすませる。
  // 下端より上を **全部** 数えれば、偽バーを足すと必ず 2 本になって fail-close する。
  // 実バーを候補から外すには表示領域ごと超える必要があり、そのときはダイアログ自体が
  // 読めない(parseDialog が成立しない)。
  //
  // 下端は選択肢ブロックの先頭。見つからなければフッタまで下げる。下げても候補が
  // 増える方向にしか動かない(選択肢本文の中の偽バーも候補になる = 曖昧になるだけ)
  // ので安全性は変わらず、選択肢ブロックを読めない画面で転送が全停止するのを避けられる。
  const optTop = findOptionBlockTop(lines, bottom)
  const anchor = optTop >= 0 ? optTop : bottom
  const indices = []
  for (let i = 0; i < anchor; i++) if (isTabBarLine(lines[i])) indices.push(i)
  const state = indices.length === 0 ? 'none' : indices.length === 1 ? 'tabbed' : 'ambiguous'
  const found = state === 'none' ? 'no-candidate' : state === 'tabbed' ? 'sole-candidate' : 'multiple-candidates'
  const reason = optTop >= 0 ? found : `${found}/no-option-block`
  return { state, indices, footIdx, below, reason }
}

// 画面がタブ式かを 3 値 + 理由付きで返す(キー送出の可否を決めるのは 'tabbed' だけ)。
//
// **残余リスク(既知・完全には塞げない)**: 窓の下端はフッタ = CLI 由来に束縛したが、
// prompt の行数はモデル生成なので、prompt を長くして実バーを窓の外へ押し出しつつ
// 窓内に偽バーを 1 本置く、という同定なりすましは理論上まだ成立する
// (旧実装でも同じ入力で成立することを実行で確認済み = 本設計で増えた穴ではない)。
// 完全に塞ぐには CLI が描く材料(セル反転属性)を必要条件にする必要があり、
// 反転属性が実際に使われるかは実機で未確認。ここでは fail-close(曖昧なら送らない)と
// フッタのヒント要求で悪用の敷居を上げるに留める。
function tabbedScreenScan(text) {
  // 巡回はキーを送るので、**CLI が描くフッタ**のタブ移動ヒントを必要条件にする。
  // これは isTabbedDialog の第 1 系統そのものなので、'tabbed' ならば粗い述語も真
  // という包含関係が構成で成立する(2 つの述語が食い違って「巡回はするが単一登録も
  // 許す」状態を作らない)。前段に isTabbedDialog を置くと同じ判定を二度回すだけになる。
  // これが無いと、通常の承認画面の会話ログへ偽バーを 1 行出すだけで巡回が起動し、
  // タブ式でないダイアログへ Tab / Shift+Tab が飛ぶ(かつ latch を消費して
  // その承認が転送されなくなる)。単一承認のフッタは "Esc to cancel" だけ。
  if (!hasTabNavFooter(text)) {
    return { state: 'none', indices: [], footIdx: -1, below: 0, reason: 'no-tab-nav-footer' }
  }
  return tabBarScan(String(text).split('\n'))
}

function tabbedScreenState(text) {
  return tabbedScreenScan(text).state
}

function findTabBarLine(text) {
  const lines = String(text).split('\n')
  const scan = tabBarScan(lines)
  return scan.state === 'tabbed' ? lines[scan.indices[0]] : null
}

// タブバーの各印に続く見出し(`← ☐ 食事タイプ ☐ 飲み物 ☐ 生活リズム ✔ Submit →` の
// 「食事タイプ」等)を配列で返す。末尾の印は `✔ Submit` なので落とす(expectedTabCount と同じ扱い)。
// 印だけの指紋では「タブ数も印も同じ別ダイアログ」を区別できず、先頭質問が似ていれば
// 旧回答が別の質問群へ注入されうるため、見出しを識別材料に足すのがこの関数の目的。
// 空の見出しは空文字のまま返す。null に倒すと指紋がラベル無しへ降格して識別力が落ち、
// 見出しを 1 つ空白にするだけで降格を起こせてしまう(長さ前置の符号化なので空でも決定的)。
function tabBarLabels(text) {
  return labelsFromBarLine(typeof text === 'string' ? findTabBarLine(text) : null)
}

// 確定済みのタブバー行から見出しを取り出す。**行を再スキャンしない** のが要点:
// 走査をやり直すと、見出しの文字列が終端マーカーに一致するだけで「バーが見つからない」
// 扱いになり、指紋がラベル無しへ降格する(実行で確認)。行が決まった後の処理は
// その行だけを見る。
function labelsFromBarLine(line) {
  if (!line) return null
  const at = []
  for (let i = 0; i < line.length; i++) if (TAB_MARK_CHARS.includes(line[i])) at.push(i)
  if (at.length < 2) return null
  const out = []
  // 最後の印は `✔ Submit`。質問ラベルだけを見るので末尾は落とす(expectedTabCount と同じ扱い)。
  for (let k = 0; k < at.length - 1; k++) {
    out.push(
      line
        .slice(at[k] + 1, at[k + 1])
        .replace(/\s+/g, ' ')
        .trim()
    )
  }
  return out
}

// タブバーの印の並びを「同一性の指紋」として返す(無ければ null)。
// フォントフォールバック(□ / ✓ / ⊠)は正規形へ畳み、描画環境の差では値が変わらないようにする。
// 一方 **未回答 ↔ 回答済み の変化では値が変わる** = PC 側で 1 問でも答えられたことを検出できる。
// これが注入直前の「タブバー不変」条件の実体。
function tabBarSignature(text) {
  const line = findTabBarLine(text)
  if (!line) return null
  const marks = (line.match(TAB_MARK_G) || [])
    .map((m) => (m === '□' ? '☐' : m === '✓' ? '✔' : m === '⊠' ? '☒' : m))
    .join('')
  const labels = labelsFromBarLine(line)
  if (!labels) return `m${marks.length}:${marks}`
  // ラベルは長さ前置で符号化する。単純に `|` で連結すると、ラベル自身が `|` を
  // 含むだけで別のタブ構成と同じ文字列になり(`a|b` + `c` と `a` + `b|c` が衝突)、
  // 「タブ数も印も同じ別ダイアログ」を見分けるという目的が崩れる。
  const encoded = labels.map((l) => `${l.length}:${l}`).join('|')
  return `ml${marks.length}:${marks}:${encoded}`
}

// タブバーから「質問タブの数」を返す(判定不能なら null = 呼び出し側は転送を諦める)。
// Submit も印を 1 個持つ(`✔ Submit`)ので、その 1 個を差し引く。Submit 直前に印が
// 見つからない形の UI は想定外として null(過少・過大に数えて半端登録するより安全)。
function expectedTabCount(text) {
  const line = findTabBarLine(text)
  if (!line) return null
  const submitIdx = line.lastIndexOf('Submit')
  if (submitIdx < 0) return null
  let marksBefore = 0
  let lastMarkIdx = -1
  for (let i = 0; i < submitIdx; i++) {
    if (TAB_MARK_CHARS.includes(line[i])) {
      marksBefore++
      lastMarkIdx = i
    }
  }
  // Submit 自身の印は "Submit" の直前にある(間は空白のみ)。
  if (lastMarkIdx < 0) return null
  if (line.slice(lastMarkIdx + 1, submitIdx).trim() !== '') return null
  const n = marksBefore - 1
  return n >= 1 ? n : null
}

// 巡回してよいのは「画面が落ち着いている」ときだけ。タブバーの指紋が連続して
// 何 tick 同じなら巡回してよいか。
//
// 印のどれが「回答済み」でどれが「フォーカス中」かは CLI の描画仕様で、実機で
// 確定していない(実測では触っていないダイアログでも先頭が ☒ で描かれた)。
// 絶対値で意味を決めつけると、判定を誤ったときに **転送が全面停止** する。
// 「動いたかどうか」なら意味を知らなくても分かり、ユーザーが操作していれば必ず動く。
const SWEEP_STABLE_TICKS = 2

// 未回答を表す印。これ以外の印(☒ ⊠ ✔ ✓)が質問タブに立っていれば回答済み。
const TAB_MARK_UNANSWERED = '☐□'

// タブバーに「回答済みに見える印」があるか。**観測専用で、判定には使わない**。
// 印のどれが「回答済み」でどれが「フォーカス中」かは実機で未確定(触っていない
// ダイアログでも先頭が ☒ で描かれた)。巡回の可否は指紋の変化で決める。
// この関数はログに残して、いつか印の意味を確定させるための材料。
function anyTabAnswered(text) {
  const line = findTabBarLine(text)
  if (!line) return false
  const submitIdx = line.lastIndexOf('Submit')
  if (submitIdx < 0) return false
  const marks = []
  for (let i = 0; i < submitIdx; i++) {
    if (TAB_MARK_CHARS.includes(line[i])) marks.push(line[i])
  }
  marks.pop() // 末尾は Submit 自身の印
  return marks.some((m) => !TAB_MARK_UNANSWERED.includes(m))
}

// 先頭タブへ戻すために送る Shift+Tab の上限。expected が読めないときは保守的な既定値。
const REWIND_STEPS_HARD_CAP = 12
function rewindStepsCap(expected) {
  const n = Number.isInteger(expected) && expected > 0 ? expected + 2 : 5
  return Math.min(n, REWIND_STEPS_HARD_CAP)
}

// 捕捉した全タブが互いにテキストで区別可能か。1 組でも見分けが付かないタブがあると、
// 「移動しても画面テキストが変わらない」ため位置をテキスト比較で証明できない。
// activeTabIndex が使えないときの注入可否ゲートとして使う。
function tabsMutuallyDistinct(tabs) {
  if (!Array.isArray(tabs) || tabs.length === 0) return false
  for (let i = 0; i < tabs.length; i++) {
    for (let j = i + 1; j < tabs.length; j++) {
      if (dialogShapeMatches(tabs[i], tabs[j])) return false
    }
  }
  return true
}

// 「選択中のタブ」は反転表示(セル属性)で描かれ、translateToString はテキストしか返さない
// ため、テキスト経路では読めない。表示領域のタブバー行をセル単位で読み、強調されている
// セル範囲を求めて「何番目のタブが選択中か」を返す。
// 全角ラベル(日本語)は 1 文字 2 セルなので、文字列 index ではなく **セルを歩いて**
// 位置を対応付ける(getWidth()===0 の後続セルは飛ばす)。
// 反転属性だけを強調とみなす。「既定でない背景色」まで拾うと、行全体に背景色が敷かれた
// 描画(SGR 44 等)で全セルが強調扱いになり、選択位置を常に 0 と誤読する。
// 反転で描かれない環境では null に倒れる = 呼び出し側の別ゲートへ落ちるだけで安全側。
function isHighlightedCell(cell) {
  try {
    if (typeof cell.isInverse === 'function' && cell.isInverse()) return true
  } catch (_) {}
  return false
}

// 表示領域からタブバー行をセル列として読む(見つからなければ null)。
function readTabBarRow(buffer, rows) {
  const scanned = []
  for (let y = buffer.baseY; y < buffer.baseY + rows && y < buffer.length; y++) {
    const line = buffer.getLine(y)
    if (!line) continue
    const cells = []
    let text = ''
    for (let x = 0; x < line.length; x++) {
      let cell
      try {
        cell = line.getCell(x)
      } catch (_) {
        cell = null
      }
      if (!cell) continue
      const w = typeof cell.getWidth === 'function' ? cell.getWidth() : 1
      if (w === 0) continue // 全角文字の後続セル
      const ch = cell.getChars() || ' '
      cells.push({ ch, hl: isHighlightedCell(cell) })
      text += ch
    }
    scanned.push({ text, cells, y })
  }
  // findTabBarLine と同じ窓・同じ一意性で選ぶ。ここだけ判定が違うと、テキスト側が
  // 拒否した行のセル属性を読んで index を出す、という食い違いが起きる。
  const scan = tabBarScan(scanned.map((r) => r.text))
  return scan.state === 'tabbed' ? scanned[scan.indices[0]] : null
}

// 選択中タブの index(0 起点、Submit はタブ数と同値)。判定できなければ null。
// **曖昧なら必ず null**(強調が無い / 強調が飛び飛び / 印より前で強調が始まる)。
// null のときは呼び出し側が tabsMutuallyDistinct のゲートへ倒す = 誤判定で注入しない。
function activeTabIndexFromRow(row) {
  if (!row || !Array.isArray(row.cells)) return null
  const hl = []
  for (let i = 0; i < row.cells.length; i++) if (row.cells[i].hl) hl.push(i)
  if (hl.length === 0) return null
  // 連続した 1 本の強調範囲でなければ判定不能(複数箇所が反転 = 想定外の描画)
  if (hl[hl.length - 1] - hl[0] + 1 !== hl.length) return null
  const runStart = hl[0]
  const cells = row.cells
  const isMark = (i) => i >= 0 && i < cells.length && TAB_MARK_CHARS.includes(cells[i].ch)
  const isSpace = (i) => i >= 0 && i < cells.length && /^\s*$/.test(cells[i].ch)

  // 強調 run が印を 2 個以上またいでいる = 行全体 / 複数タブに反転がかかった描画。
  // どのタブが選択中かは決められないので曖昧に倒す(誤った index を信じて注入しない)。
  let marksInRun = 0
  for (let i = hl[0]; i <= hl[hl.length - 1]; i++) if (isMark(i)) marksInRun++
  if (marksInRun >= 2) return null

  // 強調の起点をどの印に結び付けるかを決める。**単に「起点以前の印を数える」だけでは
  // 誤る**: 強調が印の 1 つ手前の余白から始まると 1 つ手前のタブを指し、逆にタブ 0 では
  // 数え上げが -1 になって読めなくなる。起点から空白だけを辿って隣接する印に届いた場合
  // にのみ対応付け、前後どちらにも届く / どちらにも届かないときは曖昧として null。
  let back = runStart
  while (isSpace(back - 1)) back--
  const backMark = isMark(runStart) ? runStart : isMark(back - 1) ? back - 1 : -1
  let fwd = runStart
  while (isSpace(fwd)) fwd++
  const fwdMark = isMark(runStart) ? runStart : isMark(fwd) ? fwd : -1
  let markAt = -1
  if (backMark >= 0 && fwdMark >= 0 && backMark !== fwdMark) return null // 両側に届く = 曖昧
  if (backMark >= 0) markAt = backMark
  else if (fwdMark >= 0) markAt = fwdMark
  if (markAt < 0) return null

  let idx = 0
  for (let i = 0; i < markAt; i++) if (isMark(i)) idx++
  return idx
}

// 実機でしか確かめられない前提を 1 回だけログに出す(巡回開始時)。
// 判定には一切使わない = 観測専用。ここで測る 3 点:
//   1. タブバー行が **セル反転属性で描かれるか**。描かれるなら、テキストに依存しない
//      「CLI が描いた行」の証拠になり、同定なりすましを構造的に閉じられる。
//   2. フッタが表示領域のどこに来るか(FOOTER_BOTTOM_SLACK の根拠)。
//   3. タブバー行が端末の折り返し(isWrapped)で割れているか、実改行か。
function logScreenFacts() {
  if (!headlessTerm) return
  try {
    const buf = headlessTerm.buffer.active
    const row = readTabBarRow(buf, headlessTerm.rows)
    const hl = row ? row.cells.filter((c) => c.hl).length : -1
    const lines = getViewportText().split('\n')
    const footIdx = findFooterIndex(lines)
    // バー行は index で引く。text 一致で探すと readTabBarRow の連結結果と
    // translateToString の結果が食い違って毎回 unknown になる。
    let wrapped = 'unknown'
    let styled = -1
    if (row && typeof row.y === 'number') {
      const next = buf.getLine(row.y + 1)
      wrapped = next ? (next.isWrapped ? 'wrapped' : 'not-wrapped') : 'no-next-line'
      // 選択タブが **背景色** で描かれているセル数(実機で反転は全セル 0 = 使われていない)。
      // **太字は数えない**: モデルが markdown の太字で書いた行が同じ属性を持つため、数えると
      // 会話ログ 1 行でゲートが通る(実機で太字 28 セル / 背景色 0 セルを観測)。
      // ゲート(barRowHasStyledCells)と同じ countStyledCells を共有する = 観測とゲートがずれない。
      styled = countStyledCells(buf.getLine(row.y))
    }
    wlog(
      `screen facts: barRow=${row ? 'found' : 'null'} highlightedCells=${hl} styledCells=${styled}` +
        ` activeTabIndex=${activeTabIndex()} footIdx=${footIdx} viewportLines=${lines.length}` +
        ` barRowWrapped=${wrapped} rows=${headlessTerm.rows} cols=${headlessTerm.cols}`
    )
    if (row) wlog(`screen facts: barRow text="${row.text.slice(0, 160)}"`)
  } catch (e) {
    wlog(`screen facts error: ${e.message}`)
  }
}

function activeTabIndex() {
  if (!headlessTerm) return null
  try {
    return activeTabIndexFromRow(readTabBarRow(headlessTerm.buffer.active, headlessTerm.rows))
  } catch (e) {
    wlog(`activeTabIndex error: ${e.message}`)
    return null
  }
}

// 1 行のうち **背景色が既定でない** セルの個数。
// 太字を数えないのは実測に基づく: モデルに markdown の太字で偽タブバーを出力させると
// その行は太字 28 セル / 背景色 0 セルになり(実機で確認)、太字を数えると会話ログの
// 1 行でゲートが通ってしまう。実機の本物のバー行は背景色 10〜14 セル / 太字 0 セルで、
// 背景色 0 のフレームは録画 2 本(cols=120 / 280)で 0 件だった。
// 反転(inverse)は実機で使われていない(highlightedCells=0 を実測)ので数えない。
function countStyledCells(line) {
  if (!line) return 0
  let n = 0
  for (let x = 0; x < line.length; x++) {
    let c = null
    try {
      c = line.getCell(x)
    } catch (_) {}
    if (!c) continue
    if (typeof c.isBgDefault === 'function' && !c.isBgDefault()) n++
  }
  return n
}

// 旧称 barRowIsCliDrawn(〜v1.20.0)。docs/attr-dump-*.md 等の測定記録は旧称のまま。
// タブバー候補行に **背景色セルがあるか** を返すだけの述語。名前に反して
// 「CLI が描いた行か」の判定ではなく、**安全な送信先であることの確認にもならない**
// (下記の反例 2 経路)。巡回も位置検証も PTY へキーを送るため、テキストだけを
// 根拠にするよりは絞れる、という位置づけに留まる。**認可の境界として再利用しないこと**。
//
// テキストだけを根拠にすると、モデルが会話ログへ「偽のタブバー + タブ移動ヒント付き
// フッタ」を書くだけで巡回が起動する(実ダイアログ非表示でも成立)。そのときキーは
// 通常の入力状態へ流れ、Shift+Tab は権限モードの切替に当たる(実行で確認: 印の個数を
// 変えると送出数が 8 / 12 / 22 と攻撃者側で選べた)。
//
// 実機測定(録画ログ再生、cols=120 rows=40 と cols=280 rows=51): CLI が描くバー行は
// 選択中タブを背景色で塗るため、背景色セルが 10〜14 個ある(太字は 0 個)。Submit の
// 確認画面でも同様。会話ログの行は 0 個。
//
// **限界**: モデルの出力に markdown の太字を混ぜると、その行は太字属性を持つ(実機で確認、
// 28 セル)。だから太字は数えない。
//
// **背景色セルの存在は「真正な CLI のタブバー UI 行」である証明にならない**。
// 本述語は真正なタブバー行と「背景色が付いた別の行」を区別できない(区別できないのは
// CLI ではなく、この述語を根拠に使う側)。測定した環境では、モデルが会話ログへ出した
// 素のテキスト / markdown 装飾だけでは通らなかったが、**同じ文字列でも背景色付きの行に
// 描かれれば通る**。反例 2 経路:
//   (a) コマンドの実行結果として生の SGR をそのまま画面へ通すと、その行に背景色が付く。
//       録画再生で readTabBarRow がその行を選び、本述語が 8 フレーム連続で true になった。
//       **中身を決めるのはモデル = 直接の攻撃面**。
//   (b) 生の SGR を使わなくても、CLI 自身がプロンプトのエコー行を背景色付きで描くため、
//       その行の文字列が isTabBarLine を満たすと本述語は true になる(10 フレームで観測)。
//       中身を決めるのは利用者なので攻撃面ではないが、上記の前提が崩れている反証になる。
// 測定環境は Claude Code 2.1.226 系 / WSL2 / TERM=xterm-256color / node v20 /
// @xterm/headless 6.0.0 の 1 つだけ。直接描画は Bash の printf 経由のみを試した。
// 他の制御列(DCS / C1 / BS 等)・他の tool 経由・他の CLI 版は未測定。
// **述語名が示唆する保証は無い**(実体は「背景色セルが 1 つ以上ある」でしかない)。
function barRowHasStyledCells() {
  if (!headlessTerm) return false
  try {
    const buf = headlessTerm.buffer.active
    const row = readTabBarRow(buf, headlessTerm.rows)
    if (!row || typeof row.y !== 'number') return false
    return countStyledCells(buf.getLine(row.y)) > 0
  } catch (e) {
    wlog(`barRowHasStyledCells error: ${e.message}`)
    return false
  }
}

// タブ式 UI の「1 回の出現」を単位に巡回を 1 回だけ許す latch の遷移(純関数)。
// state = { handled, absent } / ev = { tabbedNow, identityBroken, dialogEnded }
//   - handled: この出現に対して既に巡回を試みたか(成功・失敗・中断のいずれでも消費)
//   - absent : タブ式 UI が表示領域に見えなかった連続回数
// 解除(= 再び巡回可能)は 3 条件の OR:
//   1. 連続 EPOCH_ABSENT_TICKS 回見えない(出現が終わった)
//   2. ダイアログのライフサイクルが終了した
//   3. 同一性が切れた(見えているダイアログが登録済み tabs のどれとも一致しない)
// 1 だけにすると、長い再描画で同じ出現を巡回し直す一方、空白フレーム無しで次の質問が
// 出たときに巡回を抑止してしまう(両方向に誤る)。
const EPOCH_ABSENT_TICKS = 3
function nextEpoch(state, ev) {
  const prev = state || { handled: false, absent: 0 }
  const e = ev || {}
  if (!e.tabbedNow) {
    const absent = prev.absent + 1
    return absent >= EPOCH_ABSENT_TICKS ? { handled: false, absent } : { ...prev, absent }
  }
  if (e.identityBroken || e.dialogEnded) return { handled: false, absent: 0 }
  return { ...prev, absent: 0 }
}

// approval-server.js / approval-ui.html の同名定数と完全同期。
// Defense in depth として wrapper 側にも持つ(サーバ防御を信頼しすぎず、
// 注入直前の最後の関門で再検証)。
const FREE_TEXT_OPTION_RE = /^Type\s+something\.?$/i
const CHAT_ABOUT_RE = /^Chat\s+about\s+this\.?$/i

// codex のコマンド承認 option ラベル末尾に内包されるショートカット
// 文字を抽出する純関数。codex の承認 TUI は claude と異なり「番号 + Enter」型でなく
// カーソル(›)+ Enter / ショートカットキー(y/p/esc)型のため、番号を送ると末尾 Enter が
// 既定 option1(承認)を誤確定する(拒否のはずが承認 = 承認取り違えと同型)。これを避け、
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

// 抽出したショートカットを実際に PTY へ書き込むバイト列へ変換する純関数。
// esc → ESC(\x1b)、char → その文字そのもの。**末尾 \r は付けない**(char 自体が確定
// ショートカットのため。E2E で「Enter 必須」が判明したときに限り char にだけ \r を足す)。
// 抽出失敗(null)時は null を返し、呼び出し側は番号 + Enter にフォールバックせず注入を
// 行わない(reRegister に倒す)= 取り違えの再発防止の中核。
function resolveCodexInjection(optionLabel) {
  const sc = extractCodexShortcut(optionLabel)
  if (!sc) return null
  if (sc.kind === 'esc') return { bytes: '\x1b' }
  return { bytes: sc.char }
}

// codex の「コマンド承認」を「選択肢質問(AskUserQuestion)」と
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

// codex プランモード質問の「自由記入 option」(末尾 (tab))の番号(1-based)を
// 返す純関数。codex は `None of the above … (tab)` を選び Tab を押すと notes 入力欄が開く。この
// option をスマホで自由記入可にするため、wrapper が detectDialog 時に番号を算出し /request で server
// へ宣言する(識別 SoT = 本関数 1 箇所、ラベル文字列依存をここに集約。server/UI は宣言を信頼するだけ)。
// extractCodexShortcut が (tab) に null を返す(:960)ため command 承認 (y)/(p)/(esc) とは構造的に交わらない。
// 末尾の `[.\s]*` は codex 実レンダリング `… notes (tab).`(末尾ピリオド)を許容するため
// (E2E 2026-06-29 で発覚: `\(tab\)\s*$` だと末尾ピリオドで不一致 → 自由記入未宣言の実バグ)。
const CODEX_FREE_TEXT_OPTION_RE = /\(tab\)[.\s]*$/i
function codexFreeTextOptions(options) {
  if (!Array.isArray(options)) return null
  const out = []
  for (let i = 0; i < options.length; i++) {
    if (CODEX_FREE_TEXT_OPTION_RE.test(String(options[i]))) out.push(i + 1)
  }
  return out.length > 0 ? out : null
}

// 選択肢行(行頭の任意カーソル + 数字 1-9 + 区切り . / ))の最初の出現。カーソル文字集合は
// 他の派生 RegExp(CURSOR_NUM_RE 等)と同様に CURSOR_CHARS から生成し drift を避ける
// (新 CLI のカーソルを CURSOR_CHARS に足せば本 RegExp も自動追従)。
const CODEX_OPTION_LINE_RE = new RegExp(`(?:^|\\n)[ \\t]*[${CURSOR_CHARS}]?[ \\t]*[1-9][.)]`)
// 同じ判定の行単位版。「どの行で選択肢ブロックが始まるか」を知りたい側が使う
// (文字列 index ではなく行 index が要る場面がある)。パターンは上と同一に保つ。
const CODEX_OPTION_LINE_ONLY_RE = new RegExp(`^[ \\t]*[${CURSOR_CHARS}]?[ \\t]*[1-9][.)]`)

// codex プランモードの選択肢質問は丁寧形(「…ください。」等)で末尾に
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
// 表示と実際の承認内容が食い違う(承認取り違え)。確証できなければ空文字(呼び出し側が承認可能化を
// 抑止 = 取り違え秘匿側の fail-safe)。
// コマンド行は端末幅で複数行に割れる。1 行目だけを採ると **危険な後半が承認画面から
// 消える**(実測 cols=80: `echo "..." && rm -rf ~/important` の後半が落ちた)。
// claude 側 prompt を expandPromptStart が連結しているのと同じ考え方で、構造境界まで
// 後続行を連結する。上限は表示の暴走を止めるためだけのもので、超えた分は … で示す。
const CODEX_CMD_LINE_RE = /^\s*\$\s+(.+)$/
const CODEX_CMD_MAX_JOIN_LINES = 5
// 読み取ったコマンド本文の上限(codex の `$` 行 / claude の承認枠 で共用)。表示枠
// (DESC_MAX_LEN)とは別物で、こちらは **同一性の値** でもある = 無印で切ると別コマンドが
// 同じ値に潰れる。超えたら印を付け、印が付いた本文は転送しない。
const CMD_TEXT_MAX_LEN = 500
// 打ち切りの印。表示上の省略(buildDescription の ARGS_OMITTED_MARK)とは別物として扱う
// ため 1 箇所に置く。この印が付いた本文は転送しない = スマホには決して出ない。
const CMD_TRUNCATION_MARK = '…'
// 打ち切ったかどうかは **状態で返す**(値の中の文字で表さない)。`…` は本文にも普通に現れる
// (CLI が箱の説明行を省略表示するときに使う)ので、`endsWith('…')` で判定すると
// 正常な承認箱が丸ごと転送されなくなる(実行で確認)。
function truncateCommandText(text) {
  const s = String(text)
  return s.length > CMD_TEXT_MAX_LEN
    ? { text: s.slice(0, CMD_TEXT_MAX_LEN) + CMD_TRUNCATION_MARK, truncated: true }
    : { text: s, truncated: false }
}

// parseDialog は PTY チャンクごと・400ms tick・巡回中の 80ms ポーリングからも呼ばれるので、
// 同じ画面が出ているあいだログを書き続けないよう直近のキーで抑える(logSweepSkip と同じ考え)。
// 理由 code は 3 つとも claude / codex の両経路で立ちうるので、文言に CLI 名を入れない。
const UNFORWARDABLE_REASON = {
  truncated: 'コマンド本文が打ち切られている',
  'empty-target': '対象が空のツール承認',
  'codex-unreadable': 'codex コマンド本文を読み切れない',
  'unknown-tool': '未知のツール種別の承認枠',
}
let lastUnforwardableKey = null
function logUnforwardableOnce(code, args) {
  const key = `${code}:${args.length}:${args.slice(0, 40)}`
  if (key === lastUnforwardableKey) return
  lastUnforwardableKey = key
  wlog(`承認可能化しない(${code}: ${UNFORWARDABLE_REASON[code] || code}, len=${args.length})`)
}
function extractCodexCommand(segment, qIdx) {
  const s = String(segment)
  const after = s.slice((qIdx | 0) + 1)
  const lines = after.split('\n')
  // 選択肢ブロックの開始行(ここから下は本文ではない)。行単位で持つのは、
  // 「どこで切ったか」を連結ループ側が知る必要があるから。文字列を先に切ると、
  // 切断が起きた事実がループに伝わらず **無印の打ち切り** になる。
  let optIdx = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (CODEX_OPTION_LINE_ONLY_RE.test(lines[i])) {
      optIdx = i
      break
    }
  }
  let head = -1
  for (let k = 0; k < optIdx && head < 0; k++) {
    if (CODEX_CMD_LINE_RE.test(lines[k])) head = k
  }
  if (head < 0) return { text: '', truncated: false }
  const parts = [lines[head].match(CODEX_CMD_LINE_RE)[1]]
  // 打ち切りは **必ず可視にする**。印を付けずに切ると、承認画面には完結した無害な
  // コマンドだけが見えて危険な後半が消える(承認取り違え)。自然な終わりだけを無印にする。
  let truncated = false
  for (let k = head + 1; k <= optIdx && k < lines.length; k++) {
    if (k === optIdx) {
      // 選択肢ブロックに到達。実 UI の選択肢は必ず 1 から始まる(parseDialog の
      // 完全性ガードが {1..N} を要求するのと同じ不変条件)。1 で始まらない行で
      // 切れた場合は、コマンドの続きが選択肢に見えているだけ = 打ち切り。
      if (!/^[^\d]*1[.)]/.test(lines[k])) truncated = true
      break
    }
    const line = lines[k]
    if (line.trim() === '') {
      // 空行はコマンドブロックの自然な終わり。ただし選択肢ブロックまでの間に
      // まだ中身が残っているなら、表示していない本文があるということなので印を付ける。
      for (let j = k + 1; j < optIdx; j++) {
        if (lines[j].trim() !== '') {
          truncated = true
          break
        }
      }
      break
    }
    if (CODEX_CMD_LINE_RE.test(line) || line.includes(BULLET_CHAR)) {
      truncated = true
      break
    }
    if (parts.length >= CODEX_CMD_MAX_JOIN_LINES) {
      truncated = true
      break
    }
    parts.push(line)
  }
  // 内部の連続空白を 1 個に畳み、行末の余白を除去(罫線描画由来の trailing space 対策)。
  // 印を付けてから 1 回だけ上限に通す(順序を逆にすると印のぶん 1 字はみ出す)。
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim()
  const marked = truncated ? joined + CMD_TRUNCATION_MARK : joined
  const clipped = truncateCommandText(marked)
  return { text: clipped.text, truncated: truncated || clipped.truncated }
}

// 画面が codex の複数質問フロー(Question N/M, M>1)かを判定する純関数
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

// 画面に見えている最新(最後)の "Question N/M" の N と M を返す純関数。
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
    // defense in depth: Chat about this を指す回答は遠隔不能
    if (CHAT_ABOUT_RE.test(selectedOpt)) return null
    if (rawText !== undefined) {
      // defense in depth: text 添付は Type something 限定
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
    findLastToolLine,
    buildDescription,
    sameDialogIdentity,
    sameOptions,
    strictDialogIdentity,
    codexFreeTextOptions,
    isCodexMultiQuestion,
    codexQuestionPos,
    codexMultiKeySequence,
    // タブ巡回の 1 回化 / 完全性ゲート / 注入前の位置検証
    findTabBarLine,
    tabBarScan,
    tabbedScreenState,
    tabbedScreenScan,
    hasTabNavFooter,
    isReviewScreenText,
    isTabbedUiOfDialog,
    isExitPlanScreen,
    isExitPlanFooter,
    tabBarSignature,
    tabBarLabels,
    anyTabAnswered,
    safeIdPath,
    expectedTabCount,
    rewindStepsCap,
    tabsMutuallyDistinct,
    activeTabIndexFromRow,
    readTabBarRow,
    nextEpoch,
    dialogShapeMatches,
    dialogStillMatchesForInject,
    classifyStdinDuringSweep,
    EPOCH_ABSENT_TICKS,
    REWIND_STEPS_HARD_CAP,
    SWEEP_STABLE_TICKS,
    DISMISSAL_MS,
    // 状態機械テスト用のシーム。実行時には使わない(spawnClaude 経路が
    // term / headlessTerm を設定する)。承認取り違え防止の不変条件は純関数だけでは
    // 固定できないため、巡回と注入を偽 TUI に対して回せるようにする。
    __test: {
      setTerm: (t) => {
        term = t
      },
      setHeadlessTerm: (h) => {
        headlessTerm = h
      },
      setCurrentDialog: (d) => {
        currentDialog = d
      },
      getCurrentDialog: () => currentDialog,
      resetSweepState: () => {
        barSigFirst = null
        barSigStable = 0
        lastSweepSkipKey = null
        sweepAborted = false
        abortSettleUntil = 0
        tabSweepInProgress = false
        tabReplayInProgress = false
        forwardTabDebt = 0
        stdinBuffer.length = 0
        tabbedEpoch = { handled: false, absent: 0 }
        dialogLifecycleEnded = false
        // 前のケースが張った抑制窓を持ち越すとゲートが素通りし、テストが
        // 「通ったつもり」になる(巡回しなかったのを latch の効果と誤読する)。
        suppressedPrompt = null
        // notice 状態も前のケースから持ち越さない(cooldown / TTL / 差替時計が
        // 次のケースへ漏れると「発行できたはずが cooldown で握りつぶされた」等の
        // 誤判定になる)。
        if (activeNotice && activeNotice.timer) clearTimeout(activeNotice.timer)
        activeNotice = null
        lastNoticeAtMono = null
        noticeMonoNowImpl = () => performance.now()
      },
      // latch は純関数 nextEpoch だけでは固定できない(欠陥は ev を組み立てる
      // 呼び出し側にあった)。検出 tick そのものを回せるようにする。
      detectTick: () => detectDialogInner(),
      getEpoch: () => ({ ...tabbedEpoch }),
      // 実サーバーへ出て行かせないための差し替え口。テストは必ずこれを張る。
      setHttpStub: (fn) => {
        httpRequestImpl = fn
      },
      endDialogLifecycle: () => {
        dialogLifecycleEnded = true
      },
      handOverToPc: (...a) => handOverToPc(...a),
      // 抑制窓は時間で切れるため、latch 単体の振る舞いを見るときは外して確かめる
      clearSuppression: () => {
        suppressedPrompt = null
      },
      sweepTabs: (...a) => sweepTabs(...a),
      rewindToFirstTab: (...a) => rewindToFirstTab(...a),
      replayMultiAnswers: (...a) => replayMultiAnswers(...a),
      handleResolvedResponse: (...a) => handleResolvedResponse(...a),
      // 借りは wrapper 内部変数(外から作れない)。借りが絡む分岐の試験でだけ直接置く。
      setForwardTabDebt: (n) => {
        forwardTabDebt = n
      },
      shiftTabBlockedReason: (...a) => shiftTabBlockedReason(...a),
      tabBarSignature: (...a) => tabBarSignature(...a),
      pipeStdinToTerm: (...a) => pipeStdinToTerm(...a),
      getScreenText: () => getScreenText(),
      getViewportText: () => getViewportText(),
      activeTabIndex: () => activeTabIndex(),
      // 偽端末が「CLI が描いた行」を再現できているかをテスト側で前提固定するための口。
      barRowHasStyledCells: () => barRowHasStyledCells(),
      // PC 操作誘導 notice のテスト用シーム。
      postPcNotice: (...a) => postPcNotice(...a),
      clearNotice: (...a) => clearNotice(...a),
      getActiveNotice: () => activeNotice,
      setNoticeMonoNow: (fn) => {
        noticeMonoNowImpl = fn
      },
      getNoticeConstants: () => ({ NOTICE_COOLDOWN_MS, NOTICE_TTL_MS }),
      sanitizeLogMessage: (s) => sanitizeLogMessage(s),
      clampRequestTimeoutMs: (ms) => clampRequestTimeoutMs(ms),
    },
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
//   - 巡回中の PC 入力は「巡回を中断して破棄」。
//     再生(replay)中はバッファ → 完了後に flush。
//
// 注入する制御コード(Tab/Shift-Tab/Enter)は wrapper 内部生成のみ。
// HTTP 経路から任意の制御コードが流れ込まないよう validateMultiAnswer で
// 数字のみを許可する。

let tabSweepInProgress = false
let tabReplayInProgress = false
// 巡回で右へ送った前送りキーのうち、まだ戻していない分(= 自分が作った「借り」)。
// 戻る一手を許す根拠をこれにする。画面の文言(CLI の英語表示)を根拠にすると、
// 文言変更・非英語ロケールで静かに解錠されなくなり、**戻れないまま右に残る**という
// 同じ事故が別の入口から再発する。借りは自分のカウンタなので、なりすましようがない。
let forwardTabDebt = 0
const stdinBuffer = []

// 巡回中に PC 側で操作されたら巡回を即中断する。
// 中断後も「整定窓」の間は確定系の入力を捨てる: wrapper が既に送った Tab は取り消せず、
// その直後に届いた Enter は **移動先のタブ** で確定してしまう(別の質問に勝手に答える事故)。
// 捨てるのは最大 1 打鍵で、巡回はもう止まっているので押し直せば正常に効く。
let sweepAborted = false
let abortSettleUntil = 0
const ABORT_SETTLE_MS = 300

// -------------------------------------------------------
// PC 操作誘導 notice(rewind 失敗時)
// -------------------------------------------------------
// notice は承認ではない = 注入経路に絶対に接続しない。スマホへ「PC で操作して」の
// 情報カードを出すだけ。
//   activeNotice: null / 予約オブジェクト(発行ごとに new した一意の参照)
//                 / { id: 実ID文字列, timer: TTL タイマー(unref 済み) }
//                 timer を別変数にせず実 ID 状態のフィールドで持つ = 「対で保持する」規約を
//                 コメントでなく構造で保証する(片方だけ更新する事故を型的に不可能にする)
//   lastNoticeAtMono: 単調時計値。POST 失敗でも戻さない(失敗連打も抑止する)
let activeNotice = null
let lastNoticeAtMono = null
const NOTICE_COOLDOWN_MS = 60_000
const NOTICE_TTL_MS = 30 * 60 * 1000
const NOTICE_HTTP_TIMEOUT_MS = 5000
// テストから差し替え可能にする(実行時は performance.now() をそのまま使う)。
let noticeMonoNowImpl = () => performance.now()

// 制御文字・双方向制御文字(LRM/RLM/LRE-PDF/LRI-PDI 等)をログへ流さない無害化。
// notice 経路の catch でのみ使う(POST 失敗メッセージは相手サーバー由来の任意文字列)。
function sanitizeLogMessage(s) {
  return String(s)
    .replace(/[\x00-\x1f\x7f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
    .slice(0, 200)
}

// 同期関数(await なし)。判定と予約を同一同期区間で行うことで、check-then-act 競合を
// 構造的に不成立にする(async 関数内で await をまたぐと、その間に別呼出が同じ条件を
// 通り抜けうる)。
function tryReserveNotice(reservation, nowMono) {
  if (activeNotice !== null) return false // reservation / 実ID とも発行中扱い
  if (lastNoticeAtMono !== null && nowMono - lastNoticeAtMono < NOTICE_COOLDOWN_MS) return false
  lastNoticeAtMono = nowMono // 予約は失敗でも戻さない
  activeNotice = reservation
  return true
}

async function postPcNotice(reason) {
  const reservation = { kind: 'notice-reservation' } // 参照同一性が鍵(固定 sentinel 禁止 = ABA 対策)
  if (!tryReserveNotice(reservation, noticeMonoNowImpl())) return
  try {
    const resp = await httpRequest('POST', '/request', { kind: 'notice', reason }, NOTICE_HTTP_TIMEOUT_MS)
    if (!(resp && safeIdPath(resp.id))) throw new Error('invalid notice id') // 保存前検証
    if (activeNotice === reservation) {
      const timer = setTimeout(() => clearNotice(resp.id, 'notice ttl'), NOTICE_TTL_MS)
      timer.unref?.()
      activeNotice = { id: resp.id, timer }
    } else {
      // 発行中にクリアされていた(補償): 孤児 notice を即時回収する。
      resolveStaleRegistration(resp.id, 'notice cancelled while in flight', NOTICE_HTTP_TIMEOUT_MS)
    }
  } catch (e) {
    wlog(`pc notice post failed: ${sanitizeLogMessage(e && e.message)}`)
  } finally {
    if (activeNotice === reservation) activeNotice = null // 自分の予約だけ解除
  }
}

// 全クリア経路共通(TTL / タブ UI 消失 / テスト)。捕捉した実 ID とだけ比較する。
function clearNotice(capturedId, why) {
  if (activeNotice && activeNotice.id === capturedId) {
    clearTimeout(activeNotice.timer)
    activeNotice = null
  }
  resolveStaleRegistration(capturedId, why, NOTICE_HTTP_TIMEOUT_MS) // 内部 catch 完備の既存関数
}

// 巡回中 / 整定窓中の stdin chunk の扱いを決める純関数。
//   - chunk 全体が単独の Ctrl-C / 単独の Esc → そのまま通す(中断操作であって確定ではない)
//   - 混在 chunk → **Ctrl-C だけ** 抜き出して通し、残りは破棄
//     (Esc を混在から抜き出さないのは、`\x1b[A` 等の矢印キーの一部を単独 Esc として
//      送るとダイアログ全体をキャンセルしてしまうため)
//   - それ以外 → 全破棄
// `\x1b` を含むというだけで chunk 全体を通すと `\x1b\r` の \r まで通り、誤確定防止が破れる。
function classifyStdinDuringSweep(data) {
  const s = String(data)
  if (s === '\x03' || s === '\x1b') return { forward: s, dropped: 0 }
  let forward = ''
  for (const ch of s) if (ch === '\x03') forward += ch
  return { forward, dropped: s.length - forward.length }
}

function pipeStdinToTerm(data) {
  // 注入(スマホ回答の再生)中は従来どおりバッファ。途中で止めると番号列がずれて
  // 別の選択肢を確定させるため、ここは意図的に非対称のままにする。
  if (tabReplayInProgress) {
    stdinBuffer.push(data)
    return
  }
  if (tabSweepInProgress) {
    if (!sweepAborted) {
      sweepAborted = true
      abortSettleUntil = Date.now() + ABORT_SETTLE_MS
      wlog('tab sweep aborted by local input')
    }
    const { forward, dropped } = classifyStdinDuringSweep(data)
    if (dropped > 0) wlog(`local input dropped during sweep: ${dropped} byte(s)`)
    if (forward) term.write(forward)
    return
  }
  if (Date.now() < abortSettleUntil) {
    const { forward, dropped } = classifyStdinDuringSweep(data)
    if (dropped > 0) wlog(`local input dropped in abort settle window: ${dropped} byte(s)`)
    if (forward) term.write(forward)
    return
  }
  term.write(data)
}

// 巡回と位置検証が PTY へナビゲーションキーを書くための経路。中断後は書かない。
// 注入(replay)経路はこれを通さない: 番号列を途中で止めると別の選択肢を確定させるため、
// 中断で打ち切ってよいのは「まだ何も確定していない」巡回・検証だけという非対称が要る。
// 戻り値 false = 中断済みなので書かなかった(呼び出し側は即座に諦める)。
function writeKey(bytes) {
  if (sweepAborted) return false
  term.write(bytes)
  return true
}

// この画面で Shift+Tab を送ってよいか。**巡回を始めてよいかの判断もこれを使う**。
// 開始判断と送出判断で別の述語を使うと、開始できるのに戻れない画面で前送りだけが
// 通り、右へ押し切ったまま戻れない状態になる(片方向のガードを作らない)。
// 戻り値は理由つき: 呼び出し側が「なぜ送れないか」をログに残せるようにする。
// 送ってよいのはタブ式ダイアログの巡回・位置検証だけで、それは **CLI が描くフッタの
// タブ移動ヒント** で確かめる。終端マーカーの有無で代用すると、会話ログに
// `Esc to cancel` が 1 行あるだけで恒久的に真になり fail-close として機能しない。
// `debtReturnOk` = 「自分が右へ押した借りを返す一手」を許すか。**巡回の開始判定では false**。
//   非対称は意図的で、向きが重要 — 開始が送出より **厳しい** のは安全(始まらないだけ)。
//   逆に開始が緩いと「開始できるのに戻れない」= フォーカスが Submit に残る事故になる。
function shiftTabBlockedReason(viewport, { debtReturnOk = false } = {}) {
  if (isExitPlanScreen(viewport)) return 'ExitPlanMode (承認確定キーのため送らない)'
  // **借りを返す戻り一手は属性ゲートより先に見る**。属性ゲートを先に置くと、確認画面で
  // バー行の背景色が読めないときに戻り道へ到達できず、未回答のままフォーカスが Submit に
  // 残る(実測の回帰)。借りは wrapper 内部変数で外から作れないうえ、送るのは自分が押した分を
  // 返す一手だけなので、ここに CLI 描画の証明を要求する必要がない。
  //
  // **終端マーカー不在の条件を外さないこと**。バー行の有無だけを条件にすると、
  // それは会話ログの 1 行でも成立する(モデル生成テキストで作れる)ので、巡回中に
  // 画面が通常の承認ダイアログへ差し替わったとき、そこへ Shift+Tab が飛ぶ。
  // 通常の承認画面ではその一手が「このセッションの編集をすべて許可」= 承認ゲートを
  // 無人で外す操作になる(実測: この条件が無いと差替後の画面へ 3 本送出、HEAD は 0 本)。
  // 条件は **終端マーカーが 1 つも見えないこと**。「`parseDialog` で読めない」を条件にすると
  // 弁別にならない: 実在する承認画面でも、5b 完全性ガードに掛かるフレーム(重畳描画で同じ
  // 番号が二重に出る等)は読めないので偽になる(実行で再現)= そこへ Shift+Tab が飛ぶ。
  // 確認画面は構造上そこに終端マーカーを持たず、承認画面は必ず持つので、こちらで弁別する
  // (終端マーカーが無ければ parseDialog も必ず null なので、読めるか否かの条件は要らない)。
  if (
    debtReturnOk &&
    forwardTabDebt > 0 &&
    findTabBarLine(viewport) !== null &&
    findFooterIndex(viewport.split('\n')) === -1
  ) {
    return null
  }
  // フッタも終端マーカーも画面テキストなので、実ダイアログが 1 つも出ていない場面では
  // モデルが会話ログに書いた行がそのまま「フッタ」になる(実行で確認)。テキストで
  // 相手を確かめられない以上、**CLI が描いた行かどうか**を要求する。
  // viewport 引数だけでなく現在のバッファを読む点に注意(テキストには属性が無いため)。
  if (!barRowHasStyledCells()) return 'タブバーが CLI 描画でない(会話ログの偽バーと区別できない)'
  if (hasTabNavFooter(viewport)) return null
  return 'タブ式のフッタが無い(送ってよい画面か確認できない)'
}

// 前送りキーの出口。借りの増減を Shift+Tab 側と隣り合わせに置く(離れていると
// 対で直すべき箇所を片方だけ直す事故になる)。増えるのは実際に送れたときだけ。
function writeForwardTab() {
  const sent = writeKey('\t')
  if (sent) forwardTabDebt++
  return sent
}

const SHIFT_TAB = '\x1b[Z'
// Shift+Tab の **唯一の出口**。ExitPlanMode ではこのキーが承認確定なので、
// 呼び出し側ごとにガードを置くと 1 箇所の漏れがそのままプランの無人承認になる。
// 出口を 1 本にして、ここで種別を確かめてから書く(出口が 1 本であること自体は
// テスト [S12] がソースに対して固定している)。
function writeShiftTab() {
  const viewport = getViewportText()
  const blocked = shiftTabBlockedReason(viewport, { debtReturnOk: true })
  if (blocked) {
    wlog(`shift+tab suppressed: ${blocked}`)
    return false
  }
  const sent = writeKey(SHIFT_TAB)
  // 巡回開始前の戻しは自分の借りではないので、負にしない(0 で止める)。
  if (sent && forwardTabDebt > 0) forwardTabDebt--
  return sent
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
    if (sweepAborted) return null // ローカル入力で中断 → 以降のキーを打たない
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

// Shift+Tab を送って先頭タブ(タブ 1)へフォーカスを戻す。
// 回数は固定値にしないこと。画面から数えた質問数に応じて決め、中断されたら途中で止める。
// 固定回数(かつてこれは 3 回だった)にすると、質問タブ 4 個 + Submit のような構成で
// 戻り切らず、巡回開始位置がずれてタブが漏れる / 注入位置が 1 個ずれる。
// 戻れたかどうかを返す。呼び出し側が結果を見ずに前進すると、開始位置がずれたまま
// 巡回して Submit まで踏み抜く / 最終位置がずれたまま登録する、という片方向の事故になる。
async function rewindToFirstTab(steps) {
  const n = Number.isInteger(steps) ? steps : rewindStepsCap(expectedTabCount(getViewportText()))
  let sent = 0
  for (let i = 0; i < n; i++) {
    if (!writeShiftTab()) break
    sent++
    await sleep(50)
  }
  if (sent < n) wlog(`rewind: ${sent}/${n} 回しか送れなかった`)
  // 意味は「n 回とも送れた」であって「先頭に着いた」ではない(到達の確認は
  // verifyAtFirstTab が注入直前に別途行う)。ここで見たいのは、右へ押した分を
  // 戻し切れたか = 片方向の状態を残していないか。
  return sent === n
}

// 現在の dialog から Tab で順送りしながら各タブを収集する。
// 1 周完了の判定は「先頭タブと一致」または「直前タブと一致(Submit にフォーカスが
// 移って Tab で動かなくなった状態)」のいずれか。
// 収集数がタブバーから数えた期待値と **完全一致** しない限り null を返す。
// codex 側 sweepCodexQuestions は既に `tabs.length !== total` で捨てていた(取り違え対策)のに、
// claude 側は `tabs.length >= 2` で登録していた = 非対称だった。半端な登録は
// 「回答列と Submit が別の位置に注入される」事故に直結するので、揃わなければ転送しない。
async function sweepTabs() {
  tabSweepInProgress = true
  sweepAborted = false
  const t0 = Date.now()
  try {
    // 期待質問数はタブバーから先に読む(巡回でフォーカスが動いても印の個数は不変)。
    const expected = expectedTabCount(getViewportText())
    if (!expected || expected < 2) {
      wlog(`tab sweep skipped: expected=${expected === null ? 'unknown' : expected}`)
      return null
    }
    // 巡回の直前に指紋を 1 回だけ読み、開始判断の時点から動いていないことを確かめる。
    // 呼び出し側にも同じ比較があるが、そちらは identityBroken 分岐の
    // `await resolveCurrentAsCli()` より前に読んだ値で、await をまたいで古くなりうる。
    // ここで読む値だけが「これから巡回する画面」のもので、戻り値の barSig にもこれを使う
    // (巡回した画面と、注入前に照合する指紋を同一の観測に束ねる)。
    const viewportAtSweep = getViewportText()
    const barSig = tabBarSignature(viewportAtSweep)
    // 見出し列は回答しても変わらない(変わるのは印だけ)ので、「このバーはこの依頼のものか」
    // の鍵に使える。生存判定で同一性を確かめるために持ち帰る。
    const barLabels = tabBarLabels(viewportAtSweep)
    if (barSig !== null && barSigFirst !== null && barSig !== barSigFirst) {
      wlog(`tab sweep aborted: 直前にタブバーが動いた (was="${barSigFirst}" now="${barSig}")`)
      return null
    }
    wlog(`tab sweep start: expected=${expected}`)
    logScreenFacts()

    // 巡回開始前にフォーカスを先頭タブに戻す。初期フォーカスがタブ 2 等に
    // あると、Tab で右回りに巡回して Submit に到達した時点で break してしまい、
    // 戻る側のタブ(タブ 1 等)が漏れるため。
    const rewindSteps = rewindStepsCap(expected)
    const sentAllRewind = await rewindToFirstTab(rewindSteps)
    if (sweepAborted) return null
    // 戻せていないのに前送りを始めると、開始位置がずれたまま右へ押し切る。
    // 「右へは進めるが左へは戻れない」状態を作らないため、ここで止める。
    if (!sentAllRewind) {
      wlog('tab sweep: 先頭へ戻せなかったので巡回しない')
      return null
    }
    // 戻し後の再描画が安定するまで待つ
    await waitTabStable(400)
    if (sweepAborted) return null

    const first = parseDialog(getScreenText())
    if (!first) {
      wlog('tab sweep: rewind 後に先頭タブを読めない')
      return null
    }
    const tabs = [first]
    // 回数は expected ちょうど。**「これ以上タブが無い」ことの唯一の証明が
    // Submit への到達**なので、踏まない設計にはできない(踏まないと収集数の上限が
    // expected に張り付き、下の完全性ゲートが「一致」しかしなくなる = 過少読みのとき
    // 半端登録を通してしまう。タブバーは折り返すと 2 行目だけが候補になり、
    // 折り返し位置を決めるのはモデル生成の見出し長 = 過少読みは攻撃者側に寄せられる)。
    // 踏むことを許すかわりに、**帰り道を保証する**(下の rewind 検査と、確認画面から戻る借り)。
    //
    // 収集数だけでは足りない。打ち切りの理由まで見ないと、過少読みと正常終了が同じ
    // 観測になる: 収集数は「何回目で打ち切ったか」で決まるので、**最終ステップで
    // 形状衝突により打ち切った**ケースは、正常終了(Submit に着いて読めなくなった)と
    // 区別できない。prompt はモデル生成で、一致判定は部分列 85% の緩い比較なので、
    // 後ろの質問を先頭の質問に似せるだけで衝突は起こせる。
    // よって転送してよいのは「読めなくなって打ち切った」場合だけに限る。
    let endedBy = null
    for (let i = 0; i < expected; i++) {
      if (!writeForwardTab()) return null
      // 前のタブの prompt + options 長さを渡し、再描画未完了の中間状態を
      // 安定判定から除外する(部分描画・文字欠けでも promptSimilar で類似判定)。
      const last = tabs[tabs.length - 1]
      const next = await waitTabStable(600, last.prompt, last.options.length)
      if (sweepAborted) return null
      // 打ち切りの理由を残す。理由が分からないと「何タブ取れたか」しか分からず、
      // 転送されない原因(移動していない / 読めない / 誤一致)を切り分けられない。
      if (!next) {
        endedBy = 'unreadable'
        wlog(`tab sweep: step ${i + 1} で読めない(captured=${tabs.length})`)
        break
      }
      if (dialogShapeMatches(next, tabs[0])) {
        endedBy = 'wrapped'
        wlog(`tab sweep: step ${i + 1} が先頭タブと一致(captured=${tabs.length})`)
        break
      }
      if (dialogShapeMatches(next, last)) {
        endedBy = 'stuck'
        wlog(`tab sweep: step ${i + 1} が直前タブと一致 = 動いていない(captured=${tabs.length})`)
        break
      }
      tabs.push(next)
    }
    // **戻す前に**見ること(戻した後は先頭タブに居るので常に偽になる)。
    // `endedBy === 'unreadable'` は「読めなかった」だけで「Submit に着いた」証明ではない。
    // バー折り返しで expected が過少に読まれ、かつその回の前送り先がたまたま読めないと、
    // 数が揃ったまま半端登録が通る(PoC で再現)。到達の証拠を別に要求する。
    // 文言の一致だけを証拠にすると、**証拠そのものがモデル生成テキストで作れる**
    // (過少読みを止める柱が実質「収集数の一致」1 本に戻る)。CLI が描いた構造を AND で足す:
    //   ① タブバー行が残っていて、それが CLI 描画の属性を持つ
    //   ② タブ移動ヒントが消えている  ③ ダイアログとして読めない
    // 実機の確認画面(録画ログ再生、cols=120)で styled=10..16 / nav 無し / parse 不能 を実測。
    const reviewVp = getViewportText()
    const endedAtReview =
      isReviewScreenText(reviewVp) &&
      barRowHasStyledCells() &&
      !hasTabNavFooter(reviewVp) &&
      !screenHasDialog(reviewVp)
    if (endedAtReview) wlog('tab sweep: Submit の確認画面に出た(復帰を試みる)')

    // 巡回終了後も先頭タブに戻す
    const sentAllBack = await rewindToFirstTab(rewindSteps)
    if (sweepAborted) return null
    // 戻せないまま登録すると、スマホに依頼を出しつつ CLI は「Enter 一発で
    // 未回答のまま Submit が確定する画面」に置き去りになる。その組み合わせは作らない。
    if (!sentAllBack) {
      wlog('tab sweep: 巡回後に先頭へ戻せなかった(転送しない)')
      // await しない: sweep の finally を遅らせない(detect 抑止時間を HTTP と無関係にする)。
      postPcNotice('rewind-failed').catch((e) => wlog(`pc notice unexpected: ${sanitizeLogMessage(e && e.message)}`))
      return null
    }
    // 正常終了は「Submit に着いて読めなくなった」場合だけ。形状衝突による打ち切りも、
    // 読めなかっただけで確認画面に着いていない場合も、収集数がたまたま揃っていても
    // 未完として扱う(どちらも巡回しきれた証拠にならない)。
    const reachedSubmit = endedBy === 'unreadable' && endedAtReview
    if (!reachedSubmit || tabs.length !== expected) {
      wlog(
        `tab sweep incomplete: expected=${expected} captured=${tabs.length}` +
          ` end=${endedBy || 'no-break'} atReview=${endedAtReview} (転送しない)`
      )
      return null
    }
    wlog(`tab sweep done: tabs=${tabs.length} in ${Date.now() - t0}ms`)
    return { tabs, barSig, barLabels }
  } finally {
    tabSweepInProgress = false
    // 借りは巡回の内側でしか意味を持たない。持ち越すと、後からナビ表示の無い画面で
    // 戻る一手が通ってしまう(中断で返り損ねた分もここで捨てる)。
    forwardTabDebt = 0
    if (sweepAborted) wlog(`tab sweep aborted after ${Date.now() - t0}ms`)
    // getScreenText() はステートレス(常に「現在の画面」を返す)なので
    // 巡回後の特別な後始末は不要。flushStdinBuffer のみ行う。
    flushStdinBuffer()
  }
}

// ← (左矢印) を n 回送って codex の質問を前方(Q1 方向)へ戻す。各送出後に
// TUI 再描画を待つ sleep を挟む。sweep の前半(現在位置→Q1)と後半(巡回後→Q1 復帰)で共用。
async function pressLeftArrow(n) {
  for (let i = 0; i < n; i++) {
    if (!writeKey('\x1b[D')) return // ←(中断されたら打ち切る)
    await sleep(50)
  }
}

// codex プランモードの複数質問(Question N/M, M>1)を巡回キャプチャする。
// sweepTabs の codex 版。claude は ☐✔ タブ式 UI を Tab/Shift+Tab で巡回するが、codex は 1 問ずつ
// 表示し ←/→ で問を移動する(実機確認: codex 0.142.x、フッタ "←/→ to navigate questions")。
// 各問は parseDialog(..., {allowMultiCodex:true}) で読む(既定の M>1 抑止を外す)。終了判定は
// claude の shape-match でなく分母 M を loop bound に使う(より堅牢)。巡回後は Q1 へ戻して
// 注入(replayCodexMultiAnswers が Q1 から番号を順送り)に備える。finally で sweep フラグ解除 +
// stdin flush(巡回中の PC 入力を取りこぼさない)。
async function sweepCodexQuestions() {
  tabSweepInProgress = true
  sweepAborted = false
  try {
    const parseOpts = { allowMultiCodex: true }
    // 現在位置を Q1 へ戻す。Q1 で ← を押したときラップするか止まるかは未確定なので、画面の現在 N
    // を読んで (N-1) 回だけ ← を送る(過剰送出でラップする事故を避ける保守的算出)。
    const startPos = codexQuestionPos(getScreenText())
    if (!startPos) return null
    await pressLeftArrow(startPos.n - 1)
    await waitTabStable(400, null, -1, parseOpts)
    if (sweepAborted) return null

    const first = parseDialog(getScreenText(), parseOpts)
    if (!first) return null
    // 分母 M は巡回中不変なので rewind 前に読んだ startPos.m を流用(画面の再読取を避ける)。
    const total = startPos.m
    if (total < 2) return null // 単一は通常パスへフォールバック
    const tabs = [first]
    // → で残りの問を順に読む。上限 9(registerMultiDialog / validateMultiAnswer の tabs 上限)。
    for (let i = 1; i < total && i < 9; i++) {
      if (!writeKey('\x1b[C')) return null // →(中断)
      const last = tabs[tabs.length - 1]
      const next = await waitTabStable(600, last.prompt, last.options.length, parseOpts)
      if (sweepAborted) return null
      if (!next) break
      tabs.push(next)
    }
    // 巡回後は Q1 へ戻す(注入は Q1 から番号を順送りするため)。
    await pressLeftArrow(tabs.length - 1)
    if (sweepAborted) return null
    // 全問(分母 M)を捕捉できなかった場合(waitTabStable が null で break / M>9 で 9 打ち切り)は
    // 半端登録を避けて null を返す → detectDialogSingle が parseDialog 既定(allowMultiCodex=false で
    // M>1 抑止)で PC 側に倒す。2≤tabs.length<M の半端帯で未回答の残り問に submit all の \r が入る
    // ブラインド承認(承認取り違えの退行)を構造的に閉じる。
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
//
// 注入は「フォーカスが tabs[0] にある」ことを前提に数字を順送りする。スマホ回答が届くのは
// 巡回から数十秒後で、その間に PC 側でタブが動いている / 一部を答えている可能性があるため、
// 前提を **観測して確かめてから** 打つ。確かめられなければ数字を 1 バイトも書かない。
//
// 戻り値は失敗理由を持つ:
//   { ok: true }                  注入してよい
//   { ok: false, reason: 'pc-progressed' }  PC 側で回答が進んだ(印が変わった)
//   { ok: false, reason: 'position' }       位置を証明できなかった(一時的でありうる)
// 呼び出し側はこれで扱いを分ける。'pc-progressed' は **PC が回答を引き取った** という意味で、
// 保存済みスナップショットの印は二度と一致しないため再提示しても永久に弾かれる(実機で
// 3 回連続の再登録ループを観測)。よって再登録せず破棄する。
async function verifyAtFirstTab(dialog) {
  const viewport = getViewportText()
  // (1) タブバーが巡回時と完全に同じか。PC 側で 1 問でも答えられていれば印が変わる。
  if (dialog.barSig) {
    const now = tabBarSignature(viewport)
    // 「読めなかった」と「変わっていた」を区別する。折り返し・再描画途中で null になる
    // だけで pc-progressed 扱いにすると、PC は誰も答えていないのに依頼を取り下げてしまい、
    // サーバーは resolved・PC にダイアログ残存・再提示なしの永続オーファンになる。
    if (now === null) {
      wlog('inject aborted: tab bar unreadable')
      return { ok: false, reason: 'position' }
    }
    if (now !== dialog.barSig) {
      wlog(`inject aborted: tab bar changed (sweep="${dialog.barSig}" now="${now}")`)
      return { ok: false, reason: 'pc-progressed' }
    }
  }
  const expected = expectedTabCount(viewport)
  const cap = rewindStepsCap(expected)
  // (2) 選択中タブの index を属性から直接読む。読めないときは、全タブがテキストで
  //     互いに区別できる場合に限り (3) の一致判定を位置の根拠として認める。
  const idxReadable = activeTabIndex() !== null
  // 属性から読んだ index は描画依存で誤りうる(強調の起点が余白から始まる等)。読めた
  // ことを理由にテキストでの識別ゲートを外すと、誤った index を信じたまま別タブへ注入
  // しうるので、**読めたかどうかに関わらず** 全タブが互いに区別できることを要求する。
  if (!tabsMutuallyDistinct(dialog.tabs)) {
    wlog('inject aborted: tabs are not mutually distinct')
    return { ok: false, reason: 'position' }
  }
  for (let i = 0; i < cap; i++) {
    if (idxReadable && activeTabIndex() === 0) break
    // 比較はスクロールバックを含めない(古い描画の差で「動いた」と誤読しない)
    const before = getViewportText()
    // ローカル入力で中断された / ExitPlanMode 画面だった場合は以降のキーを打たない
    // (生の term.write を使わない理由)
    if (!writeShiftTab()) return { ok: false, reason: 'position' }
    await sleep(50)
    // 画面が動かなくなった = 左端に到達(「タブ 1 で止まる」仮定に依存しない)
    if (!idxReadable && getViewportText() === before) break
  }
  await waitTabStable(400)
  if (idxReadable && activeTabIndex() !== 0) {
    wlog('inject aborted: could not reach the first tab')
    return { ok: false, reason: 'position' }
  }
  // (3) 左端で読めたダイアログが tabs[0] か。
  const at = parseDialog(getScreenText())
  if (!at || !dialogShapeMatches(at, dialog.tabs[0])) {
    wlog('inject aborted: leftmost tab does not match tabs[0]')
    return { ok: false, reason: 'position' }
  }
  return { ok: true }
}

async function replayMultiAnswers(answers) {
  const dialog = currentDialog
  if (!dialog || !Array.isArray(dialog.tabs)) return { ok: false, reason: 'position' }

  // 位置検証の段階ではまだ確定キーを 1 バイトも書いていない。ここで stdin をバッファすると、
  // 検証にかかる時間(最大 12 回の Shift+Tab + 整定待ち)のあいだキーが効かず、あとでまとめて
  // 流れる(実機で「PC が固まりそうになった」と報告された挙動。再登録のたびに繰り返された)。
  // 番号列がずれる心配があるのは注入を **始めてから** なので、検証中は巡回と同じ
  // 「ローカル入力で中断 + 確定キーは整定窓のあいだ破棄」に倒す(同じ性質なので機構も共有する)。
  tabSweepInProgress = true
  sweepAborted = false
  let verdict
  try {
    verdict = await verifyAtFirstTab(dialog)
  } finally {
    tabSweepInProgress = false
    flushStdinBuffer()
  }
  if (sweepAborted) {
    wlog('inject aborted: local input during position check')
    return { ok: false, reason: 'position' }
  }
  if (!verdict.ok) return verdict

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
    // 回答済みダイアログを次フレーム描画まで再検出しないよう論理抑制
    if (currentDialog) suppressCurrentDialog(currentDialog.prompt)
    return { ok: true }
  } finally {
    tabReplayInProgress = false
    flushStdinBuffer()
  }
}

// スマホからのキャンセル指示を PC TUI の Esc キーで再現する。
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

// codex 複数質問の注入キー列を組み立てる純関数(テスト seam)。
// 承認取り違え防止の不変条件を単体で固定する = 中間問は番号のみ(Enter を一切挟まない)/ submit は最後に
// \r を 1 回だけ。中間で Enter を挟むと別問の既定 option を誤確定しうる(承認取り違え)。answers は
// validateMultiAnswer 通過済の { num }(codex 質問型に Type something は無く a.text は不使用 = 番号
// のみ = 安全側)。戻り値 = ["1","2",...,"\r"]。replayCodexMultiAnswers がこの列を PTY に流す。
function codexMultiKeySequence(answers) {
  const keys = answers.map((a) => a.num)
  keys.push('\r') // enter to submit all(全問送信、最後に 1 回だけ)
  return keys
}

// codexMultiKeySequence のキー列を PTY に再生する(replayMultiAnswers の codex 版)。
// 実機 E2E verified(codex 0.142.x): ある問で番号キーを押すと選択確定 + 自動で次問へ遷移(claude
// タブ式と同じ)。全問回答が揃うとフッタが "enter to submit all" になり \r で全送信(claude の
// "数字列 → 1\r" と同型、codex は \r 単独)。3 問バッチで 番号列 [1,3,2] → \r が全問確定・誤確定なしを
// 実機確認。取り違え防止の不変条件(中間 Enter なし / submit 1 回)は codexMultiKeySequence が純粋化・テスト固定。
// 注: この verified は複数質問(このファイル群)での実測。単一質問側(replayCodexQuestion 注 2、
// 下記)は対象外 = 単一質問と複数質問で codex の挙動が異なる可能性があるため、そちらは unknown の
// まま安全側既定を維持している(食い違いでなく意図的な非対称)。
// codex 版の注入前ゲート(claude の verifyAtFirstTab に対応)。codex はタブバーを持たない
// 代わりに `Question n/m` を描くので、そこから位置と質問数を読む。claude 側だけ検証があり
// codex 側が無条件だと、巡回から回答到着までの数十秒に PC 側で 1 問答える / ←/→ で移動する
// だけで番号列が丸ごとずれ、最後の \r で別の質問が確定する(承認取り違え)。
async function verifyCodexAtFirstQuestion(dialog) {
  const screen = getScreenText()
  // 位置と質問数は **表示領域だけ** から読む。getScreenText はスクロールバック 40 行を
  // 含むため、ダイアログが閉じた後も残骸の `Question 1/M` で 3 条件が揃ってしまう。
  const viewport = getViewportText()
  if (!isCodexMultiQuestion(viewport)) {
    wlog('codex inject aborted: 複数質問が表示領域に見えない')
    return { ok: false, reason: 'position' }
  }
  const pos = codexQuestionPos(viewport)
  if (!pos) {
    wlog('codex inject aborted: Question n/m を読めない')
    return { ok: false, reason: 'position' }
  }
  if (pos.m !== dialog.tabs.length) {
    wlog(`codex inject aborted: 質問数が変わった (登録=${dialog.tabs.length} 画面=${pos.m})`)
    return { ok: false, reason: 'position' }
  }
  if (pos.n !== 1) {
    // PC 側が先頭以外へ進んでいる = 引き取られた。再登録しても同じ理由で弾かれ続ける。
    wlog(`codex inject aborted: 先頭質問にいない (n=${pos.n})`)
    return { ok: false, reason: 'pc-progressed' }
  }
  const at = parseDialog(screen, { allowMultiCodex: true })
  if (!at || !dialogShapeMatches(at, dialog.tabs[0])) {
    wlog('codex inject aborted: 表示中の質問が tabs[0] と一致しない')
    return { ok: false, reason: 'position' }
  }
  return { ok: true }
}

async function replayCodexMultiAnswers(answers) {
  const dialog = currentDialog
  if (!dialog || !Array.isArray(dialog.tabs)) return { ok: false, reason: 'position' }
  const verdict = await verifyCodexAtFirstQuestion(dialog)
  if (!verdict.ok) return verdict
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
    return { ok: true }
  } finally {
    tabReplayInProgress = false
    flushStdinBuffer()
  }
}

// barSig = 巡回時点のタブバー指紋。注入直前に「PC 側で誰も答えていないこと」を
// 確かめるために保持する(claude のみ。codex は null)。
// reRegisterCount は再登録の打ち切り判定に使う。複合はここで新しいオブジェクトを
// 作り直すため、明示的に引き継がないと毎回 0 に戻って上限が永久に効かない
// (実機で「再登録 (#1)」が 3 回続くのを観測した原因)。
async function registerMultiDialog(tabs, projectName, barSig = null, reRegisterCount = 0, barLabels = null) {
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
    barSig,
    barLabels,
    reRegisterCount,
    id: null,
    lastSeenAt: Date.now(),
  }
  const gen = bumpDialogGeneration()
  try {
    const resp = await httpRequest('POST', '/request', {
      description,
      options: ['Submit'], // sentinel
      tabs: tabsPayload,
    })
    // await の間に別のダイアログへ入れ替わっていたら、この id は誰にも追跡されない
    // 孤児になる。捨てるのではなく明示的に解決してスマホ側からも消す。
    if (gen !== dialogGeneration || !currentDialog || currentDialog.tabs !== tabs) {
      await resolveStaleRegistration(resp.id, 'multi registration superseded')
      return
    }
    if (currentDialog.id === null) {
      currentDialog.id = resp.id
      // POST 完了直後、最後に見た時刻も更新して dismissal 早発火を防ぐ。
      // PTY 再描画が遅延しても 2 秒の猶予が確実に取れる。
      currentDialog.lastSeenAt = Date.now()
      clearTimeout(dismissalTimer)
      dismissalTimer = null
      wlog(`multi dialog posted: id=${resp.id}, tabs=${tabs.length}`)
      pollForResponse(resp.id).catch((e) => wlog(`poll error: ${e.message}`))
    } else {
      await resolveStaleRegistration(resp.id, 'multi slot already filled')
    }
  } catch (e) {
    wlog(`POST /request (multi) failed: ${e.message} (継続: CLI 応答のみ有効)`)
    if (currentDialog && currentDialog.id === null) currentDialog = null
  }
}

// 世代交代で行き場を失った登録を明示的に解決する(サーバー側の孤児 request を残さない)。
async function resolveStaleRegistration(id, reason, timeoutMs) {
  if (!id) return
  const path = safeIdPath(id)
  if (!path) {
    wlog(`stale registration の id 形式が不正のため送信しない (${reason})`)
    return
  }
  try {
    await httpRequest(
      'POST',
      `/resolve/${path}`,
      {
        answer: 'resolved-by-cli',
        resolvedBy: 'cli',
      },
      timeoutMs
    )
    wlog(`stale registration ${id} resolved (${reason})`)
  } catch (e) {
    wlog(`stale registration ${id} resolve failed: ${e.message}`)
  }
}

// 登録済みの複合質問が画面に出続けている「生存中」状態の述語。
// detectDialog の生存短絡(dismissal タイマー武装阻止)と onDialogDismissed の発火時 veto が共有し、
// 逐語重複による drift を防ぐ。currentDialog / IS_CODEX のモジュール状態に依存する。
//
// claude のタブ式も対象にする(従来は IS_CODEX 限定で、claude だけ
// 「Submit フォーカス / Type something 入力で parseDialog が null → 2 秒で resolve-by-cli →
// 再 sweep」のループが開く)。
// ただし **「タブ UI が見えている」だけでは生存にしない**。見えているのが *この* 依頼か
// を確かめないと、空白フレーム無しで次のタブ式質問へ遷移したときに旧依頼が延命され、
// スマホから返ってきた旧質問の回答が新しい UI に注入される(承認取り違え型)。
// よって「parse できたなら、それが登録済み tabs のいずれかであること」を要求する。
// parse できないフレーム(Submit フォーカス等)は判定を保留 = 生存扱い(可視である限り)。
function isLiveMultiDialog(screen, viewport) {
  if (!currentDialog || !currentDialog.tabs) return false
  const visible = IS_CODEX ? isCodexMultiQuestion(screen) : isTabbedDialog(viewport)
  if (!visible) return false
  const parsed = parseDialog(screen, IS_CODEX ? { allowMultiCodex: true } : {})
  if (!parsed) return true // 判定不能なフレーム = 保留(可視なので生存とみなす)
  return currentDialog.tabs.some((t) => dialogShapeMatches(t, parsed))
}

// タブ式 UI が「今この瞬間 1 回だけ巡回してよいか」を保持する latch。
let tabbedEpoch = { handled: false, absent: 0 }
// タブバー同定の直近の理由(遷移時だけログを出すためのもの。判定には使わない)。
let lastTabScanReason = null
// 巡回を見送った直近の理由 + そのときのバー行(同一内容の連投を止めるため)。
let lastSweepSkipKey = null

let barSigStable = 0
// この出現で **最初に** 見たタブバー指紋。以降これと変わったら、PC 側で何かが
// 進んだということ(印の意味を知らなくても分かる)。
let barSigFirst = null

// 巡回を見送ったことを、**判定に使ったバー行ごと** 記録する。理由だけでは
// 「印をどう解釈して見送ったのか」が後から分からず、原因を推測で埋めることになる。
function logSweepSkip(reason, viewport) {
  const line = findTabBarLine(viewport) || ''
  const key = `${reason}|${line}`
  if (key === lastSweepSkipKey) return
  lastSweepSkipKey = key
  // 観測材料は **抑止を抜けてから** 組み立てる。呼び出し側で文字列に埋め込むと、
  // ログを捨てる tick でも高コストな判定が先行評価される。
  wlog(
    `tab sweep skipped: ${reason} answeredMark=${anyTabAnswered(viewport)}` +
      ` bar="${line.trim().slice(0, 140)}"`
  )
  // 見送った画面でも実機の事実(属性 / フッタ位置 / 折返し)を 1 回だけ残す。
  // 巡回開始時にしか出さないと、見送りが続くあいだ何も観測できない。
  logScreenFacts()
}
// 巡回を有効にするか(config)。false なら巡回も転送もしない。
const TAB_SWEEP_ENABLED = !(_dialogDetection && _dialogDetection.tabSweep === false)

async function detectDialog() {
  // タブ巡回 / 再生中は通常検出をスキップ(dedup・誤登録を回避)
  if (tabSweepInProgress || tabReplayInProgress) return
  // currentDialog を触る処理を 1 本に直列化する。fire-and-forget な呼び出し
  // (onPtyData / 400ms tick)が await を跨いで交錯し、二重登録・スロット上書きが
  // 起きるのを構造的に防ぐ。
  return withDialogLock(detectDialogInner)
}

async function detectDialogInner() {
  // 画面バッファのテキストを 1 回取得して使い回す。
  // ただし detectDialogSingle へは渡さず、その時点で取り直す: 下の identityBroken 分岐で
  // resolveCurrentAsCli を await するあいだに画面が進むため、古い screen で登録すると
  // 消えたダイアログを登録しうる。
  const screen = getScreenText()
  // 「今 画面に出ているか」は表示領域だけで判定する(スクロールバックの残骸を拾わない)
  const viewport = getViewportText()
  // 粗い述語。「単一として扱ってはいけない画面か」= 偽陽性寄りに倒す側。
  const tabbedNow = IS_CODEX ? isCodexMultiQuestion(screen) : isTabbedDialog(viewport)
  // 巡回はキーを **実際に送る** ので粗い述語では足りない。claude 側は実タブバーが
  // 一意に決まること(= 'tabbed')を要求する。'ambiguous' は「タブ式らしいが実バーを
  // 決められない」= 巡回もせず単一登録もしない(粗い述語が真なので後者は自動で成立)。
  let sweepReady = tabbedNow
  if (!IS_CODEX) {
    const scan = tabbedScreenScan(viewport)
    sweepReady = scan.state === 'tabbed'
    // 指紋の安定カウントを更新する(判定ではなく観測)。タブ式が見えていない
    // フレームではリセットし、次の出現を最初から数え直す。
    if (scan.state === 'tabbed') {
      const sig = tabBarSignature(viewport)
      if (barSigFirst === null) barSigFirst = sig
      // **最初に見た指紋** に対して数える。前 tick との比較にすると、変化した後に
      // 落ち着いただけの状態(= PC が答えて手を止めた)も「安定」と見なしてしまう。
      if (sig !== null && sig === barSigFirst) barSigStable++
      else barSigStable = 0
    } else {
      barSigFirst = null
      barSigStable = 0
    }
    // 400ms ごとの同一ログを避け、遷移時だけ理由を残す(none と ambiguous の区別が
    // ログから読めないと、転送されない原因が「タブ式でない」のか「実バーを決められない」
    // のか切り分けられない)。
    if (scan.reason !== lastTabScanReason) {
      lastTabScanReason = scan.reason
      if (scan.state === 'ambiguous') {
        wlog(
          `tab bar ambiguous: reason=${scan.reason} candidates=${scan.indices.length}` +
            ` footIdx=${scan.footIdx} below=${scan.below}`
        )
      }
    }
  }

  // dialogEnded は「登録済みの依頼が終わった」ときだけ真。
  // `!currentDialog` を使うと、巡回に失敗して登録に至らなかった状態(= null のまま)を
  // 毎 tick「終了」と誤読し、latch が無効化されて巡回が止まらない。
  // 副作用として、巡回に失敗した出現はその出現の間ずっと再試行しない
  // (= 転送されず PC 側で回答)。誤注入より転送しない方を採る設計に沿う。
  // 消費(one-shot)は早期 return より前で行う。取りこぼすとフラグが次の出現まで生き残り、
  // そこで 1 回余計に latch を解除してしまう。
  const dialogEnded = dialogLifecycleEnded
  dialogLifecycleEnded = false

  // 登録済み複合質問が生きている間は dismissal を止め、再巡回もさせない。
  if (isLiveMultiDialog(screen, viewport)) {
    clearTimeout(dismissalTimer)
    dismissalTimer = null
    currentDialog.lastSeenAt = Date.now()
    if (blindSince && parseDialog(screen)) blindSince = 0
    tabbedEpoch = nextEpoch(tabbedEpoch, { tabbedNow, dialogEnded })
    return
  }

  // 生存していない = 別のダイアログに入れ替わった可能性。登録済み複合質問があるなら
  // 旧 id を明示解決してから新規検出へ倒す(サーバーに追跡不能な依頼を残さない)。
  let identityBroken = false
  if (currentDialog && currentDialog.tabs && tabbedNow) {
    identityBroken = true
    wlog('multi dialog identity changed; resolving old registration')
    await resolveCurrentAsCli()
  }

  // 直上の resolve が立てた分をここで取り込んで消費する(次の tick へ持ち越さない。
  // 持ち越すと巡回失敗の直後に latch がもう 1 回だけ余計に解除される)。
  const endedNow = dialogEnded || dialogLifecycleEnded
  dialogLifecycleEnded = false
  tabbedEpoch = nextEpoch(tabbedEpoch, {
    tabbedNow,
    identityBroken,
    dialogEnded: endedNow,
  })
  // タブ UI が連続して見えなくなったら notice も片付ける(id を持つ実 ID 状態のみ、
  // reservation 段階では触らない)。
  if (activeNotice && activeNotice.id && !tabbedNow && tabbedEpoch.absent >= EPOCH_ABSENT_TICKS) {
    clearNotice(activeNotice.id, 'tab ui gone')
  }

  // タブ式の判定: parseDialog が non-null かつ実タブバーが一意に決まるなら sweep に進む。
  // 「1 回の出現につき 1 回だけ」= latch。回数制限が無いと条件が揃うたびに巡回し直す
  // (= タブが回り続ける)。曖昧なフレームでは latch を消費しない = 実バーが決まった
  // 時点で 1 回だけ巡回できる。
  if (!currentDialog && !IS_CODEX && sweepReady && !tabbedEpoch.handled) {
    if (!TAB_SWEEP_ENABLED) {
      // 巡回無効時は単一登録へ落とさない。落とすと「表示中の 1 タブだけ」が
      // 単一質問として転送され、「タブ式は転送しない」という設定の意図に反する。
      return
    }
    // ここから下の 2 つは **latch を消費しない**。消費すると、一時的な理由(まだ
    // 落ち着いていない / 文言が紛れた)でその出現がまるごと巡回対象外になり復帰しない。
    //
    // 巡回は先頭タブへ戻すために Shift+Tab を送る。ExitPlanMode ではそのキー自体が
    // プラン承認の確定なので、種別を確かめずに巡回すると人間の操作ゼロで承認しうる。
    // また、戻る手段が使えない画面で前送りだけを始めると、右へ押した分を戻せず
    // フォーカスが Submit 側に残り、Enter 一発で未回答のまま確定しうる。
    // どちらも **送出側と同じ関数** で判断する。ただし開始側は `debtReturnOk` を渡さない =
    // 送出側より **厳しい**(借りを返す一手だけは属性ゲートより先に通す)。非対称の向きが
    // 重要で、開始が緩いと「開始できるのに戻れない」= 実機で観測した事故になる。
    const blocked = shiftTabBlockedReason(viewport)
    if (blocked) {
      logSweepSkip(`Shift+Tab を送れない: ${blocked}`, viewport)
      return
    }
    // 出現時に見たタブバーから変化していない状態が続いているあいだだけ巡回してよい。
    // 変化している = PC 側で何かが進んだということで、ここで巡回すると Shift+Tab で
    // ユーザーのフォーカスを奪い返す(実機で観測)。印の意味には依存しない。
    if (barSigStable < SWEEP_STABLE_TICKS) {
      logSweepSkip(`タブバーが落ち着いていない(stable=${barSigStable}/${SWEEP_STABLE_TICKS})`, viewport)
      return
    }
    const probe = parseDialog(screen)
    if (probe && !isSuppressed(probe)) {
      tabbedEpoch = { ...tabbedEpoch, handled: true }
      const swept = await sweepTabs()
      if (swept && swept.tabs.length >= 2) {
        await registerMultiDialog(swept.tabs, PROJECT_NAME, swept.barSig, 0, swept.barLabels)
        return
      }
      // 巡回できなかった(中断 / 完全性ゲート不成立)→ 転送を諦めて PC 側に倒す。
      return
    }
  }

  // codex の複数質問(Question N/M, M>1)は claude の ☐✔ タブ式 UI を
  // 持たないため isTabbedDialog では拾えない。専用ゲート isCodexMultiQuestion で検出し、
  // sweepCodexQuestions で ←/→ 巡回 → registerMultiDialog(tool 非依存で流用)。拾えなければ
  // 素通り → detectDialogSingle。そこでは parseDialog 既定(allowMultiCodex=false)が M>1 を
  // null にするため、半端な単一注入は起きず PC 側に残る(安全側フォールバック)。
  if (!currentDialog && IS_CODEX && tabbedNow && !tabbedEpoch.handled) {
    if (!TAB_SWEEP_ENABLED) return
    tabbedEpoch = { ...tabbedEpoch, handled: true }
    const tabs = await sweepCodexQuestions()
    if (tabs && tabs.length >= 2) {
      await registerMultiDialog(tabs, PROJECT_NAME, null)
      return
    }
    return
  }

  await detectDialogSingle(getScreenText())
}

// screen は detectDialog から渡される。単独テスト等のため未指定なら自前取得。
async function detectDialogSingle(screen = getScreenText()) {
  const parsed = parseDialog(screen)
  // claude のタブ式は画面に 1 タブ分しか描かれない。巡回に失敗した後や latch を消費した
  // 後の tick がここへ落ちると、**表示中の 1 タブだけ**が単一質問として登録され、残りの
  // 質問が無いままスマホで確定されうる(状態機械テストで実測: 巡回失敗のたびに
  // POST /request が飛んでいた)。「表示中がタブ式なら単一としては登録しない」を不変条件にする。
  // tabSweep:false のときの明示 return と同じ趣旨を、巡回が有効なまま失敗した経路にも広げる。
  // codex にはタブバーが無く複数質問は `Question n/m` で描かれる。ここを claude 専用に
  // すると、codex では下のガードがどれも発火せず「単一登録中に複数質問画面へ遷移 →
  // 旧 id が残る → スマホ回答が別質問へ入る」経路が非対称に開いたままになる。
  const tabbedNow = IS_CODEX ? isCodexMultiQuestion(screen) : isTabbedDialog(getViewportText())
  if (parsed) blindSince = 0 // 読めている = blind ではない(タブ式でも計測は止める)

  // ただし「登録しない」だけでは足りない。単一ダイアログを登録したまま画面がタブ式へ
  // 替わった場合、下の d が null になることで **旧登録の解決経路まで塞がる**:
  // dismissal タイマーは仕掛かるが onDialogDismissedInner は「画面に parse できる
  // ダイアログがあれば生存」と判断して veto するため(同一性を見ない)、旧 id が永久に
  // 残る。そこへスマホの回答が届くと、画面上の **別の** ダイアログへ数字 + Enter が入る(承認取り違え)。
  // 旧実装は d が非 null だったため必ず resolveCurrentAsCli を通っていた。ここで明示的に
  // 解決して、その経路を復元する。
  if (tabbedNow && currentDialog && !currentDialog.tabs) {
    wlog('single dialog replaced by a tabbed dialog; resolving old registration')
    await resolveCurrentAsCli()
    return
  }

  // 解決済みダイアログ(suppressCurrentDialog で抑制中)は「見えていない」
  // 扱いにする。これにより消失タイマー設定パスに落ち、回答後の自然な dismiss が進む。
  const d = parsed && !isSuppressed(parsed) && !tabbedNow ? parsed : null
  if (d) {
    // ダイアログが見えている間は消失タイマーを止める。
    clearTimeout(dismissalTimer)
    dismissalTimer = null
    blindSince = 0 // 読めたので blind 計測をリセット

    // 同一ダイアログ判定: 時間窓内 + オプション数一致 + prompt 類似 で再描画扱い。
    // ConPTY で tool 行が遅れて描画される/prompt 文字が落ちるケースに耐える。
    if (currentDialog) {
      const ago = Date.now() - currentDialog.lastSeenAt
      if (ago < DEDUP_WINDOW_MS && dialogShapeMatches(currentDialog, d) && sameDialogIdentity(currentDialog, d)) {
        // 再描画: ツール情報が遅れて揃った場合はここで補完
        if (currentDialog.tool === 'Unknown' && d.tool !== 'Unknown') {
          currentDialog.tool = d.tool
          currentDialog.args = d.args
        }
        currentDialog.lastSeenAt = Date.now()
        return
      }
      // 複合ダイアログ: 読めたのが登録済みのいずれかの tab なら「ユーザーが ←/→ で
      // 別タブに動いただけ」とみなし、dedup pass + lastSeenAt 更新。これがないと初期
      // フォーカスが tabs[0] 以外のタブにある場合に prompt 不一致で resolveCurrentAsCli
      // に直行してダイアログが消える。
      // ここへ来る時点で d は non-null = 表示中はタブ式でない(上の tabbedNow ガード)。
      // よって「タブバーがまだ画面にあれば延命」条件は常に偽になるので置かない。
      // タブ本体だけ読めてタブバーが表示領域外に出た状態は tabMatched が拾う。
      if (currentDialog.tabs && ago < DEDUP_WINDOW_MS) {
        if (currentDialog.tabs.some((t) => dialogShapeMatches(t, d))) {
          currentDialog.lastSeenAt = Date.now()
          return
        }
      }
    }

    // 別ダイアログに切り替わった → 旧ダイアログは CLI 応答済み扱い。
    // ただし **本文だけが違う別ダイアログ**(sameDialogIdentity での分岐)は prompt が
    // 同じなので、解決時に張る再検出抑制が「いま登録し直す相手」まで巻き込む。抑制の目的は
    // 回答済みダイアログの再検出防止なので、その場で出し直す相手には掛けない。掛けたままだと
    // 新依頼が直後の tick から見えなくなり、消失タイマーで取り下げられて別 id で出し直される
    // (スマホでは依頼が一瞬消えて id が入れ替わる = その隙のタップが古い id に当たる)。
    if (currentDialog) {
      const willSuppressNew = promptSimilar(d.prompt, currentDialog.prompt)
      await resolveCurrentAsCli()
      if (willSuppressNew) suppressedPrompt = null
    }

    await registerDialog(d)
    return
  }

  // 「読めないが、タブ式 UI は表示領域に出ている」= Submit フォーカスや Type something
  // 入力中。この間に解決すると、入力途中の回答とスマホ側の依頼を時間経過だけで失う。
  //
  // 延命の根拠は 2 つ:
  //   ① いま画面がタブ式である(isTabbedDialog)。**claude では通常ここまで来ない**
  //      (上流の isLiveMultiDialog が同じ画面を先に生存扱いするため)。効くのは codex で、
  //      上流の tabbedNow は codex 専用述語(isCodexMultiQuestion)なので、claude 式の
  //      バーが見えている間はここが唯一の根拠になる。その状態は identityBroken(同じく
  //      codex 専用述語)では回収されない = 実測で 30 tick 生存。
  //      さらに codex の登録は barLabels を持たない(registerMultiDialog に null を渡す)ので
  //      ② も効かない。**codex 側は「バー行が見えている限り無期限に延命」= 既知の非対称**。
  //   ② バー行の見出し列がこの依頼のものと一致する(isTabbedUiOfDialog)。
  //      「バー行だけが残る確認画面」まで拾う分、見出しの一致まで要求する。
  //      バー行の有無だけを根拠にすると、モデルが会話ログへ 1 行書くだけで旧依頼が
  //      無期限に生き残り、後から出た別のダイアログへ回答が入る余地になる。
  //
  // **延命に猶予も打ち切りも無い**。blindSince / MULTI_BLIND_GRACE_MS は「読めない状態が
  // 30 秒を超えた」ことを 1 度ログに残すだけの計測で、判断には使わない(可視中に時間で
  // 解決すると Type something の長い入力を取りこぼすため、意図してそうしている)。
  //
  // 残余: ①② とも根拠は画面テキストなので、延命そのものは偽装できる。ただし注入側は
  // verifyAtFirstTab が指紋と位置を独立に確かめるため、延命だけでは回答は入らない。
  const viewport = currentDialog && currentDialog.tabs ? getViewportText() : null
  const stillShowingThisDialog =
    viewport !== null &&
    (isTabbedDialog(viewport) || isTabbedUiOfDialog(viewport, currentDialog))
  if (stillShowingThisDialog) {
    if (!blindSince) blindSince = Date.now()
    else if (Date.now() - blindSince > MULTI_BLIND_GRACE_MS && !currentDialog.blindWarned) {
      currentDialog.blindWarned = true
      wlog(`multi dialog unreadable for >${MULTI_BLIND_GRACE_MS}ms but still visible; keeping`)
    }
    currentDialog.lastSeenAt = Date.now()
    clearTimeout(dismissalTimer)
    dismissalTimer = null
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
// 開始は spawnClaude 経由のみ。module scope で回すと `require` しただけで検出ループが
// 走り、テストがプロセスを終了できず互いに干渉する。
const PERIODIC_DETECT_MS = 400
let periodicDetectTimer = null
function startPeriodicDetect() {
  if (periodicDetectTimer) return periodicDetectTimer
  periodicDetectTimer = setInterval(() => {
    detectDialog().catch((e) => wlog(`periodic detect error: ${e.message}`))
  }, PERIODIC_DETECT_MS)
  // PTY が終わったらプロセスを引き止めない。
  if (typeof periodicDetectTimer.unref === 'function') periodicDetectTimer.unref()
  return periodicDetectTimer
}

// スマホに出す 1 行を組み立てる純関数。
// サーバー側 MAX_DESC_LEN と同値の枠に **こちらで収める**。超過分をサーバーに切らせると、
// 省略の印が「コマンドの打ち切り」と区別できなくなり、後半に何が隠れているのか
// スマホ側から判断できなくなる(承認の可否を決めるのはコマンド本文そのもの)。
// 削る順は prompt(定型文)→ args。args を削ったときだけ、その旨を文言で明示する。
const DESC_MAX_LEN = 500
const MIN_PROMPT_LEN = 60
const ARGS_OMITTED_MARK = '…[長すぎるため表示省略]'
function buildDescription(projectName, tool, args, prompt) {
  const head = `[${projectName}][${tool}] `
  const p = String(prompt || '')
  // 枠に収まらないときは必ず印を残す(無印で切ると、切れているのか元から短いのかが
  // スマホ側から区別できない)。projectName / tool が異常に長い場合の最終防衛も兼ねる。
  const clamp = (s) => (s.length <= DESC_MAX_LEN ? s : s.slice(0, DESC_MAX_LEN - 1) + '…')
  // args が空のとき "tool]  —" のような空白の間延びが起きるのを避ける
  if (!args) return clamp(`${head}${p}`)
  const full = `${head}${args} — ${p}`
  if (full.length <= DESC_MAX_LEN) return full
  const promptRoom = DESC_MAX_LEN - head.length - args.length - 3
  if (promptRoom >= MIN_PROMPT_LEN) return clamp(`${head}${args} — ${p.slice(0, promptRoom - 1)}…`)
  // prompt に確保するのは「実際の長さ」と MIN_PROMPT_LEN の小さい方。固定で 60 を確保すると、
  // prompt が数文字でも args を余計に削ってしまう(承認の可否を決めるのは args 側)。
  const promptKeep = Math.min(MIN_PROMPT_LEN, p.length)
  const argsRoom = DESC_MAX_LEN - head.length - promptKeep - 3 - ARGS_OMITTED_MARK.length
  // prompt 側も切ったなら印を残す(この分岐だけ無印だと、質問文が短いのか切れたのかを
  // スマホ側から区別できない)。
  const shortPrompt = p.length > promptKeep ? p.slice(0, Math.max(promptKeep - 1, 0)) + '…' : p
  return clamp(
    `${head}${args.slice(0, Math.max(argsRoom, 0))}${ARGS_OMITTED_MARK} — ${shortPrompt}`
  )
}

// 再描画の dedup は prompt と選択肢の形しか見ない(`dialogShapeMatches`)。それだけだと
// **コマンド本文が違う別の承認**を「同じダイアログの描き直し」と誤認する: 15 秒以内に
// 形の同じ Bash 承認が 2 回出ると、スマホには 1 個目(例 `ls`)が出たまま、承認は画面上の
// 2 個目(例 `rm -rf ~/important`)に入る(承認取り違え)。偽装も攻撃者も要らず通常運用で起きる。
// 部分描画で tool / args が未確定のフレームは従来どおり許容し(遅れて揃う経路を壊さない)、
// **両方が確定していて食い違うときだけ** 別ダイアログとして扱う。
// 選択肢は **順序が意味そのもの**(注入するのは番号)。長さしか見ないと、質問文が同じで
// 選択肢の並びだけ入れ替わった別ダイアログに「2 = 中止する」のつもりの `2` が入り、
// 画面上の「2 = 適用する」を確定させる。tool / args を持たない AskUserQuestion や
// ExitPlanMode では、この比較だけが同一性の根拠になる。
function sameOptions(a, b) {
  // 配列でない = 同一性を確かめる材料が無い。true を返すと「材料が無いほど通りやすい」
  // という向きになるので false(同一と見なさない)に倒す。parseDialog は常に配列を返すため
  // 通常は到達しないが、到達したときに fail-open するのが最悪の設計。
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  return a.every((o, i) => o === b[i])
}

// **注入専用**の厳密同一性。`sameDialogIdentity` は再描画 dedup 用で「未確定なら許容」だが、
// その緩さを注入の認可に使うと、未確定(`''` / `'Unknown'`)がワイルドカードになる
// (登録済み Bash `ls` と、画面上の tool を読めない別承認が一致してしまう。実行で確認)。
// 未確定を UNSET に正規化して **完全一致**を要求する。対称にするのが要点で、
// 「登録側の既知フィールドだけ必須」にすると登録側が未確定のとき制約がゼロになる。
const IDENTITY_UNSET = Symbol('unset')
function normIdentityField(v, { toolSentinel = false } = {}) {
  if (typeof v !== 'string' || v === '') return IDENTITY_UNSET
  if (toolSentinel && v === 'Unknown') return IDENTITY_UNSET
  return v
}
function strictDialogIdentity(a, b) {
  if (!a || !b) return false
  if (normIdentityField(a.tool, { toolSentinel: true }) !== normIdentityField(b.tool, { toolSentinel: true })) {
    return false
  }
  if (normIdentityField(a.args) !== normIdentityField(b.args)) return false
  return sameOptions(a.options, b.options)
}

function sameDialogIdentity(prev, next) {
  // 番兵は **tool 専用**。`'Unknown'` は「ツールを特定できなかった」を表す tool の値であって、
  // args の値としては普通の文字列(`● Bash(Unknown)` や本文に Unknown を含むコマンド)。
  // args にも番兵を適用すると、args="Unknown" の承認が任意のコマンドと一致してしまう。
  const knownTool = (v) => typeof v === 'string' && v !== '' && v !== 'Unknown'
  const knownArgs = (v) => typeof v === 'string' && v !== ''
  if (knownArgs(prev.args) && knownArgs(next.args) && prev.args !== next.args) return false
  if (knownTool(prev.tool) && knownTool(next.tool) && prev.tool !== next.tool) return false
  if (!sameOptions(prev.options, next.options)) return false
  return true
}

async function registerDialog(d) {
  const description = buildDescription(PROJECT_NAME, d.tool, d.args, d.prompt)
  // POST /request 中に別の PTY チャンクで detectDialog が走ると
  // currentDialog=null のまま二重登録されてしまう。先にスロットを予約する。
  // 送った 1 行を控える(注入直前に作り直して突き合わせるため)。
  currentDialog = { ...d, id: null, lastSeenAt: Date.now(), sentDescription: description }
  const gen = bumpDialogGeneration()
  try {
    // codex 自由記入宣言を server へ。claude は d.freeTextOptions=undefined
    // → spread しない = body byte 不変(回帰アサート対象)。
    const resp = await httpRequest('POST', '/request', {
      description,
      options: d.options,
      ...(d.freeTextOptions ? { freeTextOptions: d.freeTextOptions } : {}),
    })
    // スロットが別物に置き換わっていなければ id を埋める。
    // 置き換わっていた場合は採番済み id を明示解決して孤児を残さない。
    if (
      gen === dialogGeneration &&
      currentDialog &&
      currentDialog.id === null &&
      currentDialog.prompt === d.prompt
    ) {
      currentDialog.id = resp.id
      wlog(`dialog posted: id=${resp.id}`)
      pollForResponse(resp.id).catch((e) => wlog(`poll error: ${e.message}`))
    } else {
      await resolveStaleRegistration(resp.id, 'registration superseded')
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

// 注入直前検証の純判定部分(getViewportText 非依存 = 単体テスト可能に切り出す)。いま画面に
// 出ている now と登録済み dialog が「同じ承認」として注入してよいかを判定する。
// singleDialogStillOnScreen はこれを整定リトライで包むだけ(I/O とタイミングを分離)。
function dialogStillMatchesForInject(now, dialog, projectName) {
  if (!now || !dialog) return false
  // prompt は **完全一致** を要求する。args 一致を根拠にした近似一致の緩和は入れないこと:
  // 500 字未満なら後段の sentDescription byte 照合が prompt 差を検出して false になるが、
  // 500 字超は buildDescription の 500 字クランプで sentDescription が衝突し、byte 照合では
  // prompt 差を検出できない。つまりクランプ域を止めているのは下の完全一致だけ。
  // しかもクランプ域は「削除のみ(文字落ち)」と
  // 「追記(別承認)」が原理的に弁別不能なので、認可経路にその緩和を置くと追記型の
  // 取り違えを無自覚に再オープンする footgun になる。
  // 文字落ちフレームで登録されても reRegisterUninjectableDialog が再提示するため
  // 恒久オーファンにはならない(スマホ表示はクランプ域で同一 = 摩擦は 1 回)。
  if (!strictDialogIdentity(now, dialog)) return false
  if (!dialogShapeMatches(now, dialog, { exactPrompt: true })) return false
  if (!dialog.sentDescription) return true
  // prompt 差は上の exactPrompt が既に弾くので、この byte 照合が実際に効くのは strictDialogIdentity
  // の tool 番兵(登録側 'Unknown' / 画面側 '' を UNSET へ正規化して等価扱いする)の非対称コーナー。
  // 「スマホに実際に出した 1 行」を作り直して一致を要求し、表示と確定先の対応をこの 1 本で閉じる。
  return buildDescription(projectName, now.tool, now.args, now.prompt) === dialog.sentDescription
}

// 単一ダイアログの注入直前検証(複合の verifyAtFirstTab と対称)。いま画面に出ているものを
// 読み直し、スマホへ出した依頼と同じ相手かを確かめる。
//   - prompt は **完全一致** を要求する。既定の promptSimilar(部分列 85%)は、見出しが同じで
//     先頭の似た別ダイアログを通してしまい、それ自体が取り違えの経路になる。
//   - tool / args も突き合わせる(`strictDialogIdentity`)= 形が同じでコマンドだけ違う承認を弾く。
//     dedup 用の `sameDialogIdentity` とは別物で、未確定(`''` / `'Unknown'`)をワイルドカードにしない。
// 描画途中のフレームは一致しないので、整定を待って最大 `SINGLE_VERIFY_ATTEMPTS` 回採り直す(これを入れないと
// 通常運用で再登録が頻発し、スマホの依頼が入れ替わって見える)。
//   **読むのは `getViewportText()`**(`getScreenText()` はスクロールバック 40 行を含む)。
//   PC 側で答え終えて流れていったダイアログでも「まだ出ている」と読めてしまい、
//   下にある別の画面へ確定キーが入る = この関数が防ぐはずのものをそのまま通す。
//   同ファイルの規約(getViewportText の宣言コメント)と codex 側 verifyCodexAtFirstQuestion に揃える。
// 再描画の谷は 200ms 程度あるので 120ms×2 では取り切れず、正しい相手なのに諦めることがある。
// 待ちが伸びても打つ前の待機なので安全側(打ってから確かめるより遅いだけ)。
const SINGLE_VERIFY_SETTLE_MS = 150
const SINGLE_VERIFY_ATTEMPTS = 4
async function singleDialogStillOnScreen(dialog) {
  let unreadable = true
  for (let attempt = 0; attempt < SINGLE_VERIFY_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(SINGLE_VERIFY_SETTLE_MS)
    const now = parseDialog(getViewportText())
    if (!now) continue
    // 判定は dialogStillMatchesForInject(純関数)へ切り出した = 単体テスト可能。
    // なぜ prompt 完全一致か / なぜ sentDescription を突き合わせるか の詳細は同関数のコメントを参照。
    if (dialogStillMatchesForInject(now, dialog, PROJECT_NAME)) return true
    unreadable = false
  }
  wlog(
    unreadable
      ? 'inject aborted: 画面のダイアログを読めない'
      : 'inject aborted: 画面のダイアログが依頼と一致しない'
  )
  return false
}

// server-resolved な応答を wrapper が注入できない場合の永続オーファン対策。
// 単一質問の answer がこの currentDialog.options に一致しない(= サーバー側と wrapper
// 側で別々の parse 瞬間に凍結した options スナップショットが食い違う等)とき、サーバーは
// 既に当該 id を resolved 化しキューから除外している(スマホ不可視)一方、PC にはダイアログ
// が残るため、何もしなければ恒久オーファンになる(404 経路 isLostRegistration と同型の症状
// だがトリガが異なる)。まだ画面に出ている現ダイアログを再登録して新しい id を採番し直し、
// スマホへ再提示できるようにする。ただし不正 answer が繰り返されると無限ループになるため、
// 再登録回数を MAX_ORPHAN_REREGISTER で制限し、超過時は再登録せず現状(PC 残存)のまま
// 放置する(キャンセルだけは放置せず PC へ手放す = 下記)。
// 複合質問(claude)でも、注入直前の位置検証に失敗して 1 バイトも打たなかった場合は
// 本 helper へ倒す。tabs を持つ currentDialog は registerMultiDialog 側で再登録される。
const MAX_ORPHAN_REREGISTER = 2
async function reRegisterUninjectableDialog(id, reason, { fromCancel = false } = {}) {
  if (!currentDialog || currentDialog.id !== id) return
  const prevCount = currentDialog.reRegisterCount || 0
  if (prevCount >= MAX_ORPHAN_REREGISTER) {
    // **キャンセルは取り消し意図が明確**なので、上限に達したら「放置」ではなく PC へ手放す。
    // 放置するとスマホには消えた依頼が PC 側に残り続け、利用者から見て何も起きない。
    if (fromCancel) {
      await handOverToPc(`dialog ${id}: キャンセルを注入できないため PC へ手放す`, {
        keepSweepLatch: !Array.isArray(currentDialog.tabs),
      })
      return
    }
    wlog(`uninjectable dialog id=${id} (${reason}); 再登録上限到達につき放置`)
    return
  }
  const d = currentDialog
  d.reRegisterCount = prevCount + 1 // 単一は registerDialog の {...d} 経由で新スロットへ引継ぐ
  currentDialog = null // register 系が自前でスロット予約するため一旦解放する
  bumpDialogGeneration()
  wlog(`uninjectable dialog id=${id} (${reason}); 再登録 (#${prevCount + 1})`)
  if (Array.isArray(d.tabs)) {
    // 複合は新しいオブジェクトを作り直すので明示的に渡す(引数で渡さないと上限が効かない)
    await registerMultiDialog(d.tabs, PROJECT_NAME, d.barSig, d.reRegisterCount, d.barLabels)
  } else {
    await registerDialog(d)
  }
}

async function pollForResponse(id) {
  const idPath = safeIdPath(id)
  if (!idPath) {
    wlog('poll: id 形式が不正のため polling しない')
    return
  }
  while (currentDialog && currentDialog.id === id) {
    let resp
    try {
      resp = await httpRequest('GET', `/status/${idPath}?wait=60`, null, 70000)
    } catch (e) {
      // サーバーが当該 id を失った(プロセス再起動・クラッシュでメモリキューが揮発した等)
      // 場合は 404 が返る。同じ死んだ id を回し続けても依頼はスマホへ二度と出ないため、
      // まだ画面に出ている現ダイアログを即時に再登録して新しい id を採番し直す。
      // これがオーファン化(PC にダイアログ残存・サーバー queue 空・スマホ不可視)の解消点。
      if (isLostRegistration(e, currentDialog, id)) {
        const d = currentDialog
        currentDialog = null // register 系が自前でスロット予約するため一旦解放する
        bumpDialogGeneration()
        wlog(`status 404 (server lost id=${id}); re-registering dialog`)
        // tabs の有無 = 複合スナップショットか否かの不変条件で振り分ける。
        // 複合 currentDialog は registerMultiDialog 経由(tabs.length>=2 保証)でのみ作られ
        // args を持たない一方、単一 currentDialog は args を持ち tabs を持たない。
        // よって length>=2 でなく Array.isArray で判定する(length 条件に変えると複合を
        // registerDialog へ誤送し d.args 参照でクラッシュする)。
        if (Array.isArray(d.tabs)) {
          await registerMultiDialog(d.tabs, PROJECT_NAME, d.barSig, d.reRegisterCount || 0, d.barLabels)
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
    // 注入判断は detectDialog と同じロックの中で行う。ロック外だと
    // 「currentDialog.id === id を確かめた直後に検出側がダイアログを差し替える」
    // 窓が開き、差し替わった別ダイアログへ回答を注入しうる。
    return withDialogLock(() => handleResolvedResponse(id, resp))
  }
}

async function handleResolvedResponse(id, resp) {
  {
    // resolve された。CLI で既に応答済みなら注入しない。
    if (!currentDialog || currentDialog.id !== id) return

    // スマホからキャンセル指示が来た場合、Esc キーを TUI に注入して
    // ダイアログを破棄する。complete/single 両方の経路で使える。
    if (resp.action === 'cancel') {
      // Esc も「いま画面に出ている相手」に入る。別のダイアログへ切り替わった画面に Esc が
      // 入ると **無関係な承認を取り消す**ので、単一・複合とも束縛する。
      //   単一 = 注入と同じ根拠(画面の相手が依頼と同じか)。
      //   複合 = **指紋の一致だけ**を見る軽量版。`verifyAtFirstTab` は位置合わせのために
      //     Shift+Tab を最大 12 回送るので、キャンセルの前に呼ぶのは不適(取り消すだけなのに
      //     タブが動く)。キャンセルに位置合わせは要らない。
      const cancelOk = Array.isArray(currentDialog.tabs)
        ? currentDialog.barSig
          ? tabBarSignature(getViewportText()) === currentDialog.barSig
          : false
        : await singleDialogStillOnScreen(currentDialog)
      if (!cancelOk) {
        await reRegisterUninjectableDialog(id, 'キャンセル前の画面検証に失敗', { fromCancel: true })
        return
      }
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
        // codex は注入キーが claude と異なる(番号で自動次問 + \r で submit all)
        // ため IS_CODEX で振り分ける。claude(IS_CODEX=false)は従来経路で完全不変。
        let injected
        if (IS_CODEX) {
          injected = await replayCodexMultiAnswers(validated)
        } else {
          // 位置を確かめられなければ注入しない。サーバー側は既に resolved 化していて
          // スマホから見えないため、通常は再登録して再提示する。
          injected = await replayMultiAnswers(validated)
        }
        if (!injected.ok) {
          if (injected.reason === 'pc-progressed') {
            // PC 側で回答が進んだ = PC が引き取った。保存済みスナップショットの印は
            // 二度と一致しないので、再提示しても同じ理由で弾かれ続ける(実機で 3 連続の
            // 再登録ループを観測)。ここで手放し、以降は PC 側で完結させる。
            await handOverToPc(`dialog ${id}: PC 側で回答が進んだため注入を断念`)
            return
          }
          await reRegisterUninjectableDialog(id, '注入前の位置検証に失敗')
          return
        }
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
      // サーバーは resolved 済(スマホ不可視)だが wrapper は注入不能。
      // 永続オーファンを避けるため現ダイアログを再登録してスマホへ再提示する。
      await reRegisterUninjectableDialog(id, 'answer 不一致')
      return
    }

    // 単一ダイアログにも **注入直前の画面再検証** を入れる(複合の verifyAtFirstTab と
    // 対称)。これが無いと「スマホに出した依頼」と「いま画面に出ているダイアログ」の対応を
    // 400ms tick の dedup だけが担保することになり、dedup が崩れた瞬間そのまま承認の
    // 取り違えになる。以降の全経路(claude 数字 / claude 自由記入 / codex コマンド承認 /
    // codex 質問)に効かせるため、経路の分岐より前に 1 箇所だけ置く。
    if (!(await singleDialogStillOnScreen(currentDialog))) {
      await reRegisterUninjectableDialog(id, '注入前の画面検証に失敗')
      return
    }

    // defense in depth: key が指す option が Chat about this なら注入拒否
    const selectedOpt = currentDialog.options[parseInt(key, 10) - 1]
    if (CHAT_ABOUT_RE.test(selectedOpt)) {
      wlog(`answer points to "Chat about this" which is not remote-controllable. 注入スキップ。`)
      return
    }

    // codex は注入方式が claude と全く異なるため、claude 用の経路
    // (フリーテキスト / 数字 + Enter)より前に最前段で分岐する。IS_CODEX=false の claude では
    // 本ブロックに入らず以降の既存経路が完全不変。振り分けキー = 選択された option ラベルの
    // ショートカット抽出可否(コマンド承認の option は必ず (y/p/esc) を持ち、質問型は持たない)。
    // 判定順は安全性のため固定(① → ② → ③):
    //   ① ショートカット抽出可 → コマンド承認(ショートカットキーのみ、Enter 不送出 = 取り違え回避)
    //   ② resp.text あり      → 質問型の自由記入(選択 → Tab → テキスト → Enter)
    //   ③ それ以外(番号選択肢) → 質問型(番号 → Enter)
    // 注: 分類は parseDialog(全 option がショートカット ⟺ Bash)が既に出しているが、注入側は
    //   それに依存せず「選択 option のショートカット抽出可否」で独立に再判定する(defense in depth)。
    //   分類が万一誤ってもコマンド承認(ショートカット持ち)を番号+Enter 経路に落とさないため。
    //   承認取り違えの再発防止の核。tool ラベル駆動に寄せると分類ミス時に承認が番号+Enter で誤確定しうる。
    if (IS_CODEX) {
      // ① コマンド承認(選択 option がショートカットを持つ)を最優先で判定。text が添付されて
      //    いてもショートカット専用経路に倒す(Enter 不送出)。これより前に text 経路を置くと、
      //    クライアントが {answer, text} を投げてコマンド承認を番号+Enter 経路に落とし末尾 Enter で
      //    既定 option1(承認)を誤確定させうる(承認取り違えと同型・API 直叩き迂回)。codex コマンドに
      //    notes は無いので text は無視するのが正(server 側も Type something 限定で text を 400)。
      if (resolveCodexInjection(selectedOpt)) {
        await replayCodexApproval(key, currentDialog.options, id)
        return
      }
      // ② 質問型の自由記入(Tab notes)。①を通過した = 選択 option はショートカットを持たない
      //    質問型のみ。text 健全性を再検証(defense in depth)。
      if (resp.text != null) {
        // defense in depth: text 注入は wrapper 自身が宣言した自由記入 option
        //   (currentDialog.freeTextOptions, 1-based)に限定。server 側の text 添付ゲートと対称の二重防御で、
        //   宣言外 option への text 流し込み(承認取り違えと同型)を wrapper 側でも塞ぐ。
        const keyNum = parseInt(key, 10)
        if (
          !(Array.isArray(currentDialog.freeTextOptions) &&
            currentDialog.freeTextOptions.includes(keyNum))
        ) {
          wlog(`text attached but option #${keyNum} is not a declared codex free-text option。注入スキップ。`)
          return
        }
        const safeText = validateFreeText(resp.text)
        if (!safeText) {
          // 入力内容そのものはログに出さない(自由記入に機密が入りうる)。型/長さのみ記録。
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

    // スマホからフリーテキストが添付されている場合の経路(claude)。
    // resp.text を validateFreeText で再検証(defense in depth)し、
    // replayFreeText で「キー → モード遷移待ち → 1 文字ずつ → Enter」で注入。
    // text なしの通常経路は従来通り「数字 + Enter」のみ。
    if (resp.text != null) {
      // defense in depth: text 添付は Type something option 限定
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
    // 回答済みダイアログを次フレーム描画まで再検出しないよう論理抑制。
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

// フリーテキスト送信(Type something 経路)用の defense in depth 検証。
// server の sanitizeFreeText は strict reject 型 = wrapper の本関数と同じ契約。
// UI 側だけが事前削除型(ユーザー入力ミスを優しく整形)。
// 検査: 文字列 / 長さ 1〜MAX_FREE_TEXT_LEN / C0 + DEL + C1 制御文字を含まない /
//      trim 後 length>0(空白のみ拒否)。
// C1 制御文字(\x80-\x9F)も server と統一して拒否する。
const MAX_FREE_TEXT_LEN = 2000
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F\x80-\x9F]/
function validateFreeText(text) {
  if (typeof text !== 'string') return null
  if (text.length === 0 || text.length > MAX_FREE_TEXT_LEN) return null
  if (CONTROL_CHARS_RE.test(text)) return null
  if (text.trim().length === 0) return null
  return text
}

// 注入タイミング定数。Claude TUI のテキスト入力欄が値を受け取れる
// ペース。MODE_TRANSITION_MS は「数字キーで Type something モードへ切替 →
// 入力欄表示完了」までの待ち。CHAR_INJECT_MS_SLOW は遷移直後のウォームアップ
// 用(入力欄バッファが安定するまで)、CHAR_INJECT_MS_FAST は定常時。
const MODE_TRANSITION_MS = 200
const CHAR_INJECT_MS_SLOW = 30
const CHAR_INJECT_MS_FAST = 10
const CHAR_INJECT_WARMUP = 30 // 最初の N 文字を SLOW、以後 FAST

// フリーテキストを PTY に「1 文字ずつ + 遅延」で再生する。
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
    // 回答済みダイアログを次フレーム描画まで再検出しないよう論理抑制
    if (currentDialog) suppressCurrentDialog(currentDialog.prompt)
  } finally {
    tabReplayInProgress = false
    flushStdinBuffer()
  }
}

// codex のコマンド承認(Yes/proceed・don't-ask・No の 3 択)を注入する。
// key(番号 "1"〜"9")を option ラベルへ写し、末尾括弧のショートカット(y/p/esc)を抽出して
// そのキーだけを送る(番号 + Enter は送らない = 既定 option 誤確定を構造的に回避)。
// 抽出失敗時(option 構成が想定外でショートカットを取れない等)は注入せず、現ダイアログを
// 再登録(reRegisterUninjectableDialog、404 経路と対称)してスマホ/PC の手動処理に倒す。
// fail-safe = 承認にも拒否にも勝手に倒さない。これが承認取り違えの再発防止の核。
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
    // 回答済みダイアログを次フレーム描画まで再検出しないよう論理抑制
    if (currentDialog) suppressCurrentDialog(currentDialog.prompt)
    wlog(`injected codex shortcut for key="${key}" dialog ${id}`)
  } finally {
    tabReplayInProgress = false
    flushStdinBuffer()
  }
}

// codex プランモードの選択肢質問(= AskUserQuestion 相当)を注入する。
// コマンド承認(replayCodexApproval)と違い、option ラベルにショートカット文字が無いため、
// 番号で選択肢へ移動 → Enter で確定(フッタ "enter to submit answer")する。
// text 付き(自由記入 = Tab notes)は codex 仕様で「選択 → Tab で notes 欄を開く → テキスト →
// Enter」(フッタ "tab to add notes")。claude の replayFreeText とは Tab の有無/順序が異なる。
// 注 1: text 経路は実運用の経路(宣言済み自由記入 option の notes がここに来る)。
//   server 側の text 添付ゲート(isSingleTextAllowed)が通すのは「ラベルが `Type something` に
//   一致する option **または** 宣言済み option」なので、codex 質問型で偶然 `Type something` という
//   ラベルが出れば宣言外でもゲートを通る。それを止めているのは呼び出し側
//   (handleResolvedResponse)の freeTextOptions 再検証だけ = 冗長な二重チェックではなく
//   この経路の実質的な唯一の防壁。削除しないこと。
// 注 2: 番号キーが「移動」か「即選択確定」か、Enter 要否、Tab notes の順序/待ちは
//   単一質問の実機 E2E で確定するまで unknown。確定するまでは安全側既定(番号 → Enter)で出す。誤確定の主リスクは
//   コマンド承認側(承認取り違え)で、質問型は最悪でも誤った選択肢/notes の送信に留まる(承認取り違えでない)。
//   複数質問側(replayCodexMultiAnswers、上記)は実機 E2E verified(番号キー押下で選択確定 + 自動
//   次問遷移)だが、それは複数質問での実測範囲であり単一質問への外挿は未確認。単一質問と複数質問で
//   codex の挙動が異なる可能性があるため、この単一質問側だけ unknown のまま安全側を維持している。
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
    // 回答済みダイアログを次フレーム描画まで再検出しないよう論理抑制
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

// ダイアログが画面から消えた（= β 応答があった）と判定する処理。
// タイマーからの発火も detectDialog と同じロックに載せる(状態遷移の直列化)。
function onDialogDismissed() {
  dismissalTimer = null
  return withDialogLock(onDialogDismissedInner)
}

async function onDialogDismissedInner() {
  if (!currentDialog) return
  const screen = getScreenText()
  // 複数質問は parseDialog 既定が null(codex は M>1 抑止 / claude は Submit フォーカス等)
  // = 下の d チェックをすり抜けて誤 dismiss(resolve-by-cli)し、スマホが持つ id を奪う。
  // まだ画面に出ていれば生存とみなしキャンセル(detectDialog の生存短絡と同じ盲点への
  // defense in depth)。claude のタブ式も対象。
  if (isLiveMultiDialog(screen, getViewportText())) return
  // 発火時点で再度 parseDialog して、画面にまだ(抑制対象でない)ダイアログが
  // あればキャンセルしない。
  // ただし **見えているのが登録済みのそれ自身か** を確かめる。同一性を見ずに veto すると、
  // 別のダイアログに替わった画面を「まだ出ている」と誤読して旧登録を永久に生かし、
  // スマホの回答が別ダイアログへ入る(承認取り違え)。上流の isLiveMultiDialog(複合用)と同じ思想を
  // 単一にも適用する。
  const d = parseDialog(screen)
  if (d && !isSuppressed(d) && dialogShapeMatches(currentDialog, d)) return
  if (Date.now() - currentDialog.lastSeenAt < DISMISSAL_MS) return
  await resolveCurrentAsCli()
}

async function resolveCurrentAsCli() {
  const d = currentDialog
  currentDialog = null
  bumpDialogGeneration()
  if (d) dialogLifecycleEnded = true
  blindSince = 0
  // dismiss 確定したダイアログを次フレーム描画まで再検出しないよう論理抑制。
  // (旧実装の cleanBuf='' の代替。残しておくと次の検出で古い tool 行を拾う原因に)
  if (d && d.prompt) suppressCurrentDialog(d.prompt)
  if (!d || !d.id) return
  const path = safeIdPath(d.id)
  if (!path) {
    wlog('resolve-by-cli: id 形式が不正のため送信しない')
    return
  }
  try {
    await httpRequest('POST', `/resolve/${path}`, {
      answer: 'resolved-by-cli',
      resolvedBy: 'cli',
    })
    wlog(`dialog ${d.id} resolved by CLI`)
  } catch (e) {
    // すでに resolved 済み等は無視
  }
}

// PC 側が回答を引き取った出現を手放す。登録は resolveCurrentAsCli で落としつつ、
// **巡回 latch は解除しない**のが要点。解除すると同じ出現をもう一度巡回してスマホへ
// 出し直してしまい、破棄した意味が消える(再登録ループが経路を変えて復活する)。
// `keepSweepLatch` = タブ巡回の latch(この出現はもう巡回済み)を触らない。
// latch は「タブ式ダイアログ 1 回の出現につき巡回 1 回」を保つためのもので、
// **単一ダイアログを手放すときに焼くと**、そのあと出てくるタブ式が同じ出現のあいだ
// ずっと転送されなくなる(手放した相手と無関係な状態を壊している)。
async function handOverToPc(reason, { keepSweepLatch = false } = {}) {
  wlog(`hand over to PC: ${reason}`)
  await resolveCurrentAsCli()
  dialogLifecycleEnded = false
  if (!keepSweepLatch) tabbedEpoch = { ...tabbedEpoch, handled: true, absent: 0 }
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
