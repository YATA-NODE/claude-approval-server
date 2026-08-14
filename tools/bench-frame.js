#!/usr/bin/env node
/**
 * tools/bench-frame.js — 1 フレームあたりの dialog 判定コストを実測する性能ベンチ。
 *
 * 「dialog 判定」= production がフレームごとに行う 3 関数の 1 サイクル:
 *   frameOf(viewportText)(lib-cellattrs.makeFrameOf、production の RULE_CHARS/CURSOR_CHARS
 *   から組み立てた構造判定)+ readTabBarRow(buf, rows)(production export)+
 *   __test.barRowIsCliDrawn()(production ゲートそのもの、__test seam 経由)。
 * 3 つとも production の実体をそのまま呼ぶ(手写ししない = 他ツールと同じ方針)。
 *
 * 測定方法: 固定録画 1 本を warm-up 1 回(計測しない)
 * したあと、3 反復(各反復 = 録画全体を再生し、フレームごとの判定コストを平均した値)を計測し、
 * その 3 値の中央値を報告する。process.hrtime.bigint() で判定サイクルのみを計測する
 * (@xterm/headless への write 自体は含めない = 「判定」のコストを測る)。
 *
 * 使い方: node tools/bench-frame.js [--raw <rawlog>] [--cols 120] [--rows 40] [--chunk 512]
 *           [--warmup 1] [--reps 3] [--limit-ms 50] [--out docs/attr-perf.md]
 */
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')
const { Terminal } = require('@xterm/headless')

const claudeWrapper = require(path.join(__dirname, '..', 'claude-wrapper.js'))
const { replayFrames, makeFrameOf, DEFAULT_CHUNK } = require('./lib-cellattrs.js')

const say = (...a) => process.stdout.write(a.join(' ') + '\n')
const warn = (...a) => process.stderr.write(a.join(' ') + '\n')

function parseArgs(argv) {
  const out = {
    raw: path.join(__dirname, '..', 'e2e-raw-t4-tabbed.log'),
    cols: 120,
    rows: 40,
    chunk: DEFAULT_CHUNK,
    warmup: 1,
    reps: 3,
    limitMs: 50,
    out: path.join(__dirname, '..', 'docs', 'attr-perf.md'),
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--raw') out.raw = argv[++i]
    else if (a === '--cols') out.cols = Number(argv[++i])
    else if (a === '--rows') out.rows = Number(argv[++i])
    else if (a === '--chunk') out.chunk = Number(argv[++i])
    else if (a === '--warmup') out.warmup = Number(argv[++i])
    else if (a === '--reps') out.reps = Number(argv[++i])
    else if (a === '--limit-ms') out.limitMs = Number(argv[++i])
    else if (a === '--out') out.out = argv[++i]
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const RAW_PATH = path.resolve(args.raw)
if (!fs.existsSync(RAW_PATH)) {
  warn(`[bench-frame] ログが見つからない: ${RAW_PATH}`)
  process.exit(1)
}
if (![args.cols, args.rows, args.chunk, args.reps].every((n) => Number.isInteger(n) && n > 0) || args.warmup < 0) {
  warn('[bench-frame] --cols/--rows/--chunk/--reps は正の整数、--warmup は 0 以上の整数')
  process.exit(1)
}

/**
 * 録画 1 本を 1 回再生し、フレームごとの「dialog 判定」コスト(ns)を測って
 * {frameCount, totalNs, perFrameMs} を返す。@xterm/headless への write コスト
 * (replayFrames 内)は含めない = onFrame コールバック内だけを計測する。
 */
async function runOnce(data, { cols, rows, chunk }) {
  const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
  claudeWrapper.__test.setHeadlessTerm(term)
  const frameOf = makeFrameOf(claudeWrapper)

  let frameCount = 0
  let totalNs = 0n

  function onFrame() {
    const buf = term.buffer.active
    const t0 = process.hrtime.bigint()
    const viewportText = claudeWrapper.__test.getViewportText()
    frameOf(viewportText)
    try {
      claudeWrapper.readTabBarRow(buf, rows)
    } catch (_) {}
    claudeWrapper.__test.barRowIsCliDrawn()
    const t1 = process.hrtime.bigint()
    totalNs += t1 - t0
    frameCount++
  }

  const total = await replayFrames(term, data, { chunk, onFrame })
  term.dispose()
  if (total !== frameCount) {
    throw new Error(`frameCount 不一致(内部バグ): replayFrames=${total} onFrame 呼出=${frameCount}`)
  }
  return { frameCount, totalNs, perFrameMs: Number(totalNs) / frameCount / 1e6 }
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

;(async () => {
  const rawBuf = fs.readFileSync(RAW_PATH)
  const rawSha256 = crypto.createHash('sha256').update(rawBuf).digest('hex')
  const data = rawBuf.toString('utf8')
  const geo = { cols: args.cols, rows: args.rows, chunk: args.chunk }

  say(`[bench-frame] 対象: ${path.basename(RAW_PATH)} (sha256=${rawSha256})  cols=${args.cols} rows=${args.rows} chunk=${args.chunk}`)
  say(`[bench-frame] warm-up ${args.warmup} 回(計測なし)→ ${args.reps} 反復(計測)`)

  for (let i = 0; i < args.warmup; i++) {
    await runOnce(data, geo)
  }

  const reps = []
  let frameCountRef = null
  for (let i = 0; i < args.reps; i++) {
    const r = await runOnce(data, geo)
    if (frameCountRef === null) frameCountRef = r.frameCount
    else if (r.frameCount !== frameCountRef) {
      warn(`[bench-frame] 諦め: 反復間でフレーム数が一致しない(反復1=${frameCountRef} 反復${i + 1}=${r.frameCount})。決定論的再生の前提が崩れている。`)
      process.exit(1)
    }
    reps.push(r)
    say(`  反復 ${i + 1}/${args.reps}: フレーム数=${r.frameCount}  1フレーム平均=${r.perFrameMs.toFixed(4)}ms`)
  }

  // suite 完走の確認(全反復が実行され、各反復が 1 フレーム以上を計測したこと)を
  // ツール自身が assert する(黙って 0 件のまま緑にしない)。
  if (reps.length !== args.reps || reps.some((r) => r.frameCount === 0)) {
    warn('[bench-frame] 諦め: suite が完走しなかった(反復数不足 or 0 フレーム計測)。')
    process.exit(1)
  }

  const values = reps.map((r) => r.perFrameMs)
  const med = median(values)
  const commitFull = execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..') }).toString().trim()
  const commit = commitFull.slice(0, 7)
  const nodeVersion = process.version

  say(`[bench-frame] suite 完走: ${reps.length}/${args.reps} 反復、各 ${frameCountRef} フレーム`)
  say(`[bench-frame] 中央値: ${med.toFixed(4)}ms/frame  (生値: ${values.map((v) => v.toFixed(4)).join(', ')})`)

  const belowInitial = med <= args.limitMs
  const now = new Date().toISOString()
  const md = `# 性能基準(案C Phase 0、暫定確定)

**位置づけ**: production は本 Phase で未変更(HEAD = ${commit})。ここで測るのは
「1 フレームあたりの dialog 判定(frameOf + readTabBarRow + barRowIsCliDrawn の 1 サイクル)」の
**現行の絶対時間**であり、Phase 2 で案C を実装したあと同一条件で再測して比較する基準値にする
(master plan: 「Phase 2 は同一基準の再検証に限定〔基準の後決めをしない〕」)。

## 測定コマンド

\`\`\`
node tools/bench-frame.js --raw ${path.basename(RAW_PATH)} --cols ${args.cols} --rows ${args.rows} --chunk ${args.chunk} --warmup ${args.warmup} --reps ${args.reps}
\`\`\`

## 対象録画

| 項目 | 値 |
|---|---|
| ファイル | \`${path.basename(RAW_PATH)}\`(gitignore・ローカルのみ。docs/attr-manifest.json に同一 sha256 のエントリあり) |
| sha256 | \`${rawSha256}\` |
| 幾何 | cols=${args.cols} rows=${args.rows} chunk=${args.chunk} |
| フレーム数(この幾何での再生) | ${frameCountRef} |

## 基準 commit

| 項目 | 値 |
|---|---|
| commit(短縮) | \`${commit}\` |
| commit(完全) | \`${commitFull}\` |
| node | \`${nodeVersion}\` |
| 測定日時 | ${now} |
| production 変更 | なし(Phase 0 は観測専用。この値が「現行 HEAD の絶対時間」の基準) |

## warm-up 条件

- warm-up ${args.warmup} 回(計測に含めない、JIT ウォームアップ目的)→ 本計測 ${args.reps} 反復。
- 各反復は録画全体を @xterm/headless に再生し、フレームごとに dialog 判定 3 関数を呼んで
  \`process.hrtime.bigint()\` で判定サイクルのみを計測(端末への write コストは含めない)。
  反復内の全フレームの合計時間 ÷ フレーム数 = その反復の「1 フレーム平均」。

## 3 反復の生値 + 中央値

| 反復 | 1 フレーム平均(ms) |
|---|---|
${values.map((v, i) => `| ${i + 1} | ${v.toFixed(4)} |`).join('\n')}
| **中央値** | **${med.toFixed(4)}** |

## 絶対上限の暫定値

- master plan 初期値: **1 フレーム ≤ ${args.limitMs}ms**。
- 実測中央値 ${med.toFixed(4)}ms は初期値を${belowInitial ? '**下回った**' : '上回った'}。
${
  belowInitial
    ? `- 実測が下回ったため、暫定上限は master plan 初期値の **${args.limitMs}ms を維持**しつつ、
  実測値ベースの上限提案(安全マージン込み)を併記する: **${(med * 4).toFixed(2)}ms**(中央値の 4 倍、
  master plan の「HEAD 比 2 倍以内」要求とは別軸 = Phase 2 実装後の絶対時間比較用の参考値)。
  最終的な絶対上限の確定は Phase 1 の設計判断に委ねる(ここでは実測と提案値の併記に留める)。`
    : `- **要対応**: 実測中央値が初期値 ${args.limitMs}ms を上回った。この録画・この環境では
  初期値をそのまま絶対上限として採用できない。Phase 1 で上限の再設定 or 対象録画・環境の
  見直しを検討すること(この bench の結果を根拠に判断する)。`
}

## suite 完走の確認

- ${reps.length}/${args.reps} 反復が完走し、各反復で ${frameCountRef} フレームが計測された(反復間で一致)。
- 0 フレーム計測 or 反復数不足の場合、本ツールはこの節を書かずに exit 1 する(このファイルが
  存在すること自体が「suite が完走した」ことの証跡)。
`

  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true })
  fs.writeFileSync(path.resolve(args.out), md)
  say(`[bench-frame] 書き出し完了: ${path.relative(process.cwd(), path.resolve(args.out))}`)
})().catch((e) => {
  warn(`[bench-frame] 予期しないエラー: ${e.stack || e.message}`)
  process.exit(1)
})
