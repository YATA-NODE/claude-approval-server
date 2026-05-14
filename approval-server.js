/**
 * approval-server.js
 *
 * エージェントからの承認依頼を管理するHTTPサーバー。
 * ngrokでトンネルして、スマホからアクセス可能にする。
 *
 * 使い方:
 *   npm install express cors
 *   node approval-server.js
 *   # 別ターミナルで: ngrok http 3000
 */

const http = require('http')
const express = require('express')
const cors = require('cors')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// 設定の読み込み優先順位:
//   PORT:  1. 環境変数 APPROVAL_PORT  2. approval-config.json の port  3. 3000
//   TOKEN: 1. approval-config.json の token  2. 環境変数 APPROVAL_TOKEN  3. ランダム生成
//
// PORT は env 優先（ポート衝突時に一時的に切り替えたい場面が多いため）。
// TOKEN は config 優先（長期固定したい値であり、無関係な env で上書きされると困るため）。
function loadConfig() {
  const configPath = path.join(__dirname, 'approval-config.json')
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (_) {
    return {}
  }
}
const config = loadConfig()

const app = express()
const PORT = parseInt(process.env.APPROVAL_PORT) || config.port || 3000
// C1: トークン未設定時は 32 バイト（256bit）のランダム値を自動生成
const SECRET_TOKEN =
  config.token || process.env.APPROVAL_TOKEN || crypto.randomBytes(32).toString('hex')

// ngrok 経由の X-Forwarded-For を信頼し、レート制限で本物のクライアント IP を使う。
// サーバーが 127.0.0.1 のみをバインドしているため、この設定で不当な偽装は起きない。
app.set('trust proxy', 'loopback')

app.use(cors())
app.use(express.json({ limit: '64kb' }))
// v1.11.2: approval-ui.html / 静的アセットはキャッシュさせない。
// スマホブラウザ(特に ngrok 経由)が古い UI をキャッシュし続けると、
// UI 修正が反映されず実機検証がブロックされるため。
app.use(
  express.static(__dirname, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.set('Cache-Control', 'no-store, must-revalidate'),
  })
)

// ルートアクセスで approval-ui.html を返す
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store, must-revalidate')
  res.sendFile(path.join(__dirname, 'approval-ui.html'))
})

// 承認待ちキュー: { id, description, status, createdAt, resolvedAt }
const queue = []

// resolved になってから RESOLVED_TTL_MS 経過したエントリを定期的に除去する。
// UI 側の「処理履歴」はブラウザローカルに保持されるため、サーバー側の resolved は
// long-poll の取りこぼし対策として短時間だけ保持すれば十分。
const RESOLVED_TTL_MS = 60 * 60 * 1000 // 1 時間
const RESOLVED_GC_INTERVAL_MS = 5 * 60 * 1000 // 5 分ごとに走査
function gcResolved() {
  const now = Date.now()
  let removed = 0
  for (let i = queue.length - 1; i >= 0; i--) {
    const it = queue[i]
    if (it.status !== 'resolved' || !it.resolvedAt) continue
    const age = now - new Date(it.resolvedAt).getTime()
    if (age >= RESOLVED_TTL_MS) {
      queue.splice(i, 1)
      removed++
    }
  }
  if (removed > 0) console.log(`[GC] removed ${removed} resolved entries`)
}
const gcTimer = setInterval(gcResolved, RESOLVED_GC_INTERVAL_MS)
gcTimer.unref?.()

// long-poll 待機中の /status/:id リクエスト通知用
const { EventEmitter } = require('events')
const resolveEvents = new EventEmitter()
resolveEvents.setMaxListeners(100)

// I1: description の最大長（ngrok 経由で機微情報が長大化するのを抑制）
const MAX_DESC_LEN = 500

// I2: レート制限（同一 IP の 401 連発を 10 分ブロック）
const failCounter = new Map() // ip -> { count, resetAt, blockedUntil }
const FAIL_WINDOW = 60 * 1000
const FAIL_LIMIT = 10
const BLOCK_MS = 10 * 60 * 1000

function checkRateLimit(ip) {
  const now = Date.now()
  const e = failCounter.get(ip)
  if (e && e.blockedUntil > now) return false
  return true
}
function recordFailure(ip) {
  const now = Date.now()
  let e = failCounter.get(ip)
  if (!e || e.resetAt < now) {
    e = { count: 1, resetAt: now + FAIL_WINDOW, blockedUntil: 0 }
  } else {
    e.count++
    if (e.count >= FAIL_LIMIT) {
      e.blockedUntil = now + BLOCK_MS
      console.warn(`[RATE-LIMIT] ${ip} blocked for ${BLOCK_MS / 1000}s`)
    }
  }
  failCounter.set(ip, e)
}
function recordSuccess(ip) {
  failCounter.delete(ip)
}

// I3: タイミング攻撃耐性のあるトークン比較
function tokensMatch(received, expected) {
  if (typeof received !== 'string' || received.length === 0) return false
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// トークン認証ミドルウェア
function authenticate(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many failed attempts' })
  }
  const token = req.headers['x-secret-token']
  if (!tokensMatch(token, SECRET_TOKEN)) {
    recordFailure(ip)
    return res.status(401).json({ error: 'Unauthorized' })
  }
  recordSuccess(ip)
  next()
}

// -------------------------------------------------------
// エージェント側API
// -------------------------------------------------------

/**
 * POST /request
 * エージェントが承認依頼を登録する
 * Body: { description: "ファイルを削除しようとしています: /tmp/test.txt" }
 * Returns: { id, status: "pending" }
 *
 * その後、エージェントは GET /status/:id をポーリングして結果を確認する
 */
// 文字列を最大長に切り詰めて末尾に "…" を付ける。短ければそのまま。
function clipString(s, max) {
  return s.length > max ? s.slice(0, max) + '…' : s
}

// options 配列を「文字列のみ・最大 9 件・各 200 文字」に正規化する。
function sanitizeOptions(arr) {
  return arr
    .filter((o) => typeof o === 'string')
    .slice(0, 9)
    .map((o) => clipString(o, 200))
}

app.post('/request', authenticate, (req, res) => {
  const { description, options, tabs } = req.body
  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'description is required' })
  }

  // I1: 長過ぎる description は切り詰め（ngrok 経由の情報漏洩抑制・UI 表示の保護）
  const safeDesc = clipString(description, MAX_DESC_LEN)

  // options: 文字列配列のみ許可、最大 9 件・各 200 文字
  // AskUserQuestion 型ダイアログでは長文選択肢(平均 25 文字以上)が並ぶことがあるため
  // 各要素の上限を 200 文字に緩和。件数上限は数字キー注入の都合で 9 件まで。
  let safeOptions = ['Yes', 'No']
  if (Array.isArray(options)) {
    const sanitized = sanitizeOptions(options)
    if (sanitized.length > 0) safeOptions = sanitized
  }

  // tabs: タブ式 AskUserQuestion(複合質問)用、optional
  // 各タブは {label?, prompt, options} 形式、最大 9 タブ・各 9 options
  let safeTabs = null
  if (Array.isArray(tabs) && tabs.length > 0) {
    safeTabs = tabs
      .slice(0, 9)
      .filter(
        (t) =>
          t &&
          typeof t === 'object' &&
          typeof t.prompt === 'string' &&
          Array.isArray(t.options)
      )
      .map((t) => ({
        label: typeof t.label === 'string' ? clipString(t.label, 100) : undefined,
        prompt: clipString(t.prompt, MAX_DESC_LEN),
        options: sanitizeOptions(t.options),
      }))
      .filter((t) => t.options.length > 0)
    if (safeTabs.length === 0) safeTabs = null
    // tabs 存在時は options を Sentinel ["Submit"] に揃える(旧 UI 互換 + 一括承認除外の手がかり)
    if (safeTabs) safeOptions = ['Submit']
  }

  const item = {
    id: crypto.randomUUID(),
    description: safeDesc,
    options: safeOptions,
    tabs: safeTabs, // null または [{label?, prompt, options}]
    status: 'pending', // pending | resolved
    answer: null,
    answers: null, // 複合質問の回答配列(null または string[])
    resolvedBy: null, // 'pc' | 'smartphone' | 'cli'
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  }
  queue.push(item)
  console.log(`[NEW REQUEST] ${item.id}: ${safeDesc}${safeTabs ? ` (${safeTabs.length} tabs)` : ''}`)
  res.json({ id: item.id, status: item.status })
})

/**
 * GET /status/:id[?wait=N]
 * エージェントが承認結果を取得する。
 *   wait = 秒数（1〜60）を指定すると、pending の場合はそのまま接続を保持し、
 *   resolve されたタイミングで即応答する（long-poll）。
 *   wait 無指定 or 0 なら従来どおり即応答。
 */
app.get('/status/:id', authenticate, (req, res) => {
  const item = queue.find((q) => q.id === req.params.id)
  if (!item) return res.status(404).json({ error: 'Not found' })

  const buildStatusResp = () => ({
    id: item.id,
    status: item.status,
    answer: item.answer,
    answers: item.answers, // 複合質問の回答配列(null または string[])
  })

  const wait = Math.min(Math.max(parseInt(req.query.wait) || 0, 0), 60)
  if (item.status === 'resolved' || wait === 0) {
    return res.json(buildStatusResp())
  }

  const send = () => {
    res.json(buildStatusResp())
  }
  const onResolve = () => {
    clearTimeout(timer)
    send()
  }
  const timer = setTimeout(() => {
    resolveEvents.off(item.id, onResolve)
    send()
  }, wait * 1000)
  resolveEvents.once(item.id, onResolve)
  req.on('close', () => {
    clearTimeout(timer)
    resolveEvents.off(item.id, onResolve)
  })
})

// -------------------------------------------------------
// スマホUI側API（トークン認証あり）
// -------------------------------------------------------

/**
 * GET /queue
 * pendingな依頼一覧を返す
 */
app.get('/queue', authenticate, (req, res) => {
  const pending = queue.filter((q) => q.status === 'pending')
  res.json(pending)
})

/**
 * POST /resolve/:id
 * スマホから承認 or 拒否する
 * Body: { action: "approved" | "rejected" }
 */
app.post('/resolve/:id', authenticate, (req, res) => {
  const { answer, answers, resolvedBy } = req.body
  const hasAnswers = Array.isArray(answers)
  if (!answer && !hasAnswers) {
    return res.status(400).json({ error: 'answer or answers is required' })
  }

  const item = queue.find((q) => q.id === req.params.id)
  if (!item) return res.status(404).json({ error: 'Not found' })
  if (item.status !== 'pending') {
    return res.status(409).json({ error: 'Already resolved' })
  }

  const allowedResolvedBy = ['pc', 'smartphone', 'cli']
  const safeResolvedBy = allowedResolvedBy.includes(resolvedBy) ? resolvedBy : null

  let safeAnswer = null
  let safeAnswers = null

  if (hasAnswers) {
    // 複合質問: tabs を持つ item でしか受理しない、長さ一致と数字 1〜9 を厳格チェック
    if (!Array.isArray(item.tabs)) {
      return res.status(400).json({ error: 'answers is only allowed for tabbed items' })
    }
    if (answers.length !== item.tabs.length) {
      return res.status(400).json({ error: 'answers.length must match tabs.length' })
    }
    if (answers.length > 9) {
      return res.status(400).json({ error: 'answers too long' })
    }
    const norm = []
    for (let i = 0; i < answers.length; i++) {
      const a = String(answers[i] == null ? '' : answers[i]).trim()
      if (!/^[1-9]$/.test(a)) {
        return res.status(400).json({ error: `answers[${i}] must be a digit 1-9` })
      }
      const idx = parseInt(a, 10) - 1
      if (idx >= item.tabs[i].options.length) {
        return res.status(400).json({ error: `answers[${i}] out of range` })
      }
      norm.push(a)
    }
    safeAnswers = norm
    // 互換のため answer にも要約を残す
    safeAnswer = norm.join(',')
  } else {
    if (typeof answer !== 'string') {
      return res.status(400).json({ error: 'answer must be a string' })
    }
    // tabs 持ち item は CLI からの "resolved-by-cli" 通知のみ answer 単独を受理する。
    // 旧 UI / 第三者から answer="Submit" 等が来ても wrapper では再生不能なので
    // ここで弾いて、複合質問は必ず answers 経路を通すようにする。
    if (Array.isArray(item.tabs) && answer !== 'resolved-by-cli') {
      return res.status(400).json({ error: 'tabbed items require answers array' })
    }
    safeAnswer = answer.length > 100 ? answer.slice(0, 100) : answer
  }

  item.status = 'resolved'
  item.answer = safeAnswer
  item.answers = safeAnswers
  item.resolvedBy = safeResolvedBy
  item.resolvedAt = new Date().toISOString()
  console.log(
    `[RESOLVED] ${item.id}: ${safeAnswers ? `answers=${JSON.stringify(safeAnswers)}` : `answer=${item.answer}`} (by ${item.resolvedBy || 'unknown'})`
  )

  // long-poll 中の /status/:id を即座に返す
  resolveEvents.emit(item.id, item)

  res.json({ id: item.id, status: item.status })
})

/**
 * DELETE /history
 * resolved 済みエントリをサーバー側からまとめて除去する。
 * UI の「すべて削除」操作で呼ばれる。pending には触れない。
 */
app.delete('/history', authenticate, (req, res) => {
  let removed = 0
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].status === 'resolved') {
      queue.splice(i, 1)
      removed++
    }
  }
  console.log(`[HISTORY CLEAR] removed ${removed} resolved entries`)
  res.json({ removed })
})

// -------------------------------------------------------
// サーバー起動
// -------------------------------------------------------
const server = http.createServer(app)

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const alt = PORT + 1
    console.error(`\n❌ ポート ${PORT} は既に使用中です。`)
    console.error(`   他のターミナルで approval-server.js が起動済みでないか確認してください。`)
    console.error(`   別のポートで起動する場合:`)
    console.error(`     PowerShell: $env:APPROVAL_PORT=${alt}; node approval-server.js`)
    console.error(`     CMD:        set APPROVAL_PORT=${alt} && node approval-server.js`)
    console.error(`     bash:       APPROVAL_PORT=${alt} node approval-server.js`)
    if (config.port) {
      console.error(
        `   （APPROVAL_PORT を設定すれば approval-config.json の port (${config.port}) より優先されます）\n`
      )
    } else {
      console.error('')
    }
  } else {
    console.error(`\n❌ サーバー起動エラー: ${err.message}\n`)
  }
  process.exit(1)
})

// C2: 明示的に 127.0.0.1 にバインド（LAN 他端末からの直接アクセスを防止）
// 外部アクセスは ngrok トンネル経由のみに限定される。
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n✅ Approval server running on http://127.0.0.1:${PORT} (loopback only)`)
  console.log(`\n🔑 SECRET_TOKEN: ${SECRET_TOKEN}`)
  console.log(`   (スマホUIとエージェントコードにこのトークンを設定してください)\n`)
  console.log(`次のステップ:`)
  console.log(`  1. 別ターミナルで: ngrok http ${PORT}`)
  console.log(`  2. ngrokが表示したURLをスマホUIに設定`)
  console.log(`  3. エージェントコードでもURLとトークンを設定\n`)
})

// -------------------------------------------------------
// エージェントから使うヘルパー関数（同プロセス内で使う場合）
// -------------------------------------------------------

/**
 * requestApproval(description)
 * 承認が得られるまで待機するPromiseを返す
 *
 * 使用例:
 *   const { requestApproval } = require('./approval-server');
 *   const approved = await requestApproval('ファイルを削除します: /tmp/test.txt');
 *   if (approved) { ... }
 */
async function requestApproval(description, options = ['Yes', 'No']) {
  const BASE_URL = `http://localhost:${PORT}`

  // 依頼登録
  const res = await fetch(`${BASE_URL}/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-secret-token': SECRET_TOKEN,
    },
    body: JSON.stringify({ description, options }),
  })
  const { id } = await res.json()

  console.log(`[WAITING] 承認待ち: ${id}`)

  // ポーリングで結果待ち（5秒ごと、最大10分）
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    const poll = await fetch(`${BASE_URL}/status/${id}`, {
      headers: { 'x-secret-token': SECRET_TOKEN },
    })
    const { status } = await poll.json()
    if (status === 'approved') return true
    if (status === 'rejected') return false
  }

  console.warn(`[TIMEOUT] 承認タイムアウト: ${id}`)
  return false
}

module.exports = { requestApproval }
