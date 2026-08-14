/**
 * tools/lib-cellattrs.js — 実機録画の生ログ(PTY raw stream)を xterm/headless の
 * Terminal に再生し、セル属性(色 / 太字 / 減光 / 反転 等)を観測するための共有ライブラリ。
 *
 * 観測専用ツール(tools/dump-attrs.js)から使う。production コード(claude-wrapper.js /
 * approval-server.js / approval-ui.html)は変更しない。承認枠の同定(frameOf)は
 * production の export(RULE_CHARS / CURSOR_CHARS)からそのまま組み立てる(手写ししない)。
 * 実装は inspect-approval-record.js の該当箇所(承認枠の同定ロジック)を移植したもの。
 *
 * 個人環境のパスはここに埋め込まない(呼び出し側が claude-wrapper.js の export を渡す)。
 */
'use strict'

const DEFAULT_CHUNK = 512

/**
 * 生ログ文字列を CHUNK 単位で Terminal へ逐次 write して再生する。
 *
 * 最終画面を一括 write すると「その瞬間の画面」しか見えず、フレームごとの検出を
 * 再現できない(production wrapper の実挙動は毎フレーム判定のため)。1 チャンク書き込むごとに
 * onFrame(frameIndex) を await して呼び、呼び出し側がそのフレームの画面を観測できるようにする。
 *
 * @param {import('@xterm/headless').Terminal} term
 * @param {string} data 生ログ全体
 * @param {{chunk?: number, onFrame?: (frameIndex: number) => (void|Promise<void>)}} opts
 * @returns {Promise<number>} 総フレーム数
 */
async function replayFrames(term, data, opts = {}) {
  const chunk = Number.isInteger(opts.chunk) && opts.chunk > 0 ? opts.chunk : DEFAULT_CHUNK
  const onFrame = opts.onFrame
  let frames = 0
  for (let i = 0; i < data.length; i += chunk) {
    const slice = data.slice(i, i + chunk)
    await new Promise((resolve) => term.write(slice, resolve))
    frames++
    if (onFrame) await onFrame(frames)
  }
  return frames
}

/**
 * 1 セル分の属性を読む。取得できない prop は null に倒す(バージョン差の吸収)。
 */
function readCellAttrs(cell) {
  return {
    fg: typeof cell.getFgColor === 'function' ? cell.getFgColor() : null,
    fgMode:
      cell.isFgDefault && cell.isFgDefault()
        ? 'default'
        : cell.isFgPalette && cell.isFgPalette()
          ? 'palette'
          : 'rgb',
    bg: typeof cell.getBgColor === 'function' ? cell.getBgColor() : null,
    bgMode:
      cell.isBgDefault && cell.isBgDefault()
        ? 'default'
        : cell.isBgPalette && cell.isBgPalette()
          ? 'palette'
          : 'rgb',
    bold: cell.isBold ? !!cell.isBold() : null,
    dim: cell.isDim ? !!cell.isDim() : null,
    inverse: cell.isInverse ? !!cell.isInverse() : null,
    underline: cell.isUnderline ? !!cell.isUnderline() : null,
    italic: cell.isItalic ? !!cell.isItalic() : null,
  }
}

function attrKey(a) {
  return `fg=${a.fgMode}:${a.fg}|bg=${a.bgMode}:${a.bg}|bold=${+a.bold}|dim=${+a.dim}|inverse=${+a.inverse}|underline=${+a.underline}|italic=${+a.italic}`
}

/**
 * 指定行 y のセル属性をランレングス圧縮して返す。
 *
 * 1 セルずつ出すと cols 分(最大 120 行程度)になって読めないため、同一属性が連続する
 * 区間をまとめる。空白セル(ch === '' または ' ')は属性の帰属が曖昧なので除外する。
 *
 * @returns {Array<{xStart:number, xEnd:number, text:string, attrs:object, key:string}>}
 */
function dumpRowAttrs(buffer, y) {
  const line = buffer.getLine(y)
  if (!line) return []
  const cells = []
  for (let x = 0; x < line.length; x++) {
    let c = null
    try {
      c = line.getCell(x)
    } catch (_) {}
    if (!c) continue
    const ch = c.getChars()
    if (ch === '' || ch === ' ') continue // 余白は属性の帰属が曖昧なので落とす
    cells.push({ x, ch, attrs: readCellAttrs(c) })
  }
  const runs = []
  let runStart = 0
  for (let i = 1; i <= cells.length; i++) {
    if (i < cells.length && attrKey(cells[i].attrs) === attrKey(cells[runStart].attrs)) continue
    const run = cells.slice(runStart, i)
    runs.push({
      xStart: run[0].x,
      xEnd: run[run.length - 1].x,
      text: run.map((c) => c.ch).join(''),
      attrs: run[0].attrs,
      key: attrKey(run[0].attrs),
    })
    runStart = i
  }
  return runs
}

/** dumpRowAttrs() の 1 run を 1 行のテキストへ整形する。 */
function formatRun(run) {
  return `x=${String(run.xStart).padStart(3)}..${String(run.xEnd).padStart(3)}  ${run.key}  "${run.text}"`
}

/**
 * 承認枠の同定関数を組み立てる。inspect-approval-record.js L55-L60 / L122-L130 の実装を
 * そのまま移植したもの(手写ししない = RULE_CHARS / CURSOR_CHARS は claudeWrapperExports から取る)。
 *
 * 終端マーカー・prompt 文言・tool 行は検出条件に入れない(いずれも「測りたい対象」または
 * 「出る回と出ない回がある可変な表示」で、条件にすると枠を丸ごと取りこぼす)。
 *
 * @param {object} claudeWrapperExports claude-wrapper.js の module.exports
 * @returns {(screenText: string) => ({iRule:number, iOpt:number, ruleLine:string, optLine:string}|null)}
 */
function makeFrameOf(claudeWrapperExports) {
  const { RULE_CHARS, CURSOR_CHARS } = claudeWrapperExports
  const RULE_RE = new RegExp(`^[${RULE_CHARS}\\s]{6,}$`)
  const OPTION_RE = new RegExp(`^\\s*[${CURSOR_CHARS}>]?\\s*1\\.\\s+\\S`)
  return function frameOf(s) {
    const L = s.split('\n')
    let iOpt = -1
    for (let i = L.length - 1; i >= 0 && iOpt === -1; i--) if (OPTION_RE.test(L[i])) iOpt = i
    if (iOpt === -1) return null
    let iRule = -1
    for (let i = iOpt - 1; i >= 0 && iRule === -1; i--) if (RULE_RE.test(L[i])) iRule = i
    return iRule === -1 ? null : { iRule, iOpt, ruleLine: L[iRule], optLine: L[iOpt] }
  }
}

module.exports = {
  DEFAULT_CHUNK,
  replayFrames,
  dumpRowAttrs,
  formatRun,
  makeFrameOf,
}
