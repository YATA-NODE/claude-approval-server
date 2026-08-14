/**
 * test-attr-fixtures.js — test/fixtures/attr/*.json(approval-attr-fixture/v1)の
 * スモークテスト。セル属性 fixture が「fixture だけでセキュリティ判定を再現できる」
 * ことを npm test の一部として固定する(tools/verify-fixture.js を呼ぶだけで、判定ロジック
 * 自体はここに書かない = drift 防止)。
 *
 * 反証性の確認(「緑だけのテストは何も証明しない」への対応): このファイル自体は
 * 常に正しい fixture だけを検査するため反証テストを含まない。反証性は
 * `tools/verify-fixture.js` が期待判定を破った版で実際に FAIL することを手動実行で
 * 確認済み(コマンドと結果は作業報告に記載。fixture を書き換えて再度 FAIL させない
 * 恒久的な「壊れた fixture」はリポに残さない = 混乱の元)。
 *
 * 使い方: node test-attr-fixtures.js
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { verifyFixtureFile } = require('./tools/verify-fixture.js')

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

;(async () => {
  const dir = path.join(__dirname, 'test', 'fixtures', 'attr')
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []

  // 列挙結果が 0 件だと以降のループが空回りして無検証のまま緑になる事故を防ぐ
  // (test-config-keys.js と同じ設計)。
  assertEq('fixture が1件以上見つかる', files.length > 0, true)

  for (const f of files) {
    const r = await verifyFixtureFile(path.join(dir, f))
    assertEq(`${f}: verify-fixture PASS(${r.id})`, r.ok, true)
    if (!r.ok) {
      for (const d of r.diffs) console.log(`      - ${d}`)
    }
  }

  console.log('\n────────────────────────────────────────')
  console.log(`  passed: ${passed}, failed: ${failed}`)
  console.log('────────────────────────────────────────\n')
  process.exit(failed ? 2 : 0)
})()
