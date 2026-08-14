/**
 * tools/lib-fixture-frame.js — `approval-attr-fixture/v1` の生成(extract-fixture.js)と
 * 再現検証(verify-fixture.js)が共有する「1 フレームぶんの dialog 判定を実行して
 * 比較可能な状態オブジェクトを作る」ロジック。
 *
 * 2 箇所に同じ判定ロジックを別々に書くと drift する(tools/lib-cellattrs.js のコメントと
 * 同じ教訓)ため、ここへ集約する。判定は production の関数(frameOf / readTabBarRow /
 * __test.barRowIsCliDrawn / __test.getScreenText / __test.getViewportText / parseDialog)を
 * そのまま呼ぶだけで、ここでも手写ししない。
 */
'use strict'

const crypto = require('crypto')
const { dumpRowAttrs } = require('./lib-cellattrs.js')

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** canonical JSON 文字列化(オブジェクトキーを再帰的にソート)。digest / 比較の環境依存を避ける。 */
function canonicalStringify(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalStringify).join(',')}]`
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/** runlength run(lib-cellattrs.dumpRowAttrs の出力)を fixture スキーマの run 形へ変換する。 */
function toFixtureRuns(runs) {
  return runs.map((r) => ({
    x: r.xStart,
    len: r.xEnd - r.xStart + 1,
    ch: r.text,
    fgMode: r.attrs.fgMode,
    fg: r.attrs.fg,
    bgMode: r.attrs.bgMode,
    bg: r.attrs.bg,
    bold: !!r.attrs.bold,
    dim: !!r.attrs.dim,
    inverse: !!r.attrs.inverse,
  }))
}

/**
 * 現在の @xterm/headless Terminal の状態から「dialog 判定 1 サイクル」を実行し、
 * extract-fixture.js / verify-fixture.js の両方が比較に使う状態オブジェクトを返す。
 *
 * 対象行(target row)の決め方: `opts.targetRowY` を明示すればそれを使う(verify-fixture.js
 * = fixture に記録済みの行を再現する用途)。省略時は「readTabBarRow が成立していれば
 * bar-row、そうでなければ frameOf の rule-line」で自動選択する(extract-fixture.js =
 * 新規 fixture の対象行を構造から決める用途。手で行を選ばない = 一貫した規則)。
 *
 * @param {object} claudeWrapper claude-wrapper.js の module.exports(呼び出し側が require 済み)
 * @param {(screenText: string) => object|null} frameOf lib-cellattrs.makeFrameOf() の戻り値
 * @param {import('@xterm/headless').Terminal} term __test.setHeadlessTerm 済みの Terminal
 * @param {number} rows
 * @param {{targetRowY?: number|null, targetRowKind?: string|null}} [opts]
 */
function captureFrameState(claudeWrapper, frameOf, term, rows, opts = {}) {
  const buf = term.buffer.active
  const viewportText = claudeWrapper.__test.getViewportText()
  const f = frameOf(viewportText)
  let barRow = null
  try {
    barRow = claudeWrapper.readTabBarRow(buf, rows)
  } catch (_) {}
  const barFound = !!(barRow && typeof barRow.y === 'number')
  const cliDrawn = claudeWrapper.__test.barRowIsCliDrawn()
  const screenText = claudeWrapper.__test.getScreenText()
  const full = claudeWrapper.parseDialog(screenText)
  const screenOnly = claudeWrapper.parseDialog(screenText, { screenOnly: true })

  let targetRowKind = opts.targetRowKind !== undefined ? opts.targetRowKind : null
  let targetRowY = opts.targetRowY !== undefined ? opts.targetRowY : null
  if (targetRowY === null || targetRowY === undefined) {
    if (barFound) {
      targetRowKind = 'bar-row'
      targetRowY = barRow.y
    } else if (f) {
      targetRowKind = 'rule-line'
      targetRowY = f.iRule
    }
  }
  const runs = targetRowY !== null && targetRowY !== undefined ? toFixtureRuns(dumpRowAttrs(buf, targetRowY)) : []

  return {
    frameOfFound: !!f,
    barRowFound: barFound,
    cliDrawn,
    targetRowKind,
    targetRowY,
    runs,
    parseDialogFull: full
      ? { forwardable: true, tool: full.tool, args: full.args, optionsCount: full.options.length }
      : { forwardable: false, tool: null, args: null, optionsCount: null },
    parseDialogScreenOnly: screenOnly
      ? { readableAsDialog: true, tool: screenOnly.tool, args: screenOnly.args }
      : { readableAsDialog: false, tool: null, args: null },
  }
}

/**
 * captureFrameState() の結果から、redaction 前後の不変性検証・digest 用に比較すべき
 * フィールドだけを取り出す(extract-fixture.js の redaction 前後不変性検査、verify-fixture.js の
 * digest 検証で共通して使う部分集合)。
 */
function comparableFields(c) {
  return {
    frameOfFound: c.frameOfFound,
    barRowFound: c.barRowFound,
    cliDrawn: c.cliDrawn,
    targetRowKind: c.targetRowKind,
    targetRowY: c.targetRowY,
    runs: c.runs,
    parseDialogFull: c.parseDialogFull,
    parseDialogScreenOnly: c.parseDialogScreenOnly,
  }
}

module.exports = { sha256Hex, canonicalStringify, toFixtureRuns, captureFrameState, comparableFields }
