#!/usr/bin/env node
/**
 * tools/dump-attrs.js — 実機録画の生ログ(PTY raw stream)を再生し、承認枠 / タブバー行など
 * 主要な行のセル属性をランレングス圧縮してダンプする**観測専用**ツール。
 *
 * 目的: 「承認枠の同定根拠を、モデルが書けるテキストから CLI しか描けないセル属性へ
 * 移せるか」を判断するための事実収集。ここでは属性を観測するだけで、採否は判定しない。
 *
 * production コード(claude-wrapper.js 等)は一切変更しない。承認枠の同定(frameOf)と
 * タブバー行の同定(readTabBarRow)・CLI 描画ゲート(barRowHasStyledCells)は production の
 * export をそのまま呼ぶ(手写ししない)。countStyledCells / isHighlightedCell は
 * production では export されていないため、同等の生観測(背景色が既定でないセル数 /
 * inverse セル数)をここで数える。**これは観測であってゲートではない**
 * (production 側の判定値は __test.barRowHasStyledCells() を別途併記して比較できるようにする)。
 *
 * 選択肢行の走査は、承認枠の外の chrome である Claude Code statusline(モデル名 +
 * rate limit 使用率 + リセット時刻)/ タイトルバー(リポ名 + ブランチ名 + effort +
 * スラッシュコマンド)が空行なく直下・同一行に描画された個体を、lib-redact.js の
 * isChromeText で構造的に除外する(混合行〔選択肢+chrome〕は選択肢行として残し、
 * trailing の chrome 部分だけを伏せる。statusline は出力時に redact() が、タイトルバーは
 * run 境界を使った本ファイルの maskTitlebarRunsInText() が伏せる)。
 *
 * 使い方: node tools/dump-attrs.js <rawlog> [--cols 120] [--rows 40] [--chunk 512]
 *
 * 出力は stdout への markdown 相当のテキスト(実行条件 + ダンプ本体)。
 * 「観測メモ」(見えた事実の要約)は本ツールの出力を読んだ人間 / エージェントが
 * 別途 docs/ に書き足す(採否の結論・一般化は本ツールの責務外)。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Terminal } = require('@xterm/headless')

const claudeWrapper = require(path.join(__dirname, '..', 'claude-wrapper.js'))
const { screenTextFromBuffer, readTabBarRow, findLastToolLine, CURSOR_CHARS } = claudeWrapper
const { replayFrames, dumpRowAttrs, formatRun, makeFrameOf, DEFAULT_CHUNK } = require('./lib-cellattrs.js')

// ---- 出力の redaction(公開リポへ個人環境情報を出さないための唯一の出口)----
// 実装は tools/lib-redact.js(record-frames.js と共有 = 同じ問題を 2 箇所で解かない)。
// **書き出しは必ず say / warn を通す**(console.log を直接呼ばない。出口が 1 つでないと、
// 後から足した出力箇所が素通りする)。run 境界を使った精密なマスク(maskTitlebarRunsInText /
// filterPrintableRuns)も lib-redact.js 側に置く(判定条件・マスク処理を1箇所にまとめ、
// test-lib-redact.js から直接ユニットテストできるようにするため)。
const { redact, isChromeText, maskTitlebarRunsInText, filterPrintableRuns } = require('./lib-redact.js')
const say = (...a) => process.stdout.write(redact(a.join(' ')) + '\n')
const warn = (...a) => process.stderr.write(redact(a.join(' ')) + '\n')

/**
 * run 群を、redact 済み text 行と整合しない run を除いて出力する(第2段)。
 * フィルタ本体は lib-redact.js の filterPrintableRuns(選択肢の実体 run は残り、chrome 由来の
 * run は落ちる)。
 */
function printRuns(text, runs, indent) {
  const redactedText = redact(text)
  for (const run of filterPrintableRuns(redactedText, runs)) {
    say(`${indent}${formatRun(run)}`)
  }
}

// ---- 引数 ----
function parseArgs(argv) {
  const out = { raw: null, cols: 120, rows: 40, chunk: DEFAULT_CHUNK }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--cols') out.cols = Number(argv[++i])
    else if (a === '--rows') out.rows = Number(argv[++i])
    else if (a === '--chunk') out.chunk = Number(argv[++i])
    else rest.push(a)
  }
  out.raw = rest[0]
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.raw) {
  warn('使い方: node tools/dump-attrs.js <rawlog> [--cols 120] [--rows 40] [--chunk 512]')
  process.exit(1)
}
if (![args.cols, args.rows, args.chunk].every((n) => Number.isInteger(n) && n > 0)) {
  warn('[dump-attrs] --cols/--rows/--chunk は正の整数で指定すること')
  process.exit(1)
}

const RAW_PATH = path.resolve(args.raw)
if (!fs.existsSync(RAW_PATH)) {
  warn(`[dump-attrs] ログが見つからない: ${RAW_PATH}`)
  process.exit(1)
}
const rawBuf = fs.readFileSync(RAW_PATH)
const rawSha256 = crypto.createHash('sha256').update(rawBuf).digest('hex')
const data = rawBuf.toString('utf8')

const frameOf = makeFrameOf(claudeWrapper)
const CURSOR_LEAD_RE = new RegExp(`^\\s*[${CURSOR_CHARS}>]`)
const BULLET_RE = /^●/ // x=0 の ● のみ(生成規約と同じ、行頭に空白を許さない)
// 選択肢行の「行頭が選択肢マーカーで始まる」判定。CURSOR_LEAD_RE(カーソル文字 / '>')に、
// カーソル無しの番号行 "2. No" 等も拾えるよう digit+dot の代替を足したもの。CURSOR_LEAD_RE
// の source から合成することで CURSOR_CHARS の drift 元を1本化する(新 CLI のカーソルを
// CURSOR_CHARS に足せば CURSOR_LEAD_RE 経由で本 RegExp も自動追従する)。statusline 走査の
// 終端判定で、混合行(選択肢+statusline が同一行に描画された個体)を誤って終端しないために使う。
const OPTION_START_RE = new RegExp(`${CURSOR_LEAD_RE.source}|^\\s*\\d+\\.`)

function firstNonBlankAfter(lines, start, limit) {
  const end = Math.min(limit, lines.length)
  for (let i = start; i < end; i++) if (lines[i] !== undefined && lines[i].trim() !== '') return i
  return -1
}
/**
 * 空行、または「純 chrome 行」(選択肢の行頭パターン=OPTION_START_RE を伴わずに
 * lib-redact.js の isChromeText〔statusline / タイトルバー〕に一致する行)で終端した
 * 行インデックスを返す。
 *
 * 混合行(例: " ❯ 1. Yes5 📒: 9% 5h: 5% ↻ 22:40 …" や "2. 赤<repo>/<branch> ◉ xhigh · /effort")
 * は OPTION_START_RE に一致するため終端せず選択肢行として残る(trailing の chrome 部分は
 * statusline なら redact()、タイトルバーなら maskTitlebarRunsInText() が伏せる)。
 * 純 chrome 行(例: "  gpt-5.6-sol 📒: …" や "  ⏸ manual mode on")だけを、
 * 選択肢行走査の対象から構造的に除外する。
 */
function firstBlankOrStatuslineFrom(lines, start) {
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined || line.trim() === '') return i
    if (isChromeText(line) && !OPTION_START_RE.test(line)) return i
  }
  return lines.length
}

const term = new Terminal({ cols: args.cols, rows: args.rows, scrollback: 1000, allowProposedApi: true })
// barRowHasStyledCells() は headlessTerm(module 内 closure 変数)を読むため、seam 経由で張る。
claudeWrapper.__test.setHeadlessTerm(term)

let framesWithFrameCount = 0
let framesWithBarCount = 0
let barCliDrawnTrueCount = 0
const frameRecords = []
const barRecords = []

function dumpLine(buf, y, text) {
  const runs = dumpRowAttrs(buf, y)
  return { y, text: maskTitlebarRunsInText(text, runs), runs }
}

async function onFrame(frameIdx) {
  const buf = term.buffer.active
  const text = screenTextFromBuffer(buf, term.rows, 0) // 表示領域のみ(scrollback 0)
  const lines = text.split('\n')

  // ---- 6. タブバー行(承認枠の有無と無関係に、全フレームで独立に走査) ----
  let barRow = null
  try {
    barRow = readTabBarRow(buf, term.rows)
  } catch (_) {}
  let cliDrawn = false
  try {
    cliDrawn = claudeWrapper.__test.barRowHasStyledCells()
  } catch (_) {}
  if (cliDrawn) barCliDrawnTrueCount++
  if (barRow && typeof barRow.y === 'number') {
    framesWithBarCount++
    // countStyledCells / isHighlightedCell は export されていないため同等の生観測を数える。
    // **これは観測でありゲートではない**(production ゲート値は cliDrawn として別途持つ)。
    const line = buf.getLine(barRow.y)
    let observedBgStyled = 0
    let observedInverse = 0
    if (line) {
      for (let x = 0; x < line.length; x++) {
        let c = null
        try {
          c = line.getCell(x)
        } catch (_) {}
        if (!c) continue
        if (typeof c.isBgDefault === 'function' && !c.isBgDefault()) observedBgStyled++
        if (typeof c.isInverse === 'function' && c.isInverse()) observedInverse++
      }
    }
    const barRuns = dumpRowAttrs(buf, barRow.y)
    barRecords.push({
      frame: frameIdx,
      y: barRow.y,
      text: maskTitlebarRunsInText(barRow.text, barRuns),
      gateBarRowHasStyledCells: cliDrawn,
      observedBgStyled,
      observedInverse,
      runs: barRuns,
    })
  }

  // ---- 承認枠(production の frameOf 移植版で同定) ----
  const f = frameOf(text)
  if (!f) return
  framesWithFrameCount++

  const rec = { frame: frameIdx, iRule: f.iRule, iOpt: f.iOpt }

  // 1. 罫線行
  rec.rule = dumpLine(buf, f.iRule, lines[f.iRule])

  // 2. 罫線の直下のラベル行
  const labelIdx = f.iRule + 1
  rec.label = labelIdx < f.iOpt && lines[labelIdx] !== undefined ? dumpLine(buf, labelIdx, lines[labelIdx]) : null

  // 4. 枠内のコマンド行 vs 説明行(ラベル行の下、空行をスキップして最初の非空行→次の非空行)
  const cmdIdx = firstNonBlankAfter(lines, labelIdx + 1, f.iOpt)
  rec.command = cmdIdx === -1 ? null : dumpLine(buf, cmdIdx, lines[cmdIdx])
  const descIdx = cmdIdx === -1 ? -1 : firstNonBlankAfter(lines, cmdIdx + 1, f.iOpt)
  rec.description = descIdx === -1 ? null : dumpLine(buf, descIdx, lines[descIdx])

  // 3. 選択肢行(iOpt から最初の空行 or 純 statusline 行まで。❯ が付く行/付かない行の
  //    両方を含める。混合行〔選択肢+statusline〕は含めるが、純 statusline 行は含めない)
  const optEnd = firstBlankOrStatuslineFrom(lines, f.iOpt)
  rec.options = []
  for (let y = f.iOpt; y < optEnd; y++) {
    rec.options.push({ ...dumpLine(buf, y, lines[y]), hasCursorMark: CURSOR_LEAD_RE.test(lines[y] || '') })
  }

  // 5. tool 行(findLastToolLine = production)+ ● bullet 行(全走査、枠内外を明記)
  let toolLine = null
  try {
    toolLine = findLastToolLine(text)
  } catch (_) {}
  let toolLineNo = -1
  if (toolLine) {
    toolLineNo = text.slice(0, toolLine.index).split('\n').length - 1
    rec.toolLine = {
      ...dumpLine(buf, toolLineNo, lines[toolLineNo]),
      tool: toolLine.tool,
      args: toolLine.args,
      readable: toolLine.readable,
    }
  } else {
    rec.toolLine = null
  }
  rec.bullets = []
  for (let y = 0; y < lines.length; y++) {
    if (!BULLET_RE.test(lines[y] || '')) continue
    rec.bullets.push({
      ...dumpLine(buf, y, lines[y]),
      insideFrame: y >= f.iRule && y < optEnd,
      isFindLastToolLineMatch: y === toolLineNo,
    })
  }

  frameRecords.push(rec)
}

// ---- 出力 ----
function printLineSection(title, sec) {
  say(`### ${title}`)
  if (!sec) {
    say('- 観測されず(該当行が見つからなかった)')
    say('')
    return
  }
  say(`- y=${sec.y}  text=${JSON.stringify(sec.text)}`)
  if (sec.runs.length === 0) {
    say('  (非空セルなし)')
  } else {
    printRuns(sec.text, sec.runs, '  ')
  }
  say('')
}

;(async () => {
  const cmd = `node tools/dump-attrs.js ${path.basename(RAW_PATH)} --cols ${args.cols} --rows ${args.rows} --chunk ${args.chunk}`
  const totalFrames = await replayFrames(term, data, { chunk: args.chunk, onFrame })

  say('# 実行条件')
  say('')
  say(`- コマンド: \`${cmd}\``)
  say(`- cols=${args.cols} rows=${args.rows} chunk=${args.chunk}`)
  say(`- 対象ログ: ${path.basename(RAW_PATH)}`)
  say(`- 対象ログ sha256: ${rawSha256}`)
  say(`- 総フレーム数: ${totalFrames}`)
  say(`- 承認枠(frameOf)検出回数: ${framesWithFrameCount}`)
  say(`- タブバー行(readTabBarRow)検出回数: ${framesWithBarCount}`)
  say(`- production ゲート barRowHasStyledCells()=true だったフレーム数: ${barCliDrawnTrueCount}`)
  say('')

  if (framesWithFrameCount === 0) {
    say(
      `[警告] 承認枠が 1 度も見つからなかった。幾何(cols=${args.cols} rows=${args.rows})が` +
        ` 録画時と違うか、chunk=${args.chunk} が粗すぎる可能性がある。「このログに枠が無い」と断定しないこと。`
    )
    say('')
  }
  if (framesWithBarCount === 0) {
    say(
      `[警告] タブバー行が 1 度も見つからなかった。幾何(cols=${args.cols} rows=${args.rows})が` +
        ` 録画時と違うか、chunk=${args.chunk} が粗すぎる可能性がある。「このログにタブバーが無い」と断定しないこと。`
    )
    say('')
  }

  say('# ダンプ本体')
  say('')
  say(
    '全フレームではなく、承認枠(frameOf)が検出できたフレームのみを対象にダンプする' +
      '(絞り方: `frameOf(screenText) !== null` のフレームだけを残す)。'
  )
  say('')

  for (const rec of frameRecords) {
    say(`## frame #${rec.frame} (iRule=${rec.iRule}, iOpt=${rec.iOpt})`)
    say('')
    printLineSection('1. 罫線行', rec.rule)
    printLineSection('2. 罫線の直下のラベル行', rec.label)
    printLineSection('4a. 枠内のコマンド行', rec.command)
    printLineSection('4b. 枠内の説明行', rec.description)

    say('### 3. 選択肢行(iOpt から最初の空行まで)')
    if (rec.options.length === 0) {
      say('- 観測されず')
    } else {
      for (const opt of rec.options) {
        say(`- y=${opt.y}  cursor=${opt.hasCursorMark}  text=${JSON.stringify(opt.text)}`)
        if (opt.runs.length === 0) say('    (非空セルなし)')
        printRuns(opt.text, opt.runs, '    ')
      }
    }
    say('')

    say('### 5a. tool 行(findLastToolLine、production の export をそのまま使用)')
    if (!rec.toolLine) {
      say('- 観測されず(findLastToolLine が null を返した。このフレームの tool 行形式は本関数のパターンに一致しない)')
    } else {
      say(
        `- y=${rec.toolLine.y}  tool=${rec.toolLine.tool}  readable=${rec.toolLine.readable}` +
          `  args=${JSON.stringify(rec.toolLine.args)}`
      )
      printRuns(rec.toolLine.text, rec.toolLine.runs, '    ')
    }
    say('')

    say('### 5b. ● bullet 行(x=0 一致で全走査。枠内外・findLastToolLine 一致を併記)')
    if (rec.bullets.length === 0) {
      say('- 観測されず')
    } else {
      for (const b of rec.bullets) {
        say(
          `- y=${b.y}  insideFrame=${b.insideFrame}  isFindLastToolLineMatch=${b.isFindLastToolLineMatch}` +
            `  text=${JSON.stringify(b.text)}`
        )
        printRuns(b.text, b.runs, '    ')
      }
    }
    say('')
  }

  say('## タブバー行(readTabBarRow、全フレーム走査)')
  say('')
  if (barRecords.length === 0) {
    say('- 検出されず(0 件)')
  } else {
    for (const b of barRecords) {
      say(`- frame #${b.frame}  y=${b.y}  text=${JSON.stringify(b.text)}`)
      say(
        `  production ゲート barRowHasStyledCells()=${b.gateBarRowHasStyledCells}` +
          `  観測(生カウント、ゲートではない): 背景色が既定でないセル数=${b.observedBgStyled}` +
          `  inverse セル数=${b.observedInverse}`
      )
      printRuns(b.text, b.runs, '    ')
    }
  }
  say('')
})()
