/**
 * test-shift-tab-diff.js — Shift+Tab 送出ゲート(shiftTabBlockedReason)の差分テスト。
 *
 * 目的: R2(借り返し早期許可を属性ゲートの後ろへ移す)の変更が、旧実装の許可集合の
 * **部分集合**であり、縮小が「属性を確認できない借り返し」だけに限られることを
 * 全列挙で固定する。旧スペック(headAllowSpec)の転記の正しさは、ゲート変更前の
 * コミット(C3a)で `PRODUCTION_SPEC = headAllowSpec` として本テストが CI 緑だったこと
 * が証明している(二相コミット。旧実装 = v1.20.0 = commit 662aaa6 と分岐構造同一)。
 *
 * フェーズ切替: production の許可集合は PRODUCTION_SPEC が指す関数で表す。
 * 現フェーズは `PRODUCTION_SPEC = newAllowSpec`(R2 適用後)。
 * 本ファイルの不変条件 (a)(b)(c) はフェーズに依存しない形で書いてある
 * (固定参照 headAllowSpec に対する部分集合・特徴づけ・非劣化)。
 *
 * 比較対象は実装から import せず独立定義する(spec の転記が正しいかを見るのが
 * このテストの意味なので、比較対象が別定義であることが要点)。
 *
 * 使い方: node test-shift-tab-diff.js
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { Terminal } = require('@xterm/headless')

const cw = require('./claude-wrapper.js')
const { replayFrames } = require('./tools/lib-cellattrs.js')

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

// -------------------------------------------------------
// 凍結スペック(v1.20.0 / commit 662aaa6、claude-wrapper.js shiftTabBlockedReason 原文の
// 転記。当時の識別子は barRowIsCliDrawn):
//   if (isExitPlanScreen(viewport)) return '...'
//   if (debtReturnOk && forwardTabDebt > 0 && findTabBarLine(viewport) !== null
//       && findFooterIndex(viewport.split('\n')) === -1) return null
//   if (!barRowIsCliDrawn()) return '...'
//   if (hasTabNavFooter(viewport)) return null
//   return '...'
// -------------------------------------------------------
function headAllowSpec(s) {
  // s = { exitPlan, dro, debt, barLine, footAbsent, attr, nav }
  if (s.exitPlan) return false
  if (s.dro && s.debt > 0 && s.barLine && s.footAbsent) return true
  return s.attr && s.nav
}
// 変更後(R2)の許可集合。次のコミットで production がこちらへ切り替わる。
// 新 ⊆ 旧: 新の許可はどちらの枝でも旧の対応枝が許可(attr∧nav ⊆ 旧の第3式 /
// attr∧debtPath ⊆ 旧の第2式)。縮小 = debtPath ∧ !attr のみ。
function newAllowSpec(s) {
  if (s.exitPlan || !s.attr) return false
  if (s.nav) return true
  return s.dro && s.debt > 0 && s.barLine && s.footAbsent
}

// 現フェーズ: production ≡ newAllowSpec(R2 適用後)。
// 前コミット(C3a)では headAllowSpec を指しており、その CI 緑が「旧スペック転記の正しさ」を
// 証明している(二相コミット。切替忘れは本テストが FAIL して顕在化する)。
const PRODUCTION_SPEC = newAllowSpec

// -------------------------------------------------------
// フェーズ非依存の不変条件。フレーム毎に console へ出すと数万行になるため、
// 違反があれば説明文字列を返す(空配列 = 違反なし)。呼び出し側が蓄積して
// 最後にまとめて件数 assert する。
//   (a) 部分集合: productionAllow ⇒ headAllowSpec(s)
//   (b) 縮小の特徴づけ: (headAllowSpec(s) ∧ !productionAllow)
//       ⇒ (!s.attr ∧ s.dro ∧ s.debt>0 ∧ s.barLine ∧ s.footAbsent)
//   (c) 非劣化: s.attr === true のとき productionAllow === headAllowSpec(s)
// -------------------------------------------------------
function invariantViolations(s, productionAllow) {
  const out = []
  const headAllow = headAllowSpec(s)
  const specAllow = PRODUCTION_SPEC(s)
  if (productionAllow !== specAllow) {
    out.push(`PRODUCTION_SPEC 不一致: spec=${specAllow} actual=${productionAllow}`)
  }
  if (productionAllow && !headAllow) {
    out.push('(a) 部分集合違反: production 許可だが headAllowSpec 不許可')
  }
  if (headAllow && !productionAllow) {
    const characterized = !s.attr && s.dro && s.debt > 0 && s.barLine && s.footAbsent
    if (!characterized) {
      out.push('(b) 縮小の特徴づけ違反: head 許可 かつ production 不許可だが縮小の特徴に一致しない')
    }
  }
  if (s.attr === true && productionAllow !== headAllow) {
    out.push(`(c) 非劣化違反: attr=true なのに production(${productionAllow}) ≠ head(${headAllow})`)
  }
  return out
}

// フレームの viewport から論理式の 5 成分を観測する純関数。
function observeComponents(viewport) {
  return {
    exitPlan: cw.isExitPlanScreen(viewport),
    barLine: cw.findTabBarLine(viewport) !== null,
    footAbsent: cw.findFooterIndex(viewport.split('\n')) === -1,
    attr: cw.__test.barRowHasStyledCells(),
    nav: cw.hasTabNavFooter(viewport),
  }
}

// production 実呼出しの共通処理(実フレーム leg / 合成 leg の両方から使う)。
// s.debt / s.dro を production の __test シームへ渡し、shiftTabBlockedReason の
// 結果を許可(null)/ 不許可(理由文字列)から productionAllow の真偽値へ落とす。
function evalProduction(s, viewport) {
  cw.__test.setForwardTabDebt(s.debt)
  let blocked
  let threw = null
  try {
    blocked = cw.__test.shiftTabBlockedReason(viewport, { debtReturnOk: s.dro })
  } catch (e) {
    threw = e
  }
  return { productionAllow: blocked === null, threw }
}

;(async () => {
  const violations = []
  let totalFrames = 0
  let totalCombosChecked = 0
  let totalAllowCount = 0

  // -------------------------------------------------------
  console.log('\n[実フレーム leg] fixture 再生 × chunk {64,128,512} × debt{0,2} × dro{false,true}')
  // -------------------------------------------------------
  const fixtureDir = path.join(__dirname, 'test', 'fixtures', 'attr')
  const fixtureFiles = fs.existsSync(fixtureDir)
    ? fs.readdirSync(fixtureDir).filter((f) => f.endsWith('.json')).sort()
    : []
  // 列挙が空だと以降のループが空回りして無検証のまま緑になる(test-attr-fixtures.js と同型の防止策)。
  assertEq('fixture が8件見つかる(現行 test/fixtures/attr/*.json の構成)', fixtureFiles.length, 8)

  const CHUNK_SIZES = [64, 128, 512]

  for (const fname of fixtureFiles) {
    const fixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, fname), 'utf8'))
    const data = Buffer.from(fixture.raw_pty.data_b64, 'base64').toString('utf8')
    const { cols, rows } = fixture.geometry

    for (const chunk of CHUNK_SIZES) {
      const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
      cw.__test.setHeadlessTerm(term)

      await replayFrames(term, data, {
        chunk,
        onFrame: (frameIdx) => {
          totalFrames++
          const viewport = cw.__test.getViewportText()
          const comps = observeComponents(viewport)
          const ctx = `${fixture.id} chunk=${chunk} frame=${frameIdx}`

          for (const debt of [0, 2]) {
            for (const dro of [false, true]) {
              totalCombosChecked++
              const s = { ...comps, debt, dro }
              const { productionAllow, threw } = evalProduction(s, viewport)
              if (threw) {
                violations.push(`${ctx} debt=${debt} dro=${dro}: 例外を投げた(${threw.message})`)
                continue
              }
              if (productionAllow) totalAllowCount++
              for (const v of invariantViolations(s, productionAllow)) {
                violations.push(`${ctx} debt=${debt} dro=${dro}: ${v}`)
              }
            }
          }
        },
      })
      term.dispose()
    }
  }

  assertEq('総フレーム数 > 0', totalFrames > 0, true)
  assertEq('全列挙(フレーム×debt×dro)での許可総数 > 0', totalAllowCount > 0, true)
  assertEq('実フレーム leg: 違反 0 件(PRODUCTION_SPEC 一致 + 不変条件(a)(b)(c))', violations.length, 0)
  if (violations.length > 0) {
    console.log(`  違反例(先頭 5 件、総数 ${violations.length}):`)
    for (const v of violations.slice(0, 5)) console.log(`    - ${v}`)
  }
  console.log(
    `  [実フレーム leg 集計] fixture=${fixtureFiles.length} 総フレーム数=${totalFrames} ` +
      `総組合せ数=${totalCombosChecked} 許可総数=${totalAllowCount}`
  )
  // -------------------------------------------------------
  // [合成 leg] 縮小の証人。test-tab-sweep-state.js の [S22]/[S24] 系(plainTui /
  // fakeHeadless / install パターン)と同型の最小ヘルパをここに定義する
  // (import できないため。コピー元 = test-tab-sweep-state.js L67-105, L266-278, L291-308 相当)。
  // -------------------------------------------------------

  // 偽の headless terminal(screenTextFromBuffer / readTabBarRow の両方を満たす最小実装)。
  // コピー元: test-tab-sweep-state.js の fakeHeadless()。
  function fakeHeadless(getLines, getHighlight, getStyledSpan, getBoldSpan) {
    const cellsOf = (line) => [...line]
    return {
      get rows() {
        return getLines().length
      },
      buffer: {
        active: {
          baseY: 0,
          get length() {
            return getLines().length
          },
          getLine(y) {
            const lines = getLines()
            if (lines[y] === undefined) return null
            const chars = cellsOf(lines[y])
            const hl = getHighlight ? getHighlight() : null
            const sp = getStyledSpan ? getStyledSpan() : null
            const bp = getBoldSpan ? getBoldSpan() : null
            const inSpan = (s) => !!(s && s.row === y)
            return {
              length: chars.length,
              translateToString: () => lines[y],
              getCell: (x) => {
                if (chars[x] === undefined) return null
                return {
                  getWidth: () => 1,
                  getChars: () => chars[x],
                  isInverse: () => (hl && hl.row === y && x >= hl.from && x <= hl.to ? 1 : 0),
                  isBgDefault: () => !(inSpan(sp) && x >= sp.from && x <= sp.to),
                  isBold: () => inSpan(bp) && x >= bp.from && x <= bp.to,
                }
              },
            }
          },
        },
      },
    }
  }

  // タブ式でない画面(確認画面等)を流し込むための最小 TUI。コピー元: 同ファイル plainTui()。
  function plainTui(lines) {
    return {
      writes: [],
      highlight: null,
      lines: () => lines,
      write(d) {
        this.writes.push(d)
      },
    }
  }

  // install() の縮小版。このテストは sweepTabs を回さないので、resetSweepState /
  // setCurrentDialog / setHttpStub は不要(headlessTerm の差し替えだけで足りる)。
  function installSynthetic(tui) {
    cw.__test.setHeadlessTerm(
      fakeHeadless(
        () => tui.lines(),
        () => tui.highlight,
        () => (tui.styledSpan ? tui.styledSpan() : null),
        () => (tui.boldSpan ? tui.boldSpan() : null)
      )
    )
  }

  // 構成要素 s から viewport 上の実測値を作り、production を実呼出しして確かめる共通処理。
  // 合成 leg はシナリオ数が少ないので(実フレーム leg と違い)assertEq を惜しまず出す。
  function checkSynthetic(label, s, viewport) {
    const comps = observeComponents(viewport)
    for (const k of ['exitPlan', 'barLine', 'footAbsent', 'attr', 'nav']) {
      assertEq(`${label} 前提: ${k}`, comps[k], s[k])
    }

    const { productionAllow, threw } = evalProduction(s, viewport)
    assertEq(`${label}: 例外を投げない`, threw, null)
    assertEq(`${label}: headAllowSpec`, headAllowSpec(s), s.expectHead)
    assertEq(`${label}: newAllowSpec`, newAllowSpec(s), s.expectNew)
    // 比較先は必ず PRODUCTION_SPEC(s)(expectHead/expectNew をここに直書きすると
    // フェーズ切替に追従せず、切替コミットで偽 FAIL / 偽 PASS になる)。
    assertEq(`${label}: production(実呼出し) ≡ PRODUCTION_SPEC`, productionAllow, PRODUCTION_SPEC(s))
    for (const v of invariantViolations(s, productionAllow)) {
      assertEq(`${label}: 不変条件違反なし(${v})`, false, true)
    }
    return productionAllow
  }

  // -------------------------------------------------------
  console.log('\n[合成 leg] 縮小の証人')
  // -------------------------------------------------------
  {
    const confirmLines = ['☒ T1 ☒ T2 ✔ Submit →', 'Submit your answers?']
    const styleBarRow0 = () => ({ row: 0, from: 0, to: confirmLines[0].length - 1 })

    // 5 シナリオを表にする(破損系 corruptCases と同型)。各シナリオは confirmLines を
    // 土台に、属性(styled)の有無・末尾の終端マーカー行・s の 1 点だけを変える。
    const scenarios = [
      // [縮小証人] バー行あり・ナビフッタ無し・終端マーカー無し + 属性なし(styled 0)+
      // debt=2 + dro=true → head は許可・new は block(縮小の当該箇所)。
      {
        label: '[縮小証人]',
        styled: false,
        s: { exitPlan: false, dro: true, debt: 2, barLine: true, footAbsent: true, attr: false, nav: false, expectHead: true, expectNew: false },
      },
      // [可用性維持] 同画面 + 属性あり(styled > 0)→ head も new も許可、production も許可。
      {
        label: '[可用性維持]',
        styled: true,
        s: { exitPlan: false, dro: true, debt: 2, barLine: true, footAbsent: true, attr: true, nav: false, expectHead: true, expectNew: true },
      },
      // [境界] debt=0 / dro=false / 終端マーカーあり(footAbsent=false)の 3 変形 →
      // head も new も block。属性は常にあり(attr=true)にして、各 1 点の flip だけで
      // 落ちることを isolate する。
      {
        label: '[境界: debt=0]',
        styled: true,
        s: { exitPlan: false, dro: true, debt: 0, barLine: true, footAbsent: true, attr: true, nav: false, expectHead: false, expectNew: false },
      },
      {
        label: '[境界: dro=false]',
        styled: true,
        s: { exitPlan: false, dro: false, debt: 2, barLine: true, footAbsent: true, attr: true, nav: false, expectHead: false, expectNew: false },
      },
      {
        label: '[境界: 終端マーカーあり]',
        styled: true,
        extraLines: ['Esc to cancel'],
        s: { exitPlan: false, dro: true, debt: 2, barLine: true, footAbsent: false, attr: true, nav: false, expectHead: false, expectNew: false },
      },
    ]

    for (const sc of scenarios) {
      const lines = sc.extraLines ? [...confirmLines, ...sc.extraLines] : confirmLines
      const tui = plainTui(lines)
      if (sc.styled) tui.styledSpan = styleBarRow0
      installSynthetic(tui)
      const viewport = cw.__test.getViewportText()
      checkSynthetic(sc.label, sc.s, viewport)
    }
  }

  // -------------------------------------------------------
  console.log('\n[合成 leg] 破損系(空 viewport / 罫線のみ / 500 列の巨大 1 行)')
  // -------------------------------------------------------
  {
    const corruptCases = [
      ['空viewport', []],
      ['罫線のみ', [cw.RULE_CHARS[0].repeat(50)]],
      ['500列の巨大1行', ['A'.repeat(500)]],
    ]
    // s は 3 ケース共通(差分は viewport のみ)なのでループ外に 1 回だけ定義する。
    const s = {
      exitPlan: false,
      dro: true,
      debt: 2,
      barLine: false,
      footAbsent: true,
      attr: false,
      nav: false,
      expectHead: false,
      expectNew: false,
    }
    for (const [name, lines] of corruptCases) {
      const tui = plainTui(lines)
      installSynthetic(tui)
      const viewport = cw.__test.getViewportText()
      checkSynthetic(`[破損系: ${name}]`, s, viewport)
    }
  }

  console.log('\n────────────────────────────────────────')
  console.log(`  passed: ${passed}, failed: ${failed}`)
  console.log('────────────────────────────────────────\n')
  process.exit(failed ? 2 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(3)
})
