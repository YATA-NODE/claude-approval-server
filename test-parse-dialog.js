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

const {
  parseDialog,
  stripAnsi,
  validateAnswer,
  isTabbedDialog,
  validateMultiAnswer,
} = require('./claude-wrapper.js')

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
// 6. parseDialog: AskUserQuestion 型 4 択（tool 行なし・shift+tab 不在・長文）
// -------------------------------------------------------
console.log('\n[6] parseDialog: AskUserQuestion 4 択')
{
  const buf = [
    '─────',
    ' Auto-Switch Configuration',
    '╌╌╌╌',
    ' Which auto-switch mode do you prefer for short tasks?',
    ' ❯ 1. Skip auto-switch (Recommended)',
    '   2. Enable for short tasks only when the model is idle',
    '   3. Enable for all tasks regardless of token cost',
    '   4. Decide each time with a confirmation dialog',
    ' Esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('options 数 = 4', r && r.options.length, 4)
  assertEq('tool=AskUserQuestion', r && r.tool, 'AskUserQuestion')
  assertEq(
    'options[0] 冒頭が欠けない',
    r && r.options[0].startsWith('Skip auto-switch'),
    true
  )
}

// -------------------------------------------------------
// 7. parseDialog: 選択肢本文に「1 枚目」「2 枚目」を含むケース（誤検知防止）
// -------------------------------------------------------
console.log('\n[7] parseDialog: 本文中の数字を誤検知しない')
{
  const buf = [
    '─────',
    ' 2 枚の図の扱いを選んでください?',
    ' ❯ 1. 1 枚目を採用',
    '   2. 2 枚目を採用',
    '   3. 両方採用',
    ' Esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('options 数 = 3', r && r.options.length, 3)
  assertEq(
    'options[0] = "1 枚目を採用"（冒頭の 1 が欠けない）',
    r && r.options[0],
    '1 枚目を採用'
  )
  assertEq(
    'options[1] = "2 枚目を採用"（冒頭の 2 が欠けない）',
    r && r.options[1],
    '2 枚目を採用'
  )
  assertEq('options[2] = "両方採用"', r && r.options[2], '両方採用')
  assertEq(
    'prompt 冒頭の "2 " が欠けない',
    r && r.prompt.startsWith('2 枚の図'),
    true
  )
}

// -------------------------------------------------------
// 8. parseDialog: 6 択 + validateAnswer の数字キー範囲
// -------------------------------------------------------
console.log('\n[8] parseDialog: 6 択 + validateAnswer')
{
  const buf = [
    '─────',
    ' What would you like to do next?',
    ' ❯ 1. Continue interview',
    '   2. Skip interview and plan immediately',
    '   3. Chat about this',
    '   4. Type something',
    '   5. Pause and review',
    '   6. Cancel session',
    ' Esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('options 数 = 6', r && r.options.length, 6)
  if (r) {
    assertEq('validateAnswer("5") = "5"', validateAnswer('5', r.options), '5')
    assertEq('validateAnswer("6") = "6"', validateAnswer('6', r.options), '6')
    assertEq(
      'validateAnswer("7") = null（範囲外）',
      validateAnswer('7', r.options),
      null
    )
    assertEq(
      'validateAnswer(完全一致) で番号に正規化',
      validateAnswer('Pause and review', r.options),
      '5'
    )
  }
}

// -------------------------------------------------------
// 9. isTabbedDialog: タブバー検出
// -------------------------------------------------------
console.log('\n[9] isTabbedDialog: タブ式 UI 検出')
{
  const tabbed = [
    '□統合方式 □図再生成 ✓整理 □tier ✓Submit →',
    ' 新候補を既存レポートにどう統合しますか?',
    ' ❯ 1. A 案',
    '   2. B 案',
    ' Esc to cancel · Tab/Arrow keys to navigate',
  ].join('\n')
  assertEq('タブ式 → true', isTabbedDialog(tabbed), true)

  const single = [
    '● Write(test.txt)',
    ' Do you want to create test.txt?',
    ' ❯ 1. Yes',
    '   2. No',
    ' Esc to cancel',
  ].join('\n')
  assertEq('単一質問 → false', isTabbedDialog(single), false)

  assertEq('空文字 → false', isTabbedDialog(''), false)
}

// -------------------------------------------------------
// 10. validateMultiAnswer: 複合質問の回答配列検証
// -------------------------------------------------------
console.log('\n[10] validateMultiAnswer')
{
  const tabs = [
    { prompt: 'q1', options: ['a', 'b', 'c'] },
    { prompt: 'q2', options: ['x', 'y'] },
    { prompt: 'q3', options: ['p', 'q', 'r', 's'] },
  ]
  assertEq('正常 ["1","2","3"]', validateMultiAnswer(['1', '2', '3'], tabs), ['1', '2', '3'])
  assertEq('長さ不一致 → null', validateMultiAnswer(['1', '2'], tabs), null)
  assertEq('範囲外 → null', validateMultiAnswer(['1', '3', '1'], tabs), null) // q2 は 1〜2 のみ
  assertEq('数字以外 → null', validateMultiAnswer(['1', 'x', '1'], tabs), null)
  assertEq('空配列 + 空 tabs → null', validateMultiAnswer([], []), null)
  assertEq('null tabs → null', validateMultiAnswer(['1'], null), null)
  assertEq('9 件超 → null', validateMultiAnswer(['1', '1', '1', '1', '1', '1', '1', '1', '1', '1'], new Array(10).fill({ options: ['a'] })), null)
}

// -------------------------------------------------------
// 11. parseDialog はタブ式入力でも単一タブとして解釈する(sweep 前提)
// -------------------------------------------------------
console.log('\n[11] parseDialog はタブ式入力の現タブのみ抽出')
{
  // タブ式 UI でも parseDialog は現在見えているタブの ❯ + 選択肢を抽出する
  const buf = [
    '□統合方式 □図再生成 ✓整理 ✓Submit →',
    '─────',
    ' 新候補を既存レポートにどう統合しますか?',
    ' ❯ 1. 7→9 候補化',
    '   2. 新ゾーン追加',
    '   3. 補遺ファイル追記のみ',
    ' Esc to cancel · Tab/Arrow keys to navigate',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('options 数 = 3', r && r.options.length, 3)
  assertEq('現タブの prompt が取れる', r && r.prompt.includes('新候補'), true)
  assertEq('isTabbedDialog も true', isTabbedDialog(buf), true)
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
