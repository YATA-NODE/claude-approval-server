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

// ダイアログ検出トリガー語（英語ロケール用）。必要なら config で上書き可能。
const TRIGGERS = (config.dialogDetection && config.dialogDetection.triggers) || ['Do you want to']

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
// ダイアログ検出
// -------------------------------------------------------
// 直近 PTY 出力のスライディングウィンドウ（クリーン済み）
let cleanBuf = ''
const CLEAN_BUF_MAX = 8000

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
    .replace(/\x1b\]0;[^\x07]*\x07/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/\x7f/g, '')
}

function onPtyData(chunk) {
  cleanBuf += stripAnsi(chunk)
  if (cleanBuf.length > CLEAN_BUF_MAX) cleanBuf = cleanBuf.slice(-CLEAN_BUF_MAX)
  detectDialog().catch((e) => console.error('[wrapper] detect error:', e.message))
}

// ダイアログ構造パターン:
//   "Do you want to <...>?" ... "❯ 1. <opt1>" ... "2. <opt2>" ... "3. <opt3>" ... "Esc to cancel" ... "● <Tool>(<args>)"
//
// 注意: ConPTY 経由のクリーン済みバッファでは空白が崩れることがある
//   例: "Esc to cancel" → "Esctocancel"、"Yes, allow ..." → "Yes,allow..."
// そのため終端マーカーとオプション区切りは空白を許容する正規表現で判定する。
const END_MARKER_RE = /Esc\s*to\s*cancel/i

function parseDialog(buf) {
  // 全バッファを対象に lastIndexOf で最新のダイアログを探す。
  // cleanBuf は CLEAN_BUF_MAX 文字で自動ローテーションされるため、
  // 画面外に出た古いダイアログはやがて buf から消えて null が返る。
  const triggerIdx = Math.max(...TRIGGERS.map((t) => buf.lastIndexOf(t)))
  if (triggerIdx < 0) return null

  const tail = buf.slice(triggerIdx)
  const endMatch = tail.match(END_MARKER_RE)
  if (!endMatch) return null
  const endIdx = endMatch.index

  const promptMatch = tail.match(/(Do you want to[^?]*\?)/)
  if (!promptMatch) return null
  const prompt = promptMatch[1].replace(/\s+/g, ' ').trim()

  // オプション文字列抽出（ダイアログ末尾の Esc までの範囲）
  const segment = tail.slice(0, endIdx)
  // 数字マーカーの位置を取得して区切る
  const markerRe = /([123])\./g
  const markers = []
  let m
  while ((m = markerRe.exec(segment)) !== null) {
    markers.push({ num: parseInt(m[1]), at: m.index, end: m.index + m[0].length })
  }
  if (markers.length === 0) return null
  // 同じ番号が複数出た場合は最後のもののみ保持（再描画で複数残ることがある）
  const byNum = new Map()
  for (const mk of markers) byNum.set(mk.num, mk)
  const sorted = [...byNum.values()].sort((a, b) => a.at - b.at)
  const options = sorted.map((mk, i) => {
    const nextAt = i + 1 < sorted.length ? sorted[i + 1].at : segment.length
    return segment
      .slice(mk.end, nextAt)
      .replace(/❯/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  })
  if (options.length === 0 || options.every((o) => !o)) return null

  // ツール行
  const toolMatch = tail.match(/●\s*([A-Za-z_]+)\(([\s\S]*?)\)/)
  const tool = toolMatch ? toolMatch[1] : 'Unknown'
  const args = toolMatch ? toolMatch[2].replace(/\s+/g, ' ').trim() : ''

  return { prompt, options, tool, args }
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
  detectDialog().catch((e) => console.error('[wrapper] periodic detect error:', e.message))
}, 400)

async function registerDialog(d) {
  const shortArgs = d.args.length > 200 ? d.args.slice(0, 200) + '…' : d.args
  const description = `[${PROJECT_NAME}][${d.tool}] ${shortArgs} — ${d.prompt}`
  // POST /request 中に別の PTY チャンクで detectDialog が走ると
  // currentDialog=null のまま二重登録されてしまう。先にスロットを予約する。
  currentDialog = { ...d, id: null, lastSeenAt: Date.now() }
  try {
    const resp = await httpRequest('POST', '/request', { description, options: d.options })
    // スロットが別物に置き換わっていなければ id を埋める
    if (currentDialog && currentDialog.id === null && currentDialog.prompt === d.prompt) {
      currentDialog.id = resp.id
      process.stderr.write(`\n[wrapper] dialog posted: id=${resp.id}\n`)
      pollForResponse(resp.id).catch((e) => console.error('[wrapper] poll error:', e.message))
    }
  } catch (e) {
    process.stderr.write(`\n[wrapper] POST /request failed: ${e.message} (継続: CLI 応答のみ有効)\n`)
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
      process.stderr.write(
        `\n[wrapper] answer "${String(resp.answer).slice(0, 40)}" は許可された値ではない。注入スキップ。\n`
      )
    } else {
      term.write(key + '\r')
      process.stderr.write(`\n[wrapper] injected "${key}" for dialog ${id}\n`)
    }
    // currentDialog は PTY 出力でダイアログが消えたら自然に消える
    return
  }
}

// answer を「1/2/3 の文字」または「options 完全一致」→ 対応する番号に正規化
function validateAnswer(answer, options) {
  if (typeof answer !== 'string') return null
  const a = answer.trim()
  if (a === '1' || a === '2' || a === '3') {
    const idx = parseInt(a) - 1
    if (idx >= 0 && idx < options.length) return a
    return null
  }
  const idx = options.indexOf(a)
  if (idx >= 0) return String(idx + 1)
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
  if (!d || !d.id) return
  try {
    await httpRequest('POST', `/resolve/${d.id}`, {
      answer: 'resolved-by-cli',
      resolvedBy: 'cli',
    })
    process.stderr.write(`\n[wrapper] dialog ${d.id} resolved by CLI\n`)
  } catch (e) {
    // すでに resolved 済み等は無視
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// -------------------------------------------------------
// メイン
// -------------------------------------------------------
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
