/**
 * claude-hook.js
 * Claude CodeのPreToolUseフックスクリプト
 *
 * 配置場所: C:\Users\haya-\Lab\YATA-NODE\site\approval-server\claude-hook.js
 *
 * settings.jsonで以下のように設定:
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": ".*",
 *       "hooks": [{
 *         "type": "command",
 *         "command": "node C:\\Users\\haya-\\Lab\\YATA-NODE\\site\\approval-server\\claude-hook.js"
 *       }]
 *     }]
 *   }
 * }
 *
 * 判断基準:
 *   プロジェクトの .claude/settings.local.json の permissions.allow リストを読み取り、
 *   そこに含まれていないツールだけスマホへ送信する。
 *   → PCにダイアログが表示されるかどうかと完全に一致する。
 */

const http = require('http')
const fs = require('fs')
const path = require('path')

const log = (msg) =>
  fs.appendFileSync(
    'C:\\Users\\haya-\\claude-hook-debug.log',
    new Date().toISOString() + ' ' + msg + '\n'
  )

const SECRET_TOKEN = process.env.APPROVAL_TOKEN || ''
const SERVER_URL = 'http://localhost:3000'
const POLL_INTERVAL = 3000
const TIMEOUT = 3600000

/**
 * プロジェクトの .claude/settings.local.json から permissions.allow を読み取る。
 * ファイルが存在しない・壊れている場合は空配列を返す（全ツールをスマホへ送る安全側）。
 */
function loadAllowList() {
  const settingsPath = path.join(process.cwd(), '.claude', 'settings.local.json')
  try {
    const content = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    return content?.permissions?.allow || []
  } catch (_) {
    return []
  }
}

/**
 * ツール名が allow リストのいずれかのルールに一致するか判定する。
 *
 * ルール形式:
 *   "Read"         → ツール名が完全一致
 *   "Bash(*)"      → ツール名が "Bash" に一致（引数パターンは無視してツール名のみ比較）
 *   "mcp__xxx"     → 完全一致
 */
function isAllowed(toolName, allowList) {
  for (const rule of allowList) {
    // パターン形式 "ToolName(...)" → ツール名部分だけ比較
    const parenIndex = rule.indexOf('(')
    const ruleName = parenIndex !== -1 ? rule.slice(0, parenIndex) : rule
    if (ruleName === toolName) return true
  }
  return false
}

// stdinからJSONを読み込む
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', async () => {
  let data
  try {
    data = JSON.parse(input)
  } catch (_) {
    process.exit(0)
  }

  const toolName = data.tool_name || 'Unknown'
  const toolInput = data.tool_input || {}

  // allow リストに含まれているツール = PCにダイアログが出ない = スマホへ送らない
  const allowList = loadAllowList()
  if (isAllowed(toolName, allowList)) {
    process.exit(0)
  }

  // プロジェクト名（cwdの末尾フォルダ名）を取得
  const projectName = path.basename(process.cwd())

  // 説明文を作成
  let description = `[${projectName}][${toolName}]`
  if (toolInput.command) {
    description += ` ${toolInput.command}`
  } else if (toolInput.file_path) {
    description += ` ${toolInput.file_path}`
  } else {
    description += ` ${JSON.stringify(toolInput).slice(0, 100)}`
  }

  // approval-serverに依頼を送信
  let requestId
  try {
    const body = JSON.stringify({ description, options: ['Yes', 'No'] })
    log('sending request: ' + description + ' token:' + SECRET_TOKEN.slice(0, 8))
    requestId = await postRequest('/request', body)
  } catch (e) {
    process.stderr.write(`approval-server接続失敗: ${e.message}\n`)
    process.exit(0)
  }

  // スマホで承認されるまでポーリング
  const startTime = Date.now()
  while (Date.now() - startTime < TIMEOUT) {
    await sleep(POLL_INTERVAL)
    try {
      const status = await getRequest(`/status/${requestId}`)
      if (status.status === 'resolved') {
        const answer = (status.answer || '').toLowerCase()
        if (answer === 'no' || answer === 'rejected' || answer === 'deny' || answer === 'cancel') {
          process.stderr.write(`スマホで拒否されました: ${description}\n`)
          process.exit(2)
        } else {
          process.exit(0)
        }
      }
    } catch (_) {
      // ポーリングエラーは無視
    }
  }

  process.stderr.write(`承認タイムアウト（1時間）: ${description}\n`)
  process.exit(2)
})

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function postRequest(path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: 3000,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-secret-token': SECRET_TOKEN,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (d) => (data += d))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data).id)
          } catch (_) {
            reject(new Error('Invalid response'))
          }
        })
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function getRequest(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: 3000,
        path,
        method: 'GET',
        headers: { 'x-secret-token': SECRET_TOKEN },
      },
      (res) => {
        let data = ''
        res.on('data', (d) => (data += d))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (_) {
            reject(new Error('Invalid response'))
          }
        })
      }
    )
    req.on('error', reject)
    req.end()
  })
}
