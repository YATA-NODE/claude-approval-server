/**
 * test-parse-dialog.js
 *
 * claude-wrapper.js の parseDialog / stripAnsi をユニットテストする。
 * 引数でログファイルが渡されればそれも追加で解析する。
 *
 * 使い方:
 *   node test-parse-dialog.js                       ← ユニットテストのみ
 *   node test-parse-dialog.js /tmp/pty.log          ← ユニットテスト + 実 PTY ログ解析
 */

const fs = require('fs')

const { parseDialog, stripAnsi } = require('./claude-wrapper.js')

let failed = 0
let passed = 0

function assertEq(label, actual, expected) {
  const ok =
    typeof expected === 'object'
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : actual === expected
  if (ok) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}`)
    console.log(`     expected: ${JSON.stringify(expected)}`)
    console.log(`     actual  : ${JSON.stringify(actual)}`)
  }
}

// -------------------------------------------------------
// 1. stripAnsi: cursor-right (\x1b[<n>C) を空白に展開する
// -------------------------------------------------------
console.log('[1] stripAnsi cursor-right expansion')
{
  const input = 'Do\x1b[1Cyou\x1b[1Cwant\x1b[1Cto\x1b[1Ccreate?'
  assertEq('単一空白展開', stripAnsi(input), 'Do you want to create?')

  const input2 = 'A\x1b[3CB'
  assertEq('複数列ジャンプ', stripAnsi(input2), 'A   B')

  const input3 = 'X\x1b[CY'
  assertEq('数字省略 (= 1)', stripAnsi(input3), 'X Y')

  const input4 = 'A\x1b[1CB\x1b[1A'
  assertEq('cursor-right 以外の CSI は除去', stripAnsi(input4), 'A B')
}

// -------------------------------------------------------
// 2. parseDialog: 標準的な Write ダイアログ
// -------------------------------------------------------
console.log('\n[2] parseDialog: Write ダイアログ (●Tool 行あり)')
{
  const buf = [
    '● Write(test.txt)',
    '─────',
    ' Create file',
    ' test.txt',
    '╌╌╌╌',
    ' Do you want to create test.txt?',
    ' ❯ 1. Yes',
    '   2. Yes, allow shift+tab',
    '   3. No',
    ' Esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('prompt', r && r.prompt, 'Do you want to create test.txt?')
  assertEq('tool', r && r.tool, 'Write')
  assertEq('args', r && r.args, 'test.txt')
  assertEq('options', r && r.options, ['Yes', 'Yes, allow shift+tab', 'No'])
}

// -------------------------------------------------------
// 3. parseDialog: tool=Unknown 時に box ラベルから Bash を推測
// -------------------------------------------------------
console.log('\n[3] parseDialog: Bash fallback (●Tool 行なし)')
{
  const buf = [
    '─────',
    ' Bash command',
    '   rm /home/koishi/test.txt',
    '   Delete test.txt',
    '╌╌╌╌',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    ' Esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('prompt', r && r.prompt, 'Do you want to proceed?')
  assertEq('tool', r && r.tool, 'Bash')
  // args は "Bash command" 直後の対象行を拾えていれば OK（rm コマンド全文 or 短縮）
  assertEq(
    'args に rm 文字列を含む',
    !!(r && r.args && r.args.includes('rm /home/koishi/test.txt')),
    true
  )
  assertEq('options', r && r.options, ['Yes', 'No'])
}

// -------------------------------------------------------
// 4. parseDialog: 旧コンパクト形式（空白なし）でも検出はできる
// -------------------------------------------------------
console.log('\n[4] parseDialog: 空白なし旧形式')
{
  const buf = [
    '─────',
    ' Createfile',
    ' test.txt',
    '╌╌╌╌',
    ' Doyouwanttocreatetest.txt?',
    ' ❯1Yes',
    '  2Yesallowshift+tab',
    '  3No',
    ' Esctocancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('options 数 = 3', r && r.options.length, 3)
  assertEq('tool=Write (Createfile ラベル fallback)', r && r.tool, 'Write')
}

// -------------------------------------------------------
// 5. parseDialog: 偽陽性除外（カーソル `❯` がない場合は null）
// -------------------------------------------------------
console.log('\n[5] parseDialog: 偽陽性除外')
{
  const buf = ' Some output mentioning Esc to cancel? but no dialog'
  assertEq('カーソル無し → null', parseDialog(buf), null)
}

// -------------------------------------------------------
// 結果サマリ
// -------------------------------------------------------
console.log('\n────────────────────────────────────────')
console.log(`  passed: ${passed}, failed: ${failed}`)
console.log('────────────────────────────────────────\n')

// -------------------------------------------------------
// オプション: 実 PTY ログを追加で解析
// -------------------------------------------------------
const logPath = process.argv[2]
if (logPath) {
  if (!fs.existsSync(logPath)) {
    console.error(`ログファイルが見つかりません: ${logPath}`)
    process.exit(failed ? 2 : 1)
  }
  const raw = fs.readFileSync(logPath, 'utf8')
  console.log(`[log] ${logPath}: ${raw.length} bytes`)
  const cleaned = stripAnsi(raw)
  console.log(`[log] stripAnsi 後: ${cleaned.length} chars\n`)
  const r = parseDialog(cleaned)
  if (!r) {
    console.log('❌ parseDialog → null (検出できず)')
  } else {
    console.log('✅ parseDialog → 検出成功')
    console.log(`  prompt : ${JSON.stringify(r.prompt)}`)
    console.log(`  tool   : ${r.tool}`)
    console.log(`  args   : ${JSON.stringify(r.args)}`)
    console.log(`  options: ${JSON.stringify(r.options, null, 2)}`)
  }
}

process.exit(failed ? 2 : 0)
