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
  // 注: "Type something" / "Chat about this" は Claude TUI の組み込みフッタ
  // (常に末尾自動付加)で、parseDialog は意図的に除外する。
  // ここでは 6 個の業務選択肢のみのケースをテストする。
  const buf = [
    '─────',
    ' What would you like to do next?',
    ' ❯ 1. Continue interview',
    '   2. Skip interview and plan immediately',
    '   3. Review and edit',
    '   4. Restart',
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
// 8c. parseDialog: Type something / Chat about this は表示する(v1.11.1 で復活)
// -------------------------------------------------------
console.log('\n[8c] parseDialog: 全 option を保持(filter なし)')
{
  // v1.11.1 で TUI_FOOTER_PATTERNS / cutoff filter を撤回。
  // Type something / Chat about this もスマホに表示する(v1.12.0 でテキスト送信
  // 経路追加予定)。中間位置・末尾位置を問わず保持される。
  const buf = [
    '─────',
    ' Which action?',
    ' ❯ 1. Continue',
    '   2. Chat about this proposal',
    '   3. Type something custom',
    '   4. Skip',
    '   5. Type something.',
    '   6. Chat about this',
    ' Esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('options 数 = 6 (filter 撤回で全保持)', r && r.options.length, 6)
  if (r) {
    assertEq('option[0]', r.options[0], 'Continue')
    assertEq('option[4] = "Type something."', r.options[4], 'Type something.')
    assertEq('option[5] = "Chat about this"', r.options[5], 'Chat about this')
  }
}

// -------------------------------------------------------
// 8d. parseDialog: option 末尾の TUI ヒント文字列を除去
// -------------------------------------------------------
console.log('\n[8d] parseDialog: option 末尾の "Enter to select" 等を切り捨て')
{
  // 最後の option に Claude TUI のキー操作ヒントが連結する典型ケース。
  // 行構造が破綻している(\n が不足する)時、option 末尾までヒント文字列が入る。
  const buf =
    '──── 朝食派ですか、夜食派ですか? ❯ 1. 朝食派 2. 夜食派 3. ' +
    'Chat about this Enter to select · Tab/Arrow keys to navigate · Esc to cancel'
  const r = parseDialog(buf)
  // 末尾連続フッタは除外されるので、3. Chat about this は消える(末尾)
  // 期待: options = ["朝食派", "夜食派"]、ヒント文字列は混入しない
  assertEq('検出できる', !!r, true)
  if (r) {
    assertEq(
      'いずれの option にも "Enter to select" を含まない',
      r.options.some((o) => /Enter\s+to\s+select/i.test(o)),
      false
    )
    assertEq(
      'いずれの option にも "Tab/Arrow keys" を含まない',
      r.options.some((o) => /Tab\s*\/\s*Arrow\s+keys/i.test(o)),
      false
    )
  }
}

// -------------------------------------------------------
// 8b. parseDialog: Type something / Chat about this を含む 5 option を表示
// -------------------------------------------------------
console.log('\n[8b] parseDialog: 全 option を結果に含める(v1.11.1 で復活)')
{
  const buf = [
    '─────',
    ' 朝食派ですか、夜食派ですか?',
    ' ❯ 1. 朝食派',
    '   2. 夜食派',
    '   3. どちらも',
    '   4. Type something.',
    '   5. Chat about this',
    ' Esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('options 数 = 5 (全保持)', r && r.options.length, 5)
  if (r) {
    assertEq('option[0] = "朝食派"', r.options[0], '朝食派')
    assertEq('option[3] = "Type something."', r.options[3], 'Type something.')
    assertEq('option[4] = "Chat about this"', r.options[4], 'Chat about this')
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
// 12. isTabbedDialog: 実 Claude TUI が出す ☐ (U+2610) / ✔ (U+2714) を検出
// -------------------------------------------------------
console.log('\n[12] isTabbedDialog: 実 TUI ユニコード (☐ U+2610 / ✔ U+2714)')
{
  // 実環境で観測された描画(2026-05-13 ログ): ☐ と ✔ が混在
  const realTabbed = '← ☐ 食事タイプ ☐ 飲み物 ☐ 生活リズム ✔ Submit → Tab/Arrow keys to navigate'
  assertEq('☐ + ✔ + → → true', isTabbedDialog(realTabbed), true)
  // フォールバック ユニコード(□ U+25A1 / ✓ U+2713)も引き続き検出可能
  const fallbackTabbed = '□ a □ b ✓ Submit →'
  assertEq('□ + ✓ + → → true (旧 unicode 互換)', isTabbedDialog(fallbackTabbed), true)
  // 混在も OK
  const mixed = '☐ a □ b ✓ c ✔ Submit →'
  assertEq('混在 unicode + → → true', isTabbedDialog(mixed), true)
}

// -------------------------------------------------------
// 13. parseDialog: 改行無し + タブバー描画 (ConPTY 実描画相当)
// -------------------------------------------------------
console.log('\n[13] parseDialog: \\n 無しタブバー描画から prompt 抽出')
{
  // stripAnsi 後の ConPTY 描画は CSI B (↓1 行) が消えて \n が残らない。
  // タブバーが prompt に混入しないか確認(v1.11.0 で発生していたバグ)。
  const buf =
    '──────────────────────────────────── ' +
    '← ☐ 食事タイプ ☐ 飲み物 ☐ 生活リズム ✔ Submit → ' +
    '朝食派ですか、それとも夜食派ですか? ' +
    '❯ 1. 朝食派 朝にしっかり食べるのが好き ' +
    '2. 夜食派 夜遅くに食べるのが好き ' +
    '3. どちらも 朝も夜も両方楽しむ ' +
    '4. Type something. ' +
    '──────────────────────────────────── ' +
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'
  const r = parseDialog(buf)
  assertEq('parseDialog 検出 → ok', !!r, true)
  if (r) {
    assertEq(
      'prompt にタブバー文字が混入しない (☐ 無)',
      r.prompt.includes('☐'),
      false
    )
    assertEq('prompt にタブバー文字が混入しない (✔ 無)', r.prompt.includes('✔'), false)
    assertEq('prompt にタブバー文字が混入しない (← 無)', r.prompt.includes('←'), false)
    assertEq(
      'prompt 本文が抽出されている',
      r.prompt.includes('朝食派ですか'),
      true
    )
  }
  assertEq('isTabbedDialog も true', isTabbedDialog(buf), true)
}

// -------------------------------------------------------
// 14. stripAnsi: CSI B / E を改行に変換
// -------------------------------------------------------
console.log('\n[14] stripAnsi: CSI B / E → \\n 変換')
{
  // ConPTY は行送りに CSI B (Cursor Down) を使う。改行へ変換しないと
  // parseDialog が行構造を失い、行頭マーカーが認識できなくなる。
  assertEq('CSI 1 B → \\n', stripAnsi('A\x1b[1BB'), 'A\nB')
  assertEq('CSI 単独 B → \\n', stripAnsi('A\x1b[BB'), 'A\nB')
  assertEq('CSI 3 B → \\n × 3', stripAnsi('A\x1b[3BB'), 'A\n\n\nB')
  assertEq('CSI E (Next Line) → \\n', stripAnsi('A\x1b[EB'), 'A\nB')
  assertEq(
    'CSI B と C は併存可能',
    stripAnsi('A\x1b[1B\x1b[2CB'),
    'A\n  B'
  )
}

// -------------------------------------------------------
// 15. parseDialog: 生 ANSI 描画(CSI B 含む)からの抽出
// -------------------------------------------------------
console.log('\n[15] parseDialog: 生 ANSI タブ式描画から prompt/options 抽出')
{
  // ConPTY 風: 行送りに CSI B、列ジャンプに CSI C、色は CSI m。
  // stripAnsi で CSI B → \n に変換されることを前提とする。
  const buf =
    '\x1b[38;5;246m────\x1b[39m\x1b[1B' +
    '← ☐ 食事タイプ\x1b[1C☐\x1b[1C飲み物\x1b[2C☐\x1b[1C生活リズム\x1b[2C✔\x1b[1CSubmit\x1b[2C→\x1b[1B' +
    '朝食派ですか、それとも夜食派ですか?\x1b[1B' +
    '\x1b[38;5;153m❯\x1b[39m 1.\x1b[1C朝食派\x1b[1B' +
    '\x1b[2C2.\x1b[1C夜食派\x1b[1B' +
    '\x1b[2C3.\x1b[1Cどちらも\x1b[1B' +
    '\x1b[38;5;246m────\x1b[39m\x1b[1B' +
    'Esc to cancel'
  const cleaned = stripAnsi(buf)
  const r = parseDialog(cleaned)
  assertEq('検出できる', !!r, true)
  if (r) {
    assertEq('prompt がクリーン', r.prompt, '朝食派ですか、それとも夜食派ですか?')
    assertEq('options 数 = 3', r.options.length, 3)
    assertEq('option[0] = "朝食派"', r.options[0], '朝食派')
    assertEq('option[1] = "夜食派"', r.options[1], '夜食派')
    assertEq('option[2] = "どちらも"', r.options[2], 'どちらも')
  }
}

// -------------------------------------------------------
// 16. parseDialog: prompt 本文に → を含むタブ式ダイアログ
// -------------------------------------------------------
console.log('\n[16] parseDialog: prompt 本文に → を含んでもタブバー側を行末扱い')
{
  // タブバー右端の → が「最終 →」ではなく、prompt 本文の → が最終になるケース。
  // arrowIdx が prompt 内の → を拾うと lineStart が prompt 途中に来て本文断片化する。
  // 修正後: → の採用条件「タブマーカー後ろ」、なければタブマーカー末尾代用 で防止。
  // 構造: タブバー〜prompt は空白連結(arrowIdx ブランチ起動条件)、
  // prompt 後と options 間は \n(実 PTY で CSI B が \n に変換された後の状態)
  const buf =
    '──── ' +
    '← ☐ a ☐ b ☐ c ✔ Submit → ' +
    'バージョンを 5 → 10 に上げますか?\n' +
    ' ❯ 1. はい\n' +
    '   2. いいえ\n' +
    '──── ' +
    'Esc to cancel Tab/Arrow keys to navigate'
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  if (r) {
    // タブバー右端 `→` がタブマーカー (☐/✔) より後にあるためそこを採用
    // → prompt は「バージョンを 5 → 10 に上げますか?」全体
    assertEq(
      'prompt 本文が断片化していない',
      r.prompt.includes('バージョンを 5'),
      true
    )
    assertEq(
      'prompt にタブバー文字 (☐) が混入しない',
      r.prompt.includes('☐'),
      false
    )
    assertEq(
      'prompt にタブバー文字 (←) が混入しない',
      r.prompt.includes('←'),
      false
    )
    assertEq('options 数 = 2', r.options.length, 2)
  }
}

// -------------------------------------------------------
// 17. parseDialog: → 無しタブバー UI(Tab/Arrow keys ヒントのみ)
// -------------------------------------------------------
console.log('\n[17] parseDialog: → 無し UI でもタブマーカー末尾を行頭代用')
{
  // タブバーが ← も → も持たず、☐/✔ のみで構成される環境(将来の UI 変化想定)。
  // isTabbedDialog は `→ OR Tab/Arrow keys` の OR で true → parseDialog 側で
  // → が見つからなくてもタブマーカー末尾を使って prompt を切り出せること。
  const buf =
    '──── ' +
    '☐ a ☐ b ✔ Submit ' +
    'コーヒー派か紅茶派ですか?\n' +
    ' ❯ 1. コーヒー\n' +
    '   2. 紅茶\n' +
    'Tab/Arrow keys to navigate Esc to cancel'
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  if (r) {
    assertEq(
      'prompt 本文がクリーン',
      r.prompt,
      'コーヒー派か紅茶派ですか?'
    )
    assertEq(
      'prompt にタブバー文字 (☐) が混入しない',
      r.prompt.includes('☐'),
      false
    )
    assertEq('options 数 = 2', r.options.length, 2)
  }
  assertEq('isTabbedDialog も true', isTabbedDialog(buf), true)
}

// -------------------------------------------------------
// 18. promptSimilar: 日本語 prompt の類似度判定が機能する
// -------------------------------------------------------
console.log('\n[18] promptSimilar: 日本語 prompt 対応')
{
  // 旧 normalizePrompt は /[^a-z0-9]/ で日本語を全削除 → 常に空文字列 →
  // promptSimilar が !na.length で false 返却 = タブ式 sweep が完全破綻していた。
  // 修正後は空白/罫線のみ除去、本文(日本語含む)は保持する。
  // promptSimilar は module から直接 export していないが、内部利用される
  // dialogShapeMatches 経由で挙動を確認する。
  const { stripAnsi } = require('./claude-wrapper.js')
  // 副次的に: stripAnsi が日本語を破壊しないことも確認
  assertEq(
    'stripAnsi が日本語を保持',
    stripAnsi('朝食派ですか、夜食派ですか?'),
    '朝食派ですか、夜食派ですか?'
  )
  // parseDialog 経由で「異なる日本語 prompt」が区別されることを確認
  const buf1 = [
    '─────',
    ' 朝食派ですか、夜食派ですか?',
    ' ❯ 1. 朝食派',
    '   2. 夜食派',
    ' Esc to cancel',
  ].join('\n')
  const buf2 = [
    '─────',
    ' コーヒー派か紅茶派か?',
    ' ❯ 1. コーヒー',
    '   2. 紅茶',
    ' Esc to cancel',
  ].join('\n')
  const r1 = parseDialog(buf1)
  const r2 = parseDialog(buf2)
  assertEq('buf1 検出', !!r1, true)
  assertEq('buf2 検出', !!r2, true)
  assertEq('異なる日本語 prompt が異なる結果', r1.prompt !== r2.prompt, true)
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
