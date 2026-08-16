#!/usr/bin/env node
/**
 * tools/verify-fixture.js — `approval-attr-fixture/v2` fixture が「fixture だけでセキュリティ
 * 判定を再現できる」ことを検証する再現器。
 *
 * fixture の redaction 済み生 PTY(base64)を復号 → @xterm/headless に再生 →
 * production の関数(parseDialog / readTabBarRow / __test.barRowHasStyledCells /
 * __test.getScreenText)をそのまま呼んで判定 → fixture の expected_cells / expected_verdict と
 * 一致するかを比較する。判定ロジックはここで手写ししない(tools/extract-fixture.js と同じ
 * production 呼び出しを使う。2 箇所で別々の判定ロジックを持つと drift する)。
 *
 * CLI: node tools/verify-fixture.js <fixture.json|dir> [<fixture2.json> ...]
 * モジュール: const { verifyFixtureFile } = require('./tools/verify-fixture.js')
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { Terminal } = require('@xterm/headless')

const claudeWrapper = require(path.join(__dirname, '..', 'claude-wrapper.js'))
const { replayFrames, makeFrameOf } = require('./lib-cellattrs.js')
const { sha256Hex, canonicalStringify, captureFrameState } = require('./lib-fixture-frame.js')

function runsEqual(a, b) {
  return canonicalStringify(a) === canonicalStringify(b)
}

/**
 * fixture オブジェクトを再生・判定し、{ok, diffs, actual} を返す。ファイル I/O を含まない
 * 純粋寄りの検証関数(テスト側から fixture を直接渡して呼べるようにするため)。
 *
 * @param {object} fixture approval-attr-fixture/v2 の JSON
 * @returns {Promise<{ok: boolean, diffs: string[], actual: object}>}
 */
async function verifyFixture(fixture) {
  const diffs = []
  if (fixture.schema !== 'approval-attr-fixture/v2') {
    if (fixture.schema === 'approval-attr-fixture/v1') {
      return {
        ok: false,
        diffs: [
          'schema が v1(キー名が旧称 barRowIsCliDrawn)。tools/extract-fixture.js で再生成するか、' +
            'expected_verdict キーと schema を v2 へ手動改名すること',
        ],
        actual: null,
      }
    }
    return { ok: false, diffs: [`schema 不一致: ${fixture.schema}`], actual: null }
  }

  const redactedBuf = Buffer.from(fixture.raw_pty.data_b64, 'base64')
  const actualSha = sha256Hex(redactedBuf)
  if (actualSha !== fixture.raw_pty.sha256) {
    diffs.push(`raw_pty.sha256 不一致: fixture=${fixture.raw_pty.sha256} actual=${actualSha}`)
  }
  const data = redactedBuf.toString('utf8')

  const { cols, rows, chunk } = fixture.geometry
  const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
  claudeWrapper.__test.setHeadlessTerm(term)
  const frameOf = makeFrameOf(claudeWrapper)

  let captured = null
  let totalFrames = 0
  const targetFrame = fixture.frame.frame_index

  async function onFrame(frameIdx) {
    totalFrames = frameIdx
    if (frameIdx !== targetFrame) return
    // fixture に記録済みの対象行(target_row_y)をそのまま使う(extract 時に自動選択した
    // 結果を再現する側であって、ここで選び直さない)。
    captured = captureFrameState(claudeWrapper, frameOf, term, rows, {
      targetRowY: fixture.expected_cells.target_row_y,
      targetRowKind: fixture.expected_cells.target_row_kind,
    })
  }

  await replayFrames(term, data, { chunk, onFrame })
  term.dispose()

  if (!captured) {
    diffs.push(`frame #${targetFrame} が再生で見つからなかった(総フレーム数=${totalFrames})`)
    return { ok: false, diffs, actual: null }
  }
  if (totalFrames !== fixture.frame.total_frames) {
    diffs.push(`総フレーム数不一致: fixture=${fixture.frame.total_frames} actual=${totalFrames}`)
  }

  const ev = fixture.expected_verdict
  if (captured.frameOfFound !== ev.frameOf) diffs.push(`frameOf 不一致: expected=${ev.frameOf} actual=${captured.frameOfFound}`)
  if (captured.barRowFound !== ev.readTabBarRow)
    diffs.push(`readTabBarRow 不一致: expected=${ev.readTabBarRow} actual=${captured.barRowFound}`)
  if (captured.cliDrawn !== ev.barRowHasStyledCells)
    diffs.push(`barRowHasStyledCells 不一致: expected=${ev.barRowHasStyledCells} actual=${captured.cliDrawn}`)
  if (canonicalStringify(captured.parseDialogFull) !== canonicalStringify(ev.parseDialog)) {
    diffs.push(
      `parseDialog 不一致: expected=${JSON.stringify(ev.parseDialog)} actual=${JSON.stringify(captured.parseDialogFull)}`
    )
  }
  if (canonicalStringify(captured.parseDialogScreenOnly) !== canonicalStringify(ev.parseDialogScreenOnly)) {
    diffs.push(
      `parseDialogScreenOnly 不一致: expected=${JSON.stringify(ev.parseDialogScreenOnly)} actual=${JSON.stringify(
        captured.parseDialogScreenOnly
      )}`
    )
  }
  if (!runsEqual(captured.runs, fixture.expected_cells.runs)) {
    diffs.push(
      `target row runs 不一致:\n    expected=${JSON.stringify(fixture.expected_cells.runs)}\n    actual  =${JSON.stringify(
        captured.runs
      )}`
    )
  }

  return { ok: diffs.length === 0, diffs, actual: captured }
}

/**
 * fixture ファイルを読み込んで検証する(CLI とテストの共通入口)。
 * @param {string} fixturePath
 */
async function verifyFixtureFile(fixturePath) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  const result = await verifyFixture(fixture)
  return { file: fixturePath, id: fixture.id, ...result }
}

async function main() {
  const targets = process.argv.slice(2)
  if (targets.length === 0) {
    process.stderr.write('使い方: node tools/verify-fixture.js <fixture.json|dir> [...]\n')
    process.exit(1)
  }
  const files = []
  for (const t of targets) {
    const st = fs.statSync(t)
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(t).filter((f) => f.endsWith('.json')).sort()) files.push(path.join(t, f))
    } else {
      files.push(t)
    }
  }
  if (files.length === 0) {
    process.stderr.write('[verify-fixture] 検査対象が 0 件(ディレクトリに .json が無い)\n')
    process.exit(1)
  }

  let failCount = 0
  for (const f of files) {
    const r = await verifyFixtureFile(f)
    if (r.ok) {
      process.stdout.write(`✅ PASS  ${r.id}  (${f})\n`)
    } else {
      failCount++
      process.stdout.write(`❌ FAIL  ${r.id}  (${f})\n`)
      for (const d of r.diffs) process.stdout.write(`    - ${d}\n`)
    }
  }
  process.stdout.write(`\n${files.length - failCount}/${files.length} PASS\n`)
  process.exit(failCount ? 2 : 0)
}

module.exports = { verifyFixture, verifyFixtureFile }

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[verify-fixture] 予期しないエラー: ${e.stack || e.message}\n`)
    process.exit(1)
  })
}
