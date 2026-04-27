/**
 * test-e2e.js — claude-wrapper の end-to-end テスト
 *
 * フロー:
 *   1. node-pty で claude-wrapper.js を起動
 *   2. Claude TUI 起動を待ち、Write ダイアログを発生させるプロンプト送信
 *   3. ダイアログが approval-server の /queue に現れるのを検知
 *   4. 疑似スマホ応答として /resolve に "Yes" を POST
 *   5. wrapper が PTY に "1\r" を注入し、Claude が Write 実行 → ファイル作成
 *   6. 作成ファイルを確認してテスト成功判定
 */

const pty = require('node-pty')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'approval-config.json'), 'utf8'))
const TOKEN = CFG.token
const PORT = CFG.port

function httpReq(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: p,
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-secret-token': TOKEN,
          ...(data ? { 'Content-Length': data.length } : {}),
        },
      },
      (res) => {
        let buf = ''
        res.on('data', (d) => (buf += d))
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${buf}`))
          try {
            resolve(JSON.parse(buf))
          } catch (_) {
            resolve(buf)
          }
        })
      }
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const testFile = path.join(__dirname, 'e2e-test-output.txt')
// Clean up previous
try {
  fs.unlinkSync(testFile)
} catch (_) {}

const isWindows = os.platform() === 'win32'
const shell = isWindows ? 'cmd.exe' : '/bin/bash'
const args = isWindows ? ['/c', 'node', 'claude-wrapper.js'] : ['-c', 'node claude-wrapper.js']

const debugLog = fs.createWriteStream(path.join(__dirname, 'e2e-debug.log'), { flags: 'w' })
const ptyEnv = { ...process.env, APPROVAL_PTY_LOG: path.join(__dirname, 'e2e-pty.log') }

const term = pty.spawn(shell, args, {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: __dirname,
  env: ptyEnv,
})

let buf = ''
term.onData((d) => {
  buf += d
  debugLog.write(d)
})

async function main() {
  console.log('[test] wrapper spawned, waiting for Claude TUI...')
  await wait(6000)

  const prompt = 'Write a file named e2e-test-output.txt in the current directory with content "e2e ok". Use the Write tool.'
  term.write(prompt)
  await wait(800)
  term.write('\r')
  console.log('[test] prompt sent, waiting for /queue to receive request...')

  // ダイアログがサーバーに届くのを待つ（Opus xhigh は遅いので余裕を持たせる）
  let item = null
  for (let i = 0; i < 180; i++) {
    await wait(1000)
    try {
      const q = await httpReq('GET', '/queue', null)
      if (q.length > 0) {
        item = q[0]
        console.log(`[test] queue received: id=${item.id} desc="${item.description.slice(0, 80)}"`)
        console.log(`[test] options: ${JSON.stringify(item.options)}`)
        break
      }
    } catch (_) {}
  }
  if (!item) {
    console.error('[test] FAIL: dialog did not reach server within 60s')
    term.kill()
    process.exit(1)
  }

  // Option 1 の label を answer として送信（正規の UI と同じ動作）
  const answer = item.options[0]
  console.log(`[test] sending /resolve answer="${answer}"`)
  await httpReq('POST', `/resolve/${item.id}`, {
    answer,
    resolvedBy: 'smartphone',
  })

  // wrapper が PTY に "1\r" を注入し、Claude が Write を実行するのを待つ
  console.log('[test] waiting for wrapper to inject response and file to be created...')
  for (let i = 0; i < 30; i++) {
    await wait(1000)
    if (fs.existsSync(testFile)) {
      const content = fs.readFileSync(testFile, 'utf8')
      console.log(`[test] PASS: ${testFile} created with content: "${content}"`)
      cleanup(0)
      return
    }
  }
  console.error('[test] FAIL: file not created within 30s')
  cleanup(1)
}

function cleanup(code) {
  try {
    term.write('\x03')
  } catch (_) {}
  setTimeout(() => {
    try {
      term.kill()
    } catch (_) {}
    // Clean up test artifact
    try {
      fs.unlinkSync(testFile)
    } catch (_) {}
    process.exit(code)
  }, 1500)
}

main().catch((e) => {
  console.error('[test] error:', e)
  cleanup(1)
})
