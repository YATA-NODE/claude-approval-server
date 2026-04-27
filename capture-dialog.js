/**
 * capture-dialog.js
 *
 * Claude Code TUI を PTY で起動し、承認が必要なプロンプトを打ち込んで
 * ダイアログ出力を捕捉する開発用ツール。
 *
 * 使い方:
 *   node capture-dialog.js
 *
 * 出力: ./pty-sample.log にフル出力を保存し、最後の画面相当を標準出力にも出す。
 */

const pty = require('node-pty')
const fs = require('fs')
const os = require('os')
const path = require('path')

const isWindows = os.platform() === 'win32'
const shell = isWindows ? 'cmd.exe' : '/bin/bash'
const args = isWindows ? ['/c', 'claude'] : ['-c', 'claude']

const cols = 120
const rows = 30

const userPrompt =
  process.argv[2] ||
  'Write a file named claude-test-xyz.txt in the current directory with content "hello world". Use the Write tool.'
const logFile = process.argv[3] || 'pty-sample.log'

const logPath = path.join(__dirname, logFile)
const logStream = fs.createWriteStream(logPath, { flags: 'w' })

const term = pty.spawn(shell, args, {
  name: 'xterm-256color',
  cols,
  rows,
  cwd: __dirname,
  env: process.env,
})

let buffer = ''
term.onData((data) => {
  buffer += data
  logStream.write(data)
})

// シーケンス制御
// 1. 起動してから 4 秒待つ（初期描画完了）
// 2. プロンプト送信
// 3. 12 秒待って、出力を確認
// 4. いったん Esc で戻して、プロセス終了
async function run() {
  // Claude Code TUI の初期描画を待つ（起動直後は描画バッチが走っている）
  await wait(6000)

  // 1 文字ずつではなく一括で流し、別途 Enter を送る
  term.write(userPrompt)
  await wait(800)
  term.write('\r') // Enter 送信
  console.log('[capture] prompt + Enter sent, waiting for dialog...')

  // 承認ダイアログらしきパターンを待つ
  const patterns = [/Do you want to/i, /1\.\s*Yes/, /No, and tell Claude/, /❯.*Yes/]
  const deadline = Date.now() + 45000
  let detected = false
  while (Date.now() < deadline) {
    if (patterns.some((p) => p.test(buffer))) {
      console.log('[capture] dialog pattern detected')
      detected = true
      await wait(2000) // 描画完了まで追加待機
      break
    }
    await wait(500)
  }
  if (!detected) console.log('[capture] dialog NOT detected within timeout')

  // 終了（Ctrl+C を 2 回）
  term.write('\x03')
  await wait(500)
  term.write('\x03')
  await wait(1500)
  term.kill()
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

term.onExit(({ exitCode }) => {
  logStream.end(() => {
    console.log(`[capture] exited code=${exitCode}, log saved: ${logPath}`)
    console.log('[capture] last 2000 bytes:')
    console.log(buffer.slice(-2000))
    process.exit(0)
  })
})

run().catch((e) => {
  console.error('[capture] error:', e)
  term.kill()
})
