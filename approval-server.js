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

const app = express()
const PORT = parseInt(process.env.APPROVAL_PORT) || 3000

// ★ セキュリティ用トークン
// 環境変数 APPROVAL_TOKEN を設定して固定運用推奨（未設定時は起動ごとにランダム生成）
const SECRET_TOKEN = process.env.APPROVAL_TOKEN || crypto.randomBytes(16).toString('hex')

app.use(cors())
app.use(express.json())
app.use(express.static(__dirname))

// ルートアクセスで approval-ui.html を返す
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/approval-ui.html')
})

// 承認待ちキュー: { id, description, status, createdAt, resolvedAt }
const queue = []

// トークン認証ミドルウェア
function authenticate(req, res, next) {
  const token = req.headers['x-secret-token']
  if (token !== SECRET_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
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
app.post('/request', authenticate, (req, res) => {
  const { description, options } = req.body
  if (!description) return res.status(400).json({ error: 'description is required' })

  const item = {
    id: crypto.randomUUID(),
    description,
    options: options || ['Yes', 'No'],
    status: 'pending', // pending | resolved
    answer: null,
    resolvedBy: null, // 'pc' | 'smartphone'
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  }
  queue.push(item)
  console.log(`[NEW REQUEST] ${item.id}: ${description}`)
  res.json({ id: item.id, status: item.status })
})

/**
 * GET /status/:id
 * エージェントが承認結果をポーリングする
 */
app.get('/status/:id', authenticate, (req, res) => {
  const item = queue.find((q) => q.id === req.params.id)
  if (!item) return res.status(404).json({ error: 'Not found' })
  res.json({ id: item.id, status: item.status, answer: item.answer })
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
  const { answer, resolvedBy } = req.body
  if (!answer) return res.status(400).json({ error: 'answer is required' })

  const item = queue.find((q) => q.id === req.params.id)
  if (!item) return res.status(404).json({ error: 'Not found' })
  if (item.status !== 'pending') {
    return res.status(409).json({ error: 'Already resolved' })
  }

  item.status = 'resolved'
  item.answer = answer
  item.resolvedBy = resolvedBy || null
  item.resolvedAt = new Date().toISOString()
  console.log(`[RESOLVED] ${item.id}: ${item.answer} (by ${item.resolvedBy || 'unknown'})`)
  res.json({ id: item.id, status: item.status })
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
    console.error(`     bash:       APPROVAL_PORT=${alt} node approval-server.js\n`)
  } else {
    console.error(`\n❌ サーバー起動エラー: ${err.message}\n`)
  }
  process.exit(1)
})

server.listen(PORT, () => {
  console.log(`\n✅ Approval server running on http://localhost:${PORT}`)
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
