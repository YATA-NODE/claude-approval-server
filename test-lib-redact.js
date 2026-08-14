/**
 * test-lib-redact.js — tools/lib-redact.js の statusline / タイトルバー マスクの回帰テスト。
 *
 * 背景(第1段): `tools/dump-attrs.js` が生成するダンプに、Claude Code の statusline
 * (モデル名 + rate limit 使用率 + リセット時刻)が混入し、redact() を素通りしていた。
 * statusline は承認枠の外の chrome だが、選択肢行の直下に空行なく描画される個体では
 * 選択肢行と同一行に連結され(混合行)、走査に拾われてそのまま出力されていた。
 *
 * 検証方法(第1段、[C0]-[C5]): 実際に観測された4つの実例(純 statusline 行3種 + 混合行1種)を
 * redact() に通し、①statusline のマーカー/使用率/時刻/モデル名が出力に残らないこと、
 * ②混合行では選択肢部分("❯ 1. Yes")が残ることを assert する。
 *
 * 背景(第2段、[C6]-[C7]): 第1段の後も実測で2種の残存が見つかった。
 * (b) タイトルバー(リポ名 / ブランチ名 / effort / スラッシュコマンド)が選択肢行と同一 y に
 * 連結描画される個体で、text 行・run いずれもマスクされない(◉ / /effort に redact() の
 * statusline マーカーが無いため)。(c) statusline 混合行の text 行自体は正しくマスクされて
 * いるが、その行のセル run が個別行として出力される dump-attrs.js の run ダンプでは、
 * 断片("9%" "5h:" 等)単体に statusline マーカーが無いため run 単位の出力を素通りしていた。
 *
 * 検証方法(第2段): maskTitlebarRunsInText()(run 境界で (b) を精密に伏せる)と
 * filterPrintableRuns()(chrome マーカーを含む run、または redact 済みテキストにもう
 * 残っていない run を出力対象から除く。(b)(c) 両方を担う)を、実際に観測された run 構成を
 * 模した入力で検証する。
 *
 * 使い方: node test-lib-redact.js
 */
'use strict'

const { redact, isStatuslineText, maskTitlebarRunsInText, filterPrintableRuns } = require('./tools/lib-redact.js')

let passed = 0
let failed = 0

function assertEq(label, actual, expected) {
  const ok = actual === expected
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

function assertTrue(label, actual) {
  assertEq(label, actual, true)
}

// -------------------------------------------------------
// 実際に観測された4つの実例
// -------------------------------------------------------
const PURE_MODEL_LINE = '  Sonnet 5 📒:  N/A 5h: 52% ↻ 18:40 Week: 84% ↻ 8/13 12:00'
const PURE_GPT_LINE = '  gpt-5.6-sol 📒:  25% 5h: 23% ↻ 11:06 Week: N/A'
const PURE_MANUAL_MODE_LINE = '  ⏸ manual mode on'
const MIXED_OPTION_LINE = '- y=17  cursor=true  text=" ❯ 1. Yes5 📒: 9% 5h: 5% ↻ 22:40 Week: 23%"'

// statusline の残存を判定する grep 相当(dump-attrs.js 再生成後の検証と同じ条件)。
function hasStatuslineResidue(s) {
  return /📒|manual mode on|↻\s*\d/.test(s)
}

console.log('[C0] isStatuslineText: 検出述語自体が4実例を正しく判定できること')
{
  assertTrue('純 statusline 行(モデル名+使用率)を検出する', isStatuslineText(PURE_MODEL_LINE))
  assertTrue('純 statusline 行(gpt モデル名)を検出する', isStatuslineText(PURE_GPT_LINE))
  assertTrue('純 statusline 行(manual mode on)を検出する', isStatuslineText(PURE_MANUAL_MODE_LINE))
  assertTrue('混合行(選択肢+statusline)を検出する', isStatuslineText(MIXED_OPTION_LINE))
  assertEq('通常の選択肢行(statusline なし)は検出しない', isStatuslineText(' ❯ 1. Yes'), false)
}

console.log('')
console.log('[C1] 純 statusline 行: マーカー/使用率/時刻/モデル名が出力に残らないこと')
{
  for (const [label, line] of [
    ['Sonnet 5 行', PURE_MODEL_LINE],
    ['gpt-5.6-sol 行', PURE_GPT_LINE],
    ['manual mode on 行', PURE_MANUAL_MODE_LINE],
  ]) {
    const out = redact(line)
    assertEq(`${label}: statusline マーカーが残らない`, hasStatuslineResidue(out), false)
  }
  // モデル名も含めて消える(「マーカーだけ伏せてモデル名は残る」バイパスの再発防止)。
  assertEq('Sonnet 5 行: モデル名 "Sonnet" が残らない', redact(PURE_MODEL_LINE).includes('Sonnet'), false)
  assertEq('gpt-5.6-sol 行: モデル名 "gpt-5.6-sol" が残らない', redact(PURE_GPT_LINE).includes('gpt-5.6-sol'), false)
  // 幅保存(近似): 先頭インデントは残り、可視部分は同じ文字数の 'x' に置き換わる。
  assertEq('Sonnet 5 行: 全体の文字数が変わらない(幅保存の近似)', redact(PURE_MODEL_LINE).length, PURE_MODEL_LINE.length)
  assertEq(
    'manual mode on 行: 先頭インデント(2スペース)は残る',
    redact(PURE_MANUAL_MODE_LINE).startsWith('  '),
    true
  )
}

console.log('')
console.log('[C2] 混合行: statusline は伏せつつ、選択肢部分は残ること')
{
  const out = redact(MIXED_OPTION_LINE)
  assertEq('混合行: statusline マーカーが残らない', hasStatuslineResidue(out), false)
  assertEq('混合行: 使用率 "9%" が残らない', out.includes('9%'), false)
  assertEq('混合行: 時刻 "22:40" が残らない', out.includes('22:40'), false)
  assertTrue('混合行: 選択肢部分 "❯ 1. Yes" は残る', out.includes('❯ 1. Yes'))
  assertTrue('混合行: y 座標のメタ情報 "y=17" は残る(statusline とは無関係)', out.includes('y=17'))
}

console.log('')
console.log('[C2b] 混合行(› カーソル): ❯ 以外のカーソル文字でも選択肢部分が残ること')
{
  // claude-wrapper.js の CURSOR_CHARS は '❯' + '›' の2文字。❯ だけを見ていた旧実装では
  // › カーソルの個体を「選択肢らしさ」判定に一致させられず、選択肢部分ごと誤って
  // 伏せてしまっていた(実行で確認して修正)。
  const mixedAngleQuote = '- y=17  cursor=true  text=" › 1. Yes5 📒: 9% 5h: 5% ↻ 22:40 Week: 23%"'
  const out = redact(mixedAngleQuote)
  assertEq('› カーソル混合行: statusline マーカーが残らない', hasStatuslineResidue(out), false)
  assertTrue('› カーソル混合行: 選択肢部分 "› 1. Yes" は残る', out.includes('› 1. Yes'))
}

console.log('')
console.log('[C3] 複数行(改行区切り)の入力でも行ごとに正しく処理されること')
{
  const multi = [PURE_MODEL_LINE, ' ❯ 1. Yes', MIXED_OPTION_LINE].join('\n')
  const out = redact(multi)
  const outLines = out.split('\n')
  assertEq('複数行入力: 行数が変わらない', outLines.length, 3)
  assertEq('複数行入力: 1行目(純 statusline)は伏せられる', hasStatuslineResidue(outLines[0]), false)
  assertEq('複数行入力: 2行目(通常の選択肢行)はそのまま残る', outLines[1], ' ❯ 1. Yes')
  assertTrue('複数行入力: 3行目(混合行)は選択肢部分が残る', outLines[2].includes('❯ 1. Yes'))
  assertEq('複数行入力: 3行目(混合行)は statusline マーカーが残らない', hasStatuslineResidue(outLines[2]), false)
}

console.log('')
console.log('[C4] 既存の home パス / ユーザー名 redaction を壊していないこと(回帰確認)')
{
  const os = require('os')
  const path = require('path')
  const homeUser = path.basename(os.homedir())
  if (homeUser && homeUser.length >= 1) {
    const withHome = `使い方: node tools/dump-attrs.js /home/${homeUser}/foo.log`
    const out = redact(withHome)
    assertEq('home パスのユーザー名部分が伏せられる', out.includes(`/home/${homeUser}/`), false)
    assertTrue('home パスのプレフィックス自体は残る', out.includes('/home/'))
  } else {
    console.log('  (skip: os.homedir() のユーザー名が取得できない環境)')
  }
}

console.log('')
console.log('[C5] 改行で分断されたユーザー名(実行で確認した回帰の固定化)')
{
  // USER_LOOSE_RE の分断耐性パターン(SPLITTER)は \s に実改行も含む。home パス /
  // ユーザー名 redaction を行分割の後(行ごと)に掛けると、ユーザー名が実改行そのもので
  // 分断されている個体を取りこぼす(実行で確認)。redact() は
  // 行分割の**前**に全体へ一度だけ掛けることでこれを保つ。
  const os = require('os')
  const path = require('path')
  const homeUser = path.basename(os.homedir())
  if (homeUser && homeUser.length >= 3) {
    const mid = Math.floor(homeUser.length / 2)
    const splitAcrossNewline = `${homeUser.slice(0, mid)}\n${homeUser.slice(mid)}`
    const out = redact(splitAcrossNewline)
    assertEq('実改行で分断されたユーザー名も伏せられる', out.includes(homeUser), false)
  } else {
    console.log('  (skip: ユーザー名が3文字未満で分断耐性パターンの対象外)')
  }
}

console.log('')
console.log('[C6] タイトルバー混合行(第2段 (b), t4-tabbed y=16 実例): text/run 双方から repo/branch を落とす')
{
  // 実際に観測された t4-tabbed の y=16(選択肢 "2. 赤" にタイトルバーが同一 y に連結描画)。
  // run は dumpRowAttrs 相当(空白セルを除外して連結した「圧縮テキスト」)。
  const TITLEBAR_MIXED_TEXT =
    '  2. 赤e-approval-server / feature/attr-channel                                                      ◉ xhigh · /effort'
  const TITLEBAR_MIXED_RUNS = [
    { text: '2.' },
    { text: '赤' },
    { text: 'e-approval-server/feature/attr-channel◉xhigh·/effort' },
  ]

  const maskedText = maskTitlebarRunsInText(TITLEBAR_MIXED_TEXT, TITLEBAR_MIXED_RUNS)
  assertEq('タイトルバー混合行: text からリポ名が消える', maskedText.includes('e-approval-server'), false)
  assertEq('タイトルバー混合行: text からブランチ名が消える', maskedText.includes('feature/attr-channel'), false)
  assertEq('タイトルバー混合行: text から ◉ が消える', maskedText.includes('◉'), false)
  assertEq('タイトルバー混合行: text から /effort が消える', maskedText.includes('/effort'), false)
  assertTrue('タイトルバー混合行: text に選択肢の番号 "2." は残る', maskedText.includes('2.'))
  assertTrue('タイトルバー混合行: text に選択肢の実体 "赤" は残る', maskedText.includes('赤'))
  assertEq('タイトルバー混合行: 全体の文字数が変わらない(幅保存の近似)', maskedText.length, TITLEBAR_MIXED_TEXT.length)

  const redactedText = redact(maskedText)
  const printableTexts = filterPrintableRuns(redactedText, TITLEBAR_MIXED_RUNS).map((r) => r.text)
  assertEq(
    'タイトルバー混合行: chrome run(リポ名+ブランチ名+effort の巨大 run)は出力対象から落ちる',
    printableTexts.includes('e-approval-server/feature/attr-channel◉xhigh·/effort'),
    false
  )
  assertTrue('タイトルバー混合行: 選択肢実体 run "2." は出力対象に残る', printableTexts.includes('2.'))
  assertTrue('タイトルバー混合行: 選択肢実体 run "赤" は出力対象に残る', printableTexts.includes('赤'))
}

console.log('')
console.log('[C7] statusline 混合行のセル run 断片(第2段 (c), webfetch y=17 実例): run フィルタで断片を落とす')
{
  // 実際に観測された webfetch の y=17(選択肢 "❯ 1. Yes" に statusline が同一 y に連結描画)。
  // "9%" "5h:" 等の run 単体には statusline マーカーが無いため、行単位の redact() だけでは
  // run ダンプの出力を素通りする(text 行自体は redact() で正しくマスクされる)。
  const STATUSLINE_MIXED_TEXT = ' ❯ 1. Yes5 📒: 9% 5h: 5% ↻ 22:40 Week: 23%'
  const STATUSLINE_MIXED_RUNS = [
    { text: '❯' },
    { text: '1.' },
    { text: 'Yes' },
    { text: '5' },
    { text: '📒:' },
    { text: '9%' },
    { text: '5h:' },
    { text: '5%' },
    { text: '↻22:40' },
    { text: 'Week:' },
    { text: '23%' },
  ]

  const redactedText = redact(STATUSLINE_MIXED_TEXT)
  assertEq('statusline 混合行: text 行自体は redact() で正しくマスクされる(回帰確認)', redactedText.includes('9%'), false)
  const printableTexts = filterPrintableRuns(redactedText, STATUSLINE_MIXED_RUNS).map((r) => r.text)

  for (const leaked of ['📒:', '9%', '5h:', '5%', '↻22:40', 'Week:', '23%']) {
    assertEq(`statusline 混合行: run 断片 "${leaked}" は出力対象から落ちる`, printableTexts.includes(leaked), false)
  }
  for (const kept of ['❯', '1.', 'Yes', '5']) {
    assertTrue(`statusline 混合行: 選択肢実体 run "${kept}" は出力対象に残る`, printableTexts.includes(kept))
  }
}

// -------------------------------------------------------
// 第3段: 公開 fixture(test/fixtures/attr/*.json)の raw_pty decode で見つかった残存
// (実データで確認)。redactRawStream() の回帰テスト。
// branch 名は「現在チェックアウトされているブランチ」を動的に取得する(featureブランチが
// 将来消えても壊れないようにするため。repo 名はディレクトリ名から取得し常に安定)。
// -------------------------------------------------------
const { redactRawStream, findRawIdentifierLeaks, setRepoIdentifiers } = require('./tools/lib-redact.js')
const { execFileSync } = require('child_process')
const path = require('path')

const REPO_NAME = path.basename(__dirname)
let CURRENT_BRANCH = ''
try {
  CURRENT_BRANCH = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: __dirname,
    encoding: 'utf8',
  }).trim()
} catch (_) {
  CURRENT_BRANCH = ''
}
// [C8]-[C10] は「登録済みの repo/branch 識別子がマスクされること」の検証。実行環境の
// branch 状態(CI の detached checkout ではローカル branch が無く、初期の識別子一覧に
// branch が入らない)に依存しないよう、識別子を明示注入して決定論化する。
// 復元は restoreDefaultRepoIdentifiers()(C14 節で定義、hoisting で前方から呼べる)。
const TEST_BRANCH = 'feature/redact-test-branch'
function injectRepoIdentifiers() {
  setRepoIdentifiers([REPO_NAME, TEST_BRANCH])
}

console.log('')
console.log('[C8] redactRawStream: タイトルバー行(マーカーあり)でマーカーの前(リポ名/ブランチ名)も')
console.log('     マスクされること。行区切りを \\r にも広げたことで、同じ塊内の無関係な')
console.log('     前後の行(Fetch(...) / Sonnet 5)は過剰マスクされないことも確認する。')
{
  const branch = TEST_BRANCH
  injectRepoIdentifiers()
  // 実際の e2e-raw-webfetch.log で観測された構造(1つの \n 区切りブロックに複数の画面行が
  // \r + 相対カーソル移動で連結される)を模した合成入力。
  const sample =
    '\x1b[2C\x1b[1B\x1b[38;2;153;153;153mFetch(https://example.com/)\x1b[K\r' +
    `\x1b[2C\x1b[1B${REPO_NAME}\x1b[26G/ ${branch}\x1b[39m              ` +
    '\x1b[102G\x1b[38;2;153;153;153m◉ xhigh · /effort\r' +
    '\x1b[2C\x1b[1BSonnet 5\x1b[12G\x1b[22m 9.2%\x1b[39m\n'

  const out = redactRawStream(sample)
  assertEq('タイトルバー行: 全体の文字数が変わらない(幅保存)', out.length, sample.length)
  assertEq('タイトルバー行: リポ名がマーカーの前でも残らない', out.includes(REPO_NAME), false)
  assertEq('タイトルバー行: ブランチ名がマーカーの前でも残らない', out.includes(branch), false)
  assertEq('タイトルバー行: effort マーカー "◉" が残らない', out.includes('◉'), false)
  assertEq('タイトルバー行: "/effort" が残らない', out.includes('/effort'), false)
  assertTrue('無関係な前の行 "Fetch(https://example.com/)" は過剰マスクされずに残る', out.includes('Fetch(https://example.com/)'))
  assertTrue('無関係な後の行 "Sonnet 5" は過剰マスクされずに残る(chrome マーカーが無いため)', out.includes('Sonnet 5'))
  assertTrue('無関係な後の行 "9.2%" は過剰マスクされずに残る', out.includes('9.2%'))
}

console.log('')
console.log('[C9] redactRawStream: effort マーカーが描画されない「マーカー無しタイトルバー行」')
console.log('     でもリポ名/ブランチ名が残らないこと(部分再描画で単独行として流れる実例)。')
{
  const branch = TEST_BRANCH
  injectRepoIdentifiers()
  const sample = `\x1b[2C\x1b[1A\x1b[38;2;153;153;153m${REPO_NAME} / ${branch}\x1b[39m\r\r\r`
  const out = redactRawStream(sample)
  assertEq('マーカー無しタイトルバー行: 文字数が変わらない', out.length, sample.length)
  assertEq('マーカー無しタイトルバー行: リポ名が残らない', out.includes(REPO_NAME), false)
  assertEq('マーカー無しタイトルバー行: ブランチ名が残らない', out.includes(branch), false)
}

console.log('')
console.log('[C10] redactRawStream: ブランチ名の直後にカーソル位置ジャンプ(空白文字を伴わない)で')
console.log('      無関係なヒント文が連結される個体でも、境界を誤らずブランチ名だけをマスクする。')
{
  const branch = TEST_BRANCH
  injectRepoIdentifiers()
  // 実際の e2e-raw-adv-fakeframe.log で観測された構造: ブランチ名の直後、列ジャンプを挟んで
  // "ctrl+g to edit in VS Code" ヒントが連結される(視覚上の空白はカーソル移動で作られており
  // 文字としては存在しない)。
  const sample =
    `\x1b[3G\x1b[38;2;153;153;153m${REPO_NAME}\x1b[26G/\x1b[28G${branch}` +
    '\x1b[94Gctrl+g\x1b[101Gto\x1b[104Gedit\x1b[109Gin\x1b[112GVS\x1b[115GCode\x1b[39m\r\r'
  const out = redactRawStream(sample)
  assertEq('境界precision: 文字数が変わらない', out.length, sample.length)
  assertEq('境界precision: ブランチ名が残らない(直後に隙間なく別の語が続いても)', out.includes(branch), false)
  assertEq('境界precision: リポ名が残らない', out.includes(REPO_NAME), false)
  assertTrue('境界precision: 無関係な隣接語 "ctrl+g" は誤ってマスクされず残る', out.includes('ctrl+g'))
  assertTrue('境界precision: 無関係な隣接語 "edit" は誤ってマスクされず残る', out.includes('edit'))
  assertTrue('境界precision: 無関係な隣接語 "VS" は誤ってマスクされず残る', out.includes('VS'))
  restoreDefaultRepoIdentifiers()
}

console.log('')
console.log('[C11] redactRawStream: SGR(色指定)で分断されたユーザー名も検出してマスクする')
console.log('      (制御トークンで分断されたユーザー名は per-token 走査では取りこぼす)。')
{
  const os = require('os')
  const homeUser = path.basename(os.homedir())
  if (homeUser && homeUser.length >= 2) {
    const mid = Math.floor(homeUser.length / 2)
    // "k" + SGR(色変更) + "oishi" のように、実際には1語のユーザー名が制御トークンで
    // 分断されている個体を模す。
    const sample = `\x1b[38;2;1;2;3m${homeUser.slice(0, mid)}\x1b[38;2;4;5;6m${homeUser.slice(mid)}\x1b[39m\r\n`
    const out = redactRawStream(sample)
    const leak = findRawIdentifierLeaks(out)
    assertEq('SGR分断ユーザー名: 文字数が変わらない', out.length, sample.length)
    assertEq('SGR分断ユーザー名: findRawIdentifierLeaks が残存を検出しない', leak.leaked, false)
  } else {
    console.log('  (skip: ユーザー名が2文字未満)')
  }
}

console.log('')
console.log('[C12] redactRawStream: Windows home パス(C:\\Users\\<user> / UNC \\\\host\\Users\\<user>)')
console.log('      でもユーザー名部分だけがマスクされ、プレフィックスは残ること。')
{
  const sample1 = 'C:\\Users\\bobsmith\\Documents\\file.txt にログがあります\r\n'
  const out1 = redactRawStream(sample1)
  assertEq('Windowsパス(ドライブ文字): 文字数が変わらない', out1.length, sample1.length)
  assertEq('Windowsパス(ドライブ文字): ユーザー名 "bobsmith" が残らない', out1.includes('bobsmith'), false)
  assertTrue('Windowsパス(ドライブ文字): プレフィックス "C:\\\\Users\\\\" は残る', out1.includes('C:\\Users\\'))
  assertTrue('Windowsパス(ドライブ文字): 末尾のパスは残る', out1.includes('Documents\\file.txt'))

  const sample2 = 'c:\\users\\alicejones\\Desktop\\note.txt(小文字ドライブ)\r\n'
  const out2 = redactRawStream(sample2)
  assertEq('Windowsパス(小文字ドライブ): ユーザー名 "alicejones" が残らない', out2.includes('alicejones'), false)

  const sample3 = '\\\\fileserver\\Users\\carollee\\share にあります\r\n'
  const out3 = redactRawStream(sample3)
  assertEq('UNCパス: ユーザー名 "carollee" が残らない', out3.includes('carollee'), false)
  assertTrue('UNCパス: host/share プレフィックスは残る', out3.includes('\\\\fileserver\\Users\\'))
}

console.log('')
console.log('[C13] redact(): NFKC は照合専用 — 正規化で文字数が変わる文字(全角省略記号等)が')
console.log('      あっても、マスク対象でない部分は原文のまま・全体の長さも保たれること。')
{
  const ellipsisInput = '見て… これは重要 …終わり'
  const ellipsisOut = redact(ellipsisInput)
  assertEq('NFKC照合専用: 省略記号を含む文字列でも長さが変わらない', ellipsisOut.length, ellipsisInput.length)
  assertEq('NFKC照合専用: マスク対象が無ければ内容も変わらない(省略記号 "…" のまま)', ellipsisOut, ellipsisInput)

  const os = require('os')
  const homeUser = path.basename(os.homedir())
  if (homeUser && /^[A-Za-z0-9]+$/.test(homeUser) && homeUser.length >= 3) {
    // ASCII 英数字のユーザー名を全角(Fullwidth Forms, +0xFEE0)に変換して埋め込む。
    const fullwidthUser = [...homeUser].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('')
    const input = `見て…${fullwidthUser}…終わり`
    const out = redact(input)
    assertEq('NFKC照合専用: 全角ホモグリフでも長さが変わらない', out.length, input.length)
    assertTrue('NFKC照合専用: 前後の省略記号は原文のまま残る', out.startsWith('見て…') && out.endsWith('…終わり'))
    assertEq('NFKC照合専用: 全角ユーザー名部分はマスクされて消える', out.includes(fullwidthUser), false)
  } else {
    console.log('  (skip: ユーザー名が ASCII 英数字3文字以上でない環境)')
  }
}

// -------------------------------------------------------
// 第4段: 識別子集合の差し替え・マーカー基準マスク・行境界・過剰置換診断・表示幅保存・正規化・statusline 検出の回帰テスト
// (tools/extract-fixture.js 側の fail-close 出力に関する内容は
// このファイルの対象外)。
// -------------------------------------------------------
// setRepoIdentifiers は先頭の require で取得済み。

function restoreDefaultRepoIdentifiers() {
  let branches = []
  try {
    branches = execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: __dirname, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch (_) {
    branches = []
  }
  setRepoIdentifiers([REPO_NAME, ...branches])
}

console.log('')
console.log('[C14] setRepoIdentifiers(): git を再度呼ばず、明示的に渡した識別子集合に')
console.log('      差し替えられること(過去の録画を後から再生する用途で git の現在地に依存しない)。')
{
  // 実在しない架空の識別子に差し替える(git 状態に一切依存しないことの証明)。
  setRepoIdentifiers(['acme-fixture-repo-xyz', 'feature/manifest-locked-branch'])
  const sample = 'このセッションは acme-fixture-repo-xyz / feature/manifest-locked-branch で作業中\r\n'
  const out = redactRawStream(sample)
  assertEq('setRepoIdentifiers: 差し替えたリポ識別子がマスクされる', out.includes('acme-fixture-repo-xyz'), false)
  assertEq(
    'setRepoIdentifiers: 差し替えたブランチ識別子がマスクされる',
    out.includes('feature/manifest-locked-branch'),
    false
  )

  // 差し替え後は「実際のリポ名」は識別子集合に含まれない(完全に置き換えたため)。
  const out2 = redactRawStream(`${REPO_NAME} という語はここでは identifiers に無い\r\n`)
  assertTrue('setRepoIdentifiers: 差し替え後は旧識別子(実リポ名)がもう対象外', out2.includes(REPO_NAME))

  // 空配列に差し替えると何もマスクされない(fail-close の判断自体は呼び出し側の責務)。
  setRepoIdentifiers([])
  const out3 = redactRawStream('acme-fixture-repo-xyz はもうマスクされない\r\n')
  assertTrue('setRepoIdentifiers([]): 識別子ゼロなら何もマスクされない', out3.includes('acme-fixture-repo-xyz'))

  restoreDefaultRepoIdentifiers()
}

console.log('')
console.log('[C15] redactRawStream: マーカー(📒 等)の直前に直接連結された chrome')
console.log('      灰色の統計値(モデル名等)が、列ジャンプや bold トグルで token が分かれていても')
console.log('      マーカーの token まで遡ってマスクされること(実データ同様の token 分割を再現)。')
{
  const sample =
    '\x1b[38;2;177;185;249m❯ 1. Yes' + // token1: 選択肢(別の色 = chrome 灰色ではない)
    '\x1b[38;2;153;153;153m\x1b[1mClaude' + // token2: 灰色+bold、モデル名前半
    '\x1b[22m Opus 88% ' + // token3: 灰色のまま(bold off。実データの列ジャンプ/トグルと同型)
    '\x1b[1m' + // token境界を作るダミー(fg は不変のまま)
    '📒: reset' + // token4: 灰色のまま、マーカー本体(先頭が 📒)
    '\x1b[39m\r\n'
  const out = redactRawStream(sample)
  assertEq('文字数が変わらない(幅保存)', out.length, sample.length)
  assertTrue('選択肢部分 "❯ 1. Yes" は残る', out.includes('❯ 1. Yes'))
  assertEq('マーカー手前に連結されたモデル名 "Claude" が残らない', out.includes('Claude'), false)
  assertEq('マーカー手前に連結された "Opus" が残らない', out.includes('Opus'), false)
  assertEq('マーカー手前に連結された使用率 "88%" が残らない', out.includes('88%'), false)
  assertEq('マーカー "📒" 自体も残らない', out.includes('📒'), false)
}

console.log('')
console.log('[C16] redactRawStream: 復帰(\\r)を伴わない CSI 垂直移動(カーソル上下/')
console.log('      位置指定)でも画面行が切り替わったとみなし、タイトルバーのリポ名/ブランチ名を')
console.log('      正しくマスクすること(\\r/\\n が無いと選択肢行と誤って同一論理行になる回帰)。')
{
  const branch = TEST_BRANCH
  injectRepoIdentifiers()
  const sample =
    '\x1b[38;2;177;185;249m ❯ 1. Yes' + // 選択肢行(別の色)
    '\x1b[1B' + // CSI 垂直移動(カーソル下へ1、復帰 \r を伴わない)
    `\x1b[38;2;153;153;153m${REPO_NAME}/${branch}` + // 次の画面行: タイトルバー
    '\x1b[102G◉ xhigh · /effort\x1b[39m\r\n'
  const out = redactRawStream(sample)
  assertEq('文字数が変わらない', out.length, sample.length)
  assertTrue('選択肢部分は残る', out.includes('❯ 1. Yes'))
  assertEq('リポ名がマスクされる(CSI 垂直移動を行境界に含めないと残っていた)', out.includes(REPO_NAME), false)
  assertEq('ブランチ名がマスクされる', out.includes(branch), false)
  assertEq('effort マーカーがマスクされる', out.includes('◉'), false)
}

console.log('')
console.log('[C17] redactRawStream: repo/branch 識別子が chrome(タイトルバー)色の')
console.log('      外で一致した場合は diagnostics.overReplacements に記録されること')
console.log('      (一般的な語がブランチ名と一致して承認コマンド等を破壊する過剰置換の検出)。')
{
  setRepoIdentifiers(['main']) // 一般語を識別子にして過剰置換を再現する
  const sampleCommand = 'git checkout main  # 通常のコマンド出力(chrome ではない)\r\n'
  const diag1 = { overReplacements: [] }
  const out1 = redactRawStream(sampleCommand, diag1)
  assertTrue('chrome 色の外での一致が overReplacements に記録される', diag1.overReplacements.length > 0)
  assertEq('記録はするが、マスク自体は行う(漏洩防止を優先する側に倒す)', out1.includes('main'), false)

  const sampleTitlebar = '\x1b[38;2;153;153;153msome-repo/main\x1b[102G◉ xhigh · /effort\x1b[39m\r\n'
  const diag2 = { overReplacements: [] }
  redactRawStream(sampleTitlebar, diag2)
  assertEq('chrome 色内での一致は overReplacements に記録されない(正当なタイトルバー)', diag2.overReplacements.length, 0)

  restoreDefaultRepoIdentifiers()
}

console.log('')
console.log('[C18] maskVisible: 全角文字を含む伏せ字が表示幅(East Asian Width)を')
console.log('      保つこと(半角 "x" だけに置換すると UTF-16 長は保たれても表示幅が縮む)。')
{
  const os = require('os')
  const homeUser = path.basename(os.homedir())
  if (homeUser && /^[A-Za-z0-9]+$/.test(homeUser) && homeUser.length >= 3) {
    const fullwidthUser = [...homeUser].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('')
    const sample = `/home/${fullwidthUser}/file.txt\r\n`
    const out = redactRawStream(sample)
    assertEq('文字数(UTF-16長)が変わらない', out.length, sample.length)
    assertEq('全角ユーザー名が消える', out.includes(fullwidthUser), false)
    assertTrue('伏せ字に全角の "Ｘ" が使われる(半角xだけだと表示幅が縮む)', out.includes('Ｘ'))
  } else {
    console.log('  (skip: ユーザー名が ASCII 英数字3文字以上でない環境)')
  }
}

console.log('')
console.log('[C19] redactRawStream: 識別子(repo/branch)自体が全角を含んでいても、')
console.log('      画面上は半角で描画された同じ内容を検出してマスクできること(NFKC 正規化)。')
{
  setRepoIdentifiers(['branch-１２３']) // 識別子自体が全角数字を含む(合成テストケース)
  const sample = '\x1b[38;2;153;153;153msome-repo/branch-123\x1b[102G◉ xhigh · /effort\x1b[39m\r\n' // 画面上は半角
  const out = redactRawStream(sample)
  assertEq('半角描画のブランチ名も一致してマスクされる', out.includes('branch-123'), false)
  assertEq('文字数が変わらない', out.length, sample.length)

  restoreDefaultRepoIdentifiers()
}

console.log('')
console.log('[C20] isStatuslineText: 実データ発見の回帰固定 — "manual mode on" が語間を')
console.log('      カーソル横移動(CSI n G)で作る個体(実スペース文字が無い)でも検出できること。')
console.log('      (実際の e2e-raw-mcp.log から発見した残存。バイト列を')
console.log('      素直に連結すると "manualmodeon" になり、旧来の .includes(\'manual mode on\')')
console.log('      では検出できなかった。単純な decode grep では検出できない残存だったため、')
console.log('      セル座標ベースの再生検査〔scanReplayForResidue〕で発見した。)')
{
  // e2e-raw-mcp.log 実測: "manual" + CSI[12G] + "mode" + CSI[17G] + "on"(語間に実スペース無し)。
  const sample = '\x1b[38;2;153;153;153m\x1b[5Gmanual\x1b[12Gmode\x1b[17Gon\x1b[39m\r\r\n'
  const out = redactRawStream(sample)
  assertEq('列ジャンプ manual mode on: 文字数が変わらない', out.length, sample.length)
  assertEq('列ジャンプ manual mode on: "manual" が残らない', out.includes('manual'), false)
  assertEq('列ジャンプ manual mode on: "mode" が残らない', out.includes('mode'), false)
  // "on" は短い一般語のため単独の残存チェックはしない(過剰マスクの副作用を避けるため
  // このトークン自体は他の語と同じ論理行としてまとめて伏せられる。isChromeText で確認する)。
  const { isChromeText, stripControlTokensToText } = require('./tools/lib-redact.js')
  assertEq('列ジャンプ manual mode on: 残存検査(isChromeText)で検出されない', isChromeText(stripControlTokensToText(out)), false)
}

// -------------------------------------------------------
// 第5段: マーカー位置・行境界制御コード・home パス境界・表示幅・OSC body・識別子正規化の境界ケース
// (extract-fixture.js 側の fail-close 検査に属する項目はこのファイルの対象外。
// 過剰置換チェックは前段の実装で既に充足)。
// -------------------------------------------------------

console.log('')
console.log('[C21] redactRawStream: マーカーがトークンの先頭ではなく途中にある')
console.log('      個体(例 "Claude 77% 📒" が分割されず1トークンのまま)でも、マーカーの')
console.log('      手前の地の文までマスクされること(旧実装は同一 token 内の前置を残していた)。')
{
  const sample =
    '\x1b[38;2;177;185;249m❯ 1. Yes' + // token1: 選択肢(chrome 灰色ではない)
    '\x1b[38;2;153;153;153mClaude 77% 📒: reset' + // token2: 灰色、マーカーが「途中」にある1トークン
    '\x1b[39m\r\n'
  const out = redactRawStream(sample)
  assertEq('同一token: 文字数が変わらない', out.length, sample.length)
  assertTrue('同一token: 選択肢部分 "❯ 1. Yes" は残る', out.includes('❯ 1. Yes'))
  assertEq('同一token: マーカー手前の "Claude" が残らない', out.includes('Claude'), false)
  assertEq('同一token: マーカー手前の使用率 "77%" が残らない', out.includes('77%'), false)
  assertEq('同一token: マーカー "📒" 自体も残らない', out.includes('📒'), false)
}

console.log('')
console.log('[C22] redactRawStream: CSI E/F・ESC D/E/M(IND/NEL/RI)・VT/FF も')
console.log('      行境界として扱われること(初版は CSI A/B/H/f/d/e のみで対象外だった)。')
console.log('      これらを境界に含めないと、statusline マーカーを含まない無関係な手前の行が')
console.log('      チェックマーカーを含む後続行と誤って同一の「論理行」に併合され、マーカー基準の')
console.log('      cut=0(行全体マスク)判定に巻き込まれて丸ごと消えてしまう(過剰マスク)。')
{
  const boundaries = [
    ['CSI E(次行の先頭へ)', '\x1b[1E'],
    ['CSI F(前行の先頭へ)', '\x1b[1F'],
    ['ESC D(IND)', '\x1bD'],
    ['ESC E(NEL)', '\x1bE'],
    ['ESC M(RI)', '\x1bM'],
    ['VT(0x0b)', '\x0b'],
    ['FF(0x0c)', '\x0c'],
  ]
  for (const [label, seq] of boundaries) {
    const sample = 'SomeUnrelatedText' + seq + '\x1b[38;2;153;153;153m📒 usage=77%\x1b[39m\r\n'
    const out = redactRawStream(sample)
    assertEq(`${label}: 文字数が変わらない`, out.length, sample.length)
    assertTrue(`${label}: 境界の手前にある無関係な行は過剰マスクされず残る`, out.includes('SomeUnrelatedText'))
    assertEq(`${label}: 境界の後ろにある statusline マーカー行は正しくマスクされる`, out.includes('usage=77%'), false)
  }
}

console.log('')
console.log('[C23] redactRawStream: home パスのユーザー名部分の否定文字クラスに')
console.log('      SENTINEL(U+FFFF)が入り、カーソルジャンプ越しに連結された選択肢文言まで')
console.log('      home パスの一部として過剰マスクされないこと。')
{
  const sample = '/home/alice\x1b[42GYes\r\n'
  const out = redactRawStream(sample)
  assertEq('文字数が変わらない', out.length, sample.length)
  assertEq('ユーザー名部分 "alice" は伏せられる', out.includes('alice'), false)
  assertTrue('選択肢文言 "Yes" は過剰マスクされず残る', out.includes('Yes'))
}

console.log('')
console.log('[C24] redact(): 絵文字(📒)は実測どおり表示幅1として扱われ、')
console.log('      伏せ字も半角の "x"(全角の "Ｘ" ではない)になること(この @xterm/headless')
console.log('      既定設定では絵文字は半角相当。旧実装は幅2と誤って仮定していた)。')
{
  assertEq('📒 を含む statusline 行の伏せ字に全角 "Ｘ" が使われない', redact(PURE_MODEL_LINE).includes('Ｘ'), false)
  assertEq('文字数が変わらない(半角の伏せ字でも長さは保存される)', redact(PURE_MODEL_LINE).length, PURE_MODEL_LINE.length)
}

console.log('')
console.log('[C25] redactRawStream: OSC body(ウィンドウ/タブタイトル設定)に')
console.log('      混入した chrome マーカー(📒 等)も、識別子でなくても丸ごとマスクされること')
console.log('      (旧実装は識別子だけを見ており、chrome マーカーは素通りしていた)。')
{
  const sample = '\x1b]0;📒 usage=77%\x07' + 'normal text\r\n'
  const out = redactRawStream(sample)
  assertEq('文字数が変わらない', out.length, sample.length)
  assertEq('OSC body 内のマーカー "📒" が残らない', out.includes('📒'), false)
  assertEq('OSC body 内の使用率 "usage=77%" が残らない', out.includes('usage=77%'), false)
  assertTrue('OSC 外の通常テキストは残る', out.includes('normal text'))
}

console.log('')
console.log('[C26] redactRawStream: 分解形(NFD 相当、"e"+結合アキュート)で')
console.log('      描画されたブランチ名でも、識別子側の合成済み("é")と正しく一致してマスク')
console.log('      できること(旧実装はコードポイント単位で個別に normalize するため、この')
console.log('      結合が起こらず検出漏れになっていた)。')
{
  // chrome 色(タイトルバー等)を伴わない、識別子マッチ「だけ」が頼りの地の文で検証する
  // (chrome 色を伴わせると maskLogicalLine 側の別経路でも丸ごとマスクされてしまい、
  // 「識別子の NFKC 合成」の効果だけを切り分けられないため)。
  const precomposedE = String.fromCodePoint(0xe9) // "é"(合成済み、U+00E9)
  setRepoIdentifiers([`caf${precomposedE}-branch`])
  const decomposedSeq = 'e' + String.fromCodePoint(0x0301) // "e" + 結合アキュート(分解形)
  const sample = `working on caf${decomposedSeq}-branch today\r\n`
  const out = redactRawStream(sample)
  assertEq('文字数が変わらない', out.length, sample.length)
  assertEq('分解形で描画されたブランチ名 "branch" がマスクされる', out.includes('branch'), false)
  assertTrue('無関係な地の文 "working on" は残る', out.includes('working on'))
  const leak = findRawIdentifierLeaks(out)
  assertEq('findRawIdentifierLeaks が残存を検出しない(マスク自体が成功する)', leak.leaked, false)

  restoreDefaultRepoIdentifiers()
}

// -------------------------------------------------------
// 第6段: secret scanner・入力長の上限ガード・Windows home パスの大小文字非依存。
// 識別子検査(findRawIdentifierLeaks)とは別レイヤの検査群。
// -------------------------------------------------------

console.log('')
console.log('[C27] scanForSecrets(): API key / token / 資格情報らしきパターンの検出。')
console.log('      旧来の識別子検査(findRawIdentifierLeaks)はこれらを検出しないこと')
console.log('      (ユーザー名/home パス/repo名/branch名だけを見る別レイヤの検査のため)、')
console.log('      新設の scanForSecrets はパターンごとに検出することを確認する。')
{
  const { scanForSecrets } = require('./tools/lib-redact.js')
  const samples = [
    ['AWS Access Key', 'token leaked: AKIA' + '1234567890ABCDEF in the log'], // secrets-scan: ignore
    ['GitHub Token', 'auth via ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789AB'], // secrets-scan: ignore
    ['Anthropic API Key', 'key=sk-ant-' + 'api03-abcdefghijklmnopqrstuvwxyz0123456789'], // secrets-scan: ignore
    ['OpenAI API Key', 'key=sk-' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'], // secrets-scan: ignore
    ['Slack Token', 'token xoxb-' + '1234567890-abcdefghij'], // secrets-scan: ignore
    ['Google API Key', 'AIza' + 'SyAbCdEfGhIjKlMnOpQrStUvWxYz0123456'], // secrets-scan: ignore
    ['Stripe Key', 'sk_live_' + 'abcdefghijklmnopqrstuvwx'], // secrets-scan: ignore
    ['Private Key PEM', '-----BEGIN RSA ' + 'PRIVATE KEY-----'], // secrets-scan: ignore
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'], // secrets-scan: ignore
    ['Generic password', 'password: "supersecret"'], // secrets-scan: ignore
    ['Generic api_key', 'api_key: "abcdefgh12345678"'], // secrets-scan: ignore
  ]
  for (const [name, line] of samples) {
    const oldCheck = findRawIdentifierLeaks(line)
    assertEq(`findRawIdentifierLeaks は ${name} を検出しない(旧来の唯一の検査だと見逃す証拠)`, oldCheck.leaked, false)
    const r = scanForSecrets(line)
    assertTrue(`scanForSecrets は ${name} を検出する`, r.leaked)
    assertTrue(`scanForSecrets の一致に ${name} が含まれる`, r.matches.some((m) => m.name === name))
  }
}

console.log('')
console.log('[C28] scanForSecrets(): プレースホルダ語を含む行は誤検知回避でスキップされる')
console.log('      (dotfiles check-hardcoded-secrets.sh と同じ運用)、通常テキストは検出しない。')
{
  const { scanForSecrets } = require('./tools/lib-redact.js')
  assertEq('EXAMPLE を含む AWS 風文字列はスキップされる', scanForSecrets('AKIAIOSFODNN7EXAMPLE').leaked, false)
  assertEq('通常のテキストは検出されない', scanForSecrets('this is just a normal log line').leaked, false)
}

console.log('')
console.log('[C29] redact()/redactRawStream(): 入力長の上限ガード — 上限を超える入力は')
console.log('      マスクを省略せず例外で fail-close すること(中途半端な出力を返さない)。')
{
  const huge = 'a'.repeat(2_000_001)
  let threw = false
  try {
    redact(huge)
  } catch (e) {
    threw = true
  }
  assertTrue('上限超過の入力で redact() が例外を投げる', threw)

  let threw2 = false
  try {
    redactRawStream(huge)
  } catch (e) {
    threw2 = true
  }
  assertTrue('上限超過の入力で redactRawStream() が例外を投げる', threw2)

  let threw3 = false
  try {
    redact('a'.repeat(1000))
  } catch (e) {
    threw3 = true
  }
  assertEq('上限以下の入力では例外が起きない(回帰確認)', threw3, false)
}

console.log('')
console.log('[C30] WIN_HOME_PATH_RE: 大小文字非依存 — "C:\\USERS\\<user>"(全大文字)でも')
console.log('      home パス形状として検出・マスクされること(旧実装は [Uu]sers の2択のみで')
console.log('      "USERS" 全大文字表記を見逃していた)。')
{
  const { hasAnyHomePathShape } = require('./tools/lib-redact.js')
  const sample = 'path: C:\\USERS\\alice\\project'
  assertTrue('hasAnyHomePathShape が全大文字 USERS を検出する', hasAnyHomePathShape(sample))
  const out = redact(sample)
  assertEq('redact() で "alice" が残らない', out.includes('alice'), false)
}

console.log('\n────────────────────────────────────────')
console.log(`  passed: ${passed}, failed: ${failed}`)
console.log('────────────────────────────────────────\n')
process.exit(failed ? 2 : 0)
