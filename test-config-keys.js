/**
 * test-config-keys.js — example config に「実装がどこからも読まない未知キー」が
 * 紛れ込んでいないことを検証する回帰テスト。
 *
 * 背景: 過去に `dialogDetection.triggers` という、claude-wrapper.js / approval-server.js
 * のどこからも参照されない死んだキーが example に残っていた事故があった(codex 指摘 S001)。
 * example は利用者がコピーして使う設定の見本であるため、実装が読まないキーが残っていると
 * 「設定したのに効かない」という無言の事故につながる。
 *
 * 検証方法: example の JSON をネスト展開(ドット記法)し、全キーが下記 ALLOWED_CONFIG_KEYS
 * (実装コードを grep して人手で網羅同定した allowlist)に含まれることを assert する。
 *
 * 使い方: node test-config-keys.js
 */

const fs = require('fs')
const path = require('path')

// -------------------------------------------------------
// allowlist: claude-wrapper.js / approval-server.js が実際に読む config キー
// -------------------------------------------------------
// 同定方法: 両ファイルを `config.` / `_dialogDetection.` / `dd.` で grep し、
// config オブジェクトへの全アクセスを洗い出した(2026-08 時点、行番号は目安)。
// 分割代入や `config[...]` 動的アクセス、`...config` スプレッドは存在しない
// (grep で確認済み)ため、allowlist は網羅的である。
//
// 将来 config に新しいキーを実装が読むようになったら、ここに追記すること。
// 逆に実装から config キーの参照を削除したら、この allowlist からも該当キーを
// 消すこと(消し忘れると死んだキーの検出漏れになる。allowlist は実装から自動追従しない)。
//   - port                          … claude-wrapper.js:59 / approval-server.js:37,637
//   - token                         … claude-wrapper.js:60 / approval-server.js:40
//   - target.command                … claude-wrapper.js:294
//   - wrapperLog                    … claude-wrapper.js:414
//   - dialogDetection.tabSweep      … claude-wrapper.js:3016 (_dialogDetection.tabSweep)
//   - dialogDetection.endMarker     … claude-wrapper.js:136-137,144-145 (legacy, 非推奨だが読まれる)
//   - dialogDetection.endMarkers.default   … claude-wrapper.js:132
//   - dialogDetection.endMarkers.exitPlan  … claude-wrapper.js:133
const ALLOWED_CONFIG_KEYS = new Set([
  'port',
  'token',
  'target.command',
  'wrapperLog',
  'dialogDetection.tabSweep',
  'dialogDetection.endMarker',
  'dialogDetection.endMarkers.default',
  'dialogDetection.endMarkers.exitPlan',
])

// -------------------------------------------------------
// object を "a.b.c" 形式のキー配列に平坦化する。ネストしたプレーンオブジェクトのみ
// 再帰し、配列・プリミティブはそこで葉として確定する。
//
// 空のプレーンオブジェクト({})は entries が無いため、素朴に再帰するとキー自体が
// 消えて捨てられる(B001: 例えば { unknown: {} } が「未知キーなし」と誤判定される)。
// prefix が付いている(=ルートではない)空オブジェクトは、それ自体を葉として残す。
// ルート自体が空({} そのもの)のときは未知キーを出さない(C0 で固定)。空 config を
// 異常扱いしないための挙動であり、キーが1つも無い以上そもそも未知キーは存在しない。
//
// キー名自体にリテラルな "." が含まれる場合(例: { "dialogDetection.tabSweep": false }
// という平坦な1キー)、区切り文字としての "." と衝突すると、ネスト由来の正当なキー
// (dialogDetection.tabSweep)と文字列として一致してしまい未知キーが素通りする(W001)。
// これを避けるため、各セグメントのキー名に含まれるリテラル "." は結合前に "\." へ
// エスケープする(allowlist 側は区切りドットしか持たないためエスケープ不要 = 不一致になり
// 未知キーとして正しく検出される)。
// -------------------------------------------------------
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function flattenKeys(obj, prefix = '') {
  const entries = Object.entries(obj)
  if (entries.length === 0) {
    return prefix ? [prefix] : []
  }
  return entries.flatMap(([k, v]) => {
    const escapedK = k.replace(/\./g, '\\.')
    const keyPath = prefix ? `${prefix}.${escapedK}` : escapedK
    return isPlainObject(v) ? flattenKeys(v, keyPath) : [keyPath]
  })
}

function findUnknownKeys(obj, allowedSet) {
  return flattenKeys(obj).filter((k) => !allowedSet.has(k))
}

// -------------------------------------------------------
let passed = 0
let failed = 0

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
console.log('[C0] チェッカー自体の反証性: 空オブジェクト(B001)/ リテラルドット衝突(W001)の未知キーを検知できること')
// -------------------------------------------------------
{
  // 空のプレーンオブジェクトは entries が無いため、素朴な実装では再帰時にキーごと
  // 捨てられ「未知キーなし」と誤判定される(修正前は下記が両方とも [] を返していた)。
  assertEq(
    '未知キーが空オブジェクトでも検出する({ unknown: {} })',
    findUnknownKeys({ unknown: {} }, ALLOWED_CONFIG_KEYS),
    ['unknown']
  )
  assertEq(
    '既知セクション名でも中身が空オブジェクトなら葉として検出する({ dialogDetection: {} })',
    findUnknownKeys({ dialogDetection: {} }, ALLOWED_CONFIG_KEYS),
    ['dialogDetection']
  )
  // ルート自体が空({} そのもの)のときは未知キーを出さないことも固定する。
  // 空 config を異常扱いしないための挙動確認であり、本番の読込失敗フォールバック
  // 経路そのものをこのテストが通しているわけではない。
  assertEq('ルート自体が空オブジェクトなら未知キーなし({})', findUnknownKeys({}, ALLOWED_CONFIG_KEYS), [])
  // リテラルなドット入りキー(平坦な1キー)が、ネスト由来の正当な dot 記法キーと
  // 文字列として衝突し「既知キー」扱いで素通りしないことを固定する(W001)。
  // エスケープ前の実装では下記が [] を返していた(検出漏れ)。
  assertEq(
    'リテラルドット入りキーは区切りドットと衝突させず未知キーとして検出する',
    findUnknownKeys({ 'dialogDetection.tabSweep': false }, ALLOWED_CONFIG_KEYS),
    ['dialogDetection\\.tabSweep']
  )
}

// -------------------------------------------------------
console.log('[C1] チェッカー自体の反証性: 過去事故(dialogDetection.triggers)を検知できること')
// -------------------------------------------------------
{
  // 過去に example に残っていた死んだキーを模した壊れた config。
  const brokenConfig = {
    port: 3000,
    token: 'x'.repeat(32),
    dialogDetection: {
      tabSweep: true,
      triggers: ['foo', 'bar'], // ← 実装のどこからも読まれない死んだキー
    },
  }
  assertEq(
    '未知キー dialogDetection.triggers を検出する',
    findUnknownKeys(brokenConfig, ALLOWED_CONFIG_KEYS),
    ['dialogDetection.triggers']
  )
}

// -------------------------------------------------------
console.log('[C2] example ファイルの全キーが allowlist に含まれる')
// -------------------------------------------------------
{
  // 固定配列だと将来 example ファイルが増えたときに検査対象へ含め忘れるリスクがある。
  // ディレクトリを走査し、命名規則(*.example.json)に合致するものを自動で拾う。
  // 実設定ファイル(approval-config.json / approval-config.codex.json、.example.json
  // で終わらない・git 管理外)はこの正規表現にマッチせず対象外のままになる(意図通り)。
  const EXAMPLE_FILE_RE = /^approval-config.*\.example\.json$/
  const exampleFiles = fs.readdirSync(__dirname).filter((f) => EXAMPLE_FILE_RE.test(f)).sort()
  // 列挙結果が 0 件だと以降のループが空回りして無検証のまま緑になる。検査対象を
  // 含め忘れる事故とは別に、列挙自体が壊れて何も検査していない事故を防ぐガード。
  assertEq('example ファイルが1件以上見つかる', exampleFiles.length > 0, true)
  for (const file of exampleFiles) {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'))
    const unknown = findUnknownKeys(cfg, ALLOWED_CONFIG_KEYS)
    assertEq(`${file}: 未知キーなし(見つかった場合: ${JSON.stringify(unknown)})`, unknown, [])
  }
}

console.log('\n────────────────────────────────────────')
console.log(`  passed: ${passed}, failed: ${failed}`)
console.log('────────────────────────────────────────\n')
process.exit(failed ? 2 : 0)
