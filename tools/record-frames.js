#!/usr/bin/env node
/**
 * tools/record-frames.js — corpus 品質の実機録画ハーネス。
 *
 * Claude Code の TUI を PTY で起動し、プロンプトを送信して承認枠(または無反応)を
 * 録画する。目的は「承認枠の同定根拠を、モデルが書けるテキストから CLI しか描けない
 * セル属性へ移せるか」を判断するための事実収集であり、判定そのものは行わない
 * (判定・解釈は本ツールの出力を読んだ人間 / 別ツールの責務)。
 *
 * production コード(claude-wrapper.js / approval-server.js / approval-ui.html)は
 * 一切変更しない。承認枠の同定(frameOf)は tools/lib-cellattrs.js の makeFrameOf
 * (production の export からそのまま組み立てられたもの)をそのまま使う(手写ししない)。
 *
 * 既知の失敗パターン(すべて対策済み。詳細は各コメント参照):
 *   A. 固定名の上書き事故 → --target で出力名を分け、既存ファイルは --force 無しで拒否
 *   B. payload 由来の文字列を検出条件に使う事故 → 検出は構造(罫線 + 選択肢行)のみ。
 *      さらに settle-ms 後に再確認し、入力エコーの一瞬の一致を締め出す
 *   C. 近似 ANSI 除去 → @xterm/headless に実再生し screenTextFromBuffer で読む
 *   D. scrollback 込みで判定 → 判定は表示領域のみ(scrollback 0)
 *   E. 承認キーの自動送出 → 本ツールは承認キーを一切送らない(送るのは初回プロンプトのみ)
 *
 * **E の帰結(録画できる範囲の上限)**: キーを送らないので、画面は最初に出た状態で止まる。
 * したがって **タブ式ダイアログの 2 問目以降と、回答を送信した先の確認画面
 * (Review your answers)は本ツールでは録画できない**(常に 1 問目で停止する)。
 * そこへ到達するには回答を注入する別の対話的ハーネスが要る = 承認キー送出の再導入を伴う
 * 設計判断なので、本ツールの範囲外とする。
 *   F. 末尾欠損を成功と報告 → term.onExit を待ち、finished() で書き出し完了を確認してから
 *      META を書く
 *
 * 個人環境のパスはここに埋め込まない。claude バイナリは PATH から解決するか、
 * 環境変数 RECORD_FRAMES_CLAUDE_BIN で上書きできる。
 *
 * 使い方:
 *   node tools/record-frames.js --target <name> --prompt-file <path> [options]
 * オプション一覧は printUsage() を参照。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { finished } = require('stream/promises')
const pty = require('node-pty')
const { Terminal } = require('@xterm/headless')

const claudeWrapper = require(path.join(__dirname, '..', 'claude-wrapper.js'))
const { screenTextFromBuffer, RULE_CHARS, CURSOR_CHARS, BOX_CHARS } = claudeWrapper
const { makeFrameOf } = require('./lib-cellattrs.js')
const { redact, redactLines } = require('./lib-redact.js')

// **出力の唯一の出口**。画面由来テキストだけでなく、例外メッセージ・スタックトレース・
// fs エラーにも home パス(= ユーザー名)が乗る(例: --prompt-file の解決結果は
// process.cwd() 起点の絶対パス)。出口を分けると後から足した出力箇所が素通りするので、
// console.log / console.error を直接呼ばず必ずここを通す(dump-attrs.js と同じ設計)。
const say = (...a) => process.stdout.write(redact(a.join(' ')) + '\n')
const warn = (...a) => process.stderr.write(redact(a.join(' ')) + '\n')

// PTY からの受信を画面へ流し込むときの粒度。**lib-cellattrs の DEFAULT_CHUNK とは別物**。
// あちらは「1 チャンク = 1 フレーム」としてフレーム単位の履歴を観測するための粒度だが、
// こちらは全チャンク処理後にまとめて画面を読むだけで中間観測をしない。
// @xterm/headless の write は 1 回ごとに setTimeout を挟むため、細かくすると
// **チャンク数に比例した実時間の遅延**になる(実測: 3MB を 512B 刻みで流すと約 7.2 秒、
// 16KB 刻みなら約 0.24 秒)。遅延は settle-ms の前提と timeout-ms の予算を食うので粗くする。
const LIVE_DRAIN_CHUNK = 16384

const ROOT_DIR = path.join(__dirname, '..')

class UsageError extends Error {}

function printUsage() {
  warn(
    [
      '使い方: node tools/record-frames.js --target <name> --prompt-file <path> [options]',
      '',
      '必須:',
      '  --target <name>          出力名。[A-Za-z0-9_-]{1,40}(パス区切り不可)',
      '  --prompt-file <path>     プロンプト本文のファイル(argv に長文を載せない)',
      '',
      '任意:',
      '  --cols <n>               既定 120',
      '  --rows <n>                既定 40',
      '  --chunk <n>               既定 ' + LIVE_DRAIN_CHUNK + '(Terminal への write 粒度)',
      '                            検出結果は粒度に依らず同じ。小さくすると実時間の遅延だけが増える',
      '  --model <name>            既定 sonnet',
      '  --permission-mode <mode>  既定 default',
      '  --allowed-tools <spec>    claude に --allowedTools として渡す(任意)',
      '  --stop-on <frame|idle>    既定 frame',
      '  --settle-ms <n>           既定 2000(frame 検出後の追加待機 + 再確認)',
      '  --idle-ms <n>             既定 8000(idle モードの無変化判定)',
      '  --timeout-ms <n>          既定 120000(起動待ち+停止条件待ちの合計に対する期限)',
      '  --max-bytes <n>           既定 8388608(超過で失敗扱い)',
      '  --force                   出力が既存でも上書きする',
      '',
      '制約:',
      '  承認キーを一切送らないので、画面は最初に出た状態で止まる。したがって',
      '  タブ式ダイアログの 2 問目以降と、回答を送信した先の確認画面は録画できない',
      '  (常に 1 問目で停止する)。到達には回答を注入する別ハーネスが要る。',
      '',
      '環境変数:',
      '  RECORD_FRAMES_CLAUDE_BIN  claude バイナリのパス(既定は PATH 解決の "claude")',
      '  SOURCE_DATE_EPOCH         META の取得時刻に使う Unix 秒(無ければ実時刻)',
    ].join('\n')
  )
}

// ---- 引数パース ----
function parseArgs(argv) {
  const out = {
    target: null,
    promptFile: null,
    cols: 120,
    rows: 40,
    chunk: LIVE_DRAIN_CHUNK,
    model: 'sonnet',
    permissionMode: 'default',
    allowedTools: null,
    stopOn: 'frame',
    settleMs: 2000,
    idleMs: 8000,
    timeoutMs: 120000,
    maxBytes: 8 * 1024 * 1024,
    force: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--target':
        out.target = argv[++i]
        break
      case '--prompt-file':
        out.promptFile = argv[++i]
        break
      case '--cols':
        out.cols = Number(argv[++i])
        break
      case '--rows':
        out.rows = Number(argv[++i])
        break
      case '--chunk':
        out.chunk = Number(argv[++i])
        break
      case '--model':
        out.model = argv[++i]
        break
      case '--permission-mode':
        out.permissionMode = argv[++i]
        break
      case '--allowed-tools':
        out.allowedTools = argv[++i]
        break
      case '--stop-on':
        out.stopOn = argv[++i]
        break
      case '--settle-ms':
        out.settleMs = Number(argv[++i])
        break
      case '--idle-ms':
        out.idleMs = Number(argv[++i])
        break
      case '--timeout-ms':
        out.timeoutMs = Number(argv[++i])
        break
      case '--max-bytes':
        out.maxBytes = Number(argv[++i])
        break
      case '--force':
        out.force = true
        break
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
        break
      default:
        throw new UsageError(`未知の引数: ${a}`)
    }
  }
  return out
}

const TARGET_RE = /^[A-Za-z0-9_-]{1,40}$/
const MODEL_RE = /^[A-Za-z0-9._-]{1,40}$/
const PERMISSION_MODE_RE = /^[A-Za-z0-9_-]{1,40}$/

function isPosInt(n) {
  return Number.isInteger(n) && n > 0
}

/** 引数を検証し、正規化済みの設定(絶対パス化した promptFilePath 等)を返す。不正なら UsageError。 */
function validateArgs(args) {
  if (!args.target) throw new UsageError('--target は必須')
  if (!TARGET_RE.test(args.target)) {
    throw new UsageError(`--target が不正: ${JSON.stringify(args.target)}(パターン ${TARGET_RE} に一致すること。パス区切り不可)`)
  }
  if (!args.promptFile) throw new UsageError('--prompt-file は必須')
  const promptFilePath = path.resolve(process.cwd(), args.promptFile)
  if (!fs.existsSync(promptFilePath)) {
    throw new UsageError(`--prompt-file が見つからない: ${promptFilePath}`)
  }
  if (!fs.statSync(promptFilePath).isFile()) {
    throw new UsageError(`--prompt-file が通常ファイルでない: ${promptFilePath}`)
  }
  if (!isPosInt(args.cols) || args.cols < 20 || args.cols > 500) {
    throw new UsageError(`--cols は 20..500 の整数であること: ${args.cols}`)
  }
  if (!isPosInt(args.rows) || args.rows < 10 || args.rows > 200) {
    throw new UsageError(`--rows は 10..200 の整数であること: ${args.rows}`)
  }
  if (!isPosInt(args.chunk)) throw new UsageError(`--chunk は正の整数であること: ${args.chunk}`)
  if (!MODEL_RE.test(args.model)) throw new UsageError(`--model が不正: ${JSON.stringify(args.model)}`)
  if (!PERMISSION_MODE_RE.test(args.permissionMode)) {
    throw new UsageError(`--permission-mode が不正: ${JSON.stringify(args.permissionMode)}`)
  }
  if (args.allowedTools !== null && args.allowedTools.length === 0) {
    throw new UsageError('--allowed-tools は指定する場合、空文字にできない')
  }
  if (args.stopOn !== 'frame' && args.stopOn !== 'idle') {
    throw new UsageError(`--stop-on は frame か idle であること: ${JSON.stringify(args.stopOn)}`)
  }
  if (!Number.isInteger(args.settleMs) || args.settleMs < 0) throw new UsageError(`--settle-ms が不正: ${args.settleMs}`)
  if (!Number.isInteger(args.idleMs) || args.idleMs < 0) throw new UsageError(`--idle-ms が不正: ${args.idleMs}`)
  if (!isPosInt(args.timeoutMs)) throw new UsageError(`--timeout-ms は正の整数であること: ${args.timeoutMs}`)
  if (!isPosInt(args.maxBytes)) throw new UsageError(`--max-bytes は正の整数であること: ${args.maxBytes}`)
  return { ...args, promptFilePath }
}

module.exports.__test = { parseArgs, validateArgs, UsageError, TARGET_RE }

// ---- 補助関数 ----
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** symlink 経由の書き込みを拒否しつつ、既存ファイルを安全に取り除く(TOCTOU を避けて直後に 'wx' で作る前提)。 */
function removeIfPlainFile(p) {
  try {
    const st = fs.lstatSync(p)
    if (!st.isFile()) throw new UsageError(`${p} が通常ファイルでない(symlink 等)。中止する`)
    fs.unlinkSync(p)
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e
  }
}

// 画面テキストから「諦めた時点の画面」を切り出す。**ここが画面由来テキストの唯一の出口**
// (戻り値は META の screenPreview と stderr の両方へ流れる)なので、redaction もここで掛ける。
// 出口を 2 つに分けると片方だけ対策が入る = dump-attrs.js と同じ設計にそろえる。
function previewLines(screenText, n = 10) {
  return redactLines(
    screenText
      .split('\n')
      .filter((l) => l.trim() !== '')
      .slice(0, n)
  )
}

if (require.main === module) {
  main().catch((e) => {
    if (e instanceof UsageError) {
      warn(`[record-frames] ${e.message}`)
      printUsage()
      process.exitCode = 2
      return
    }
    warn(`[record-frames] 予期しないエラー: ${(e && e.stack) || e}`)
    process.exitCode = 1
  })
}

async function main() {
  const rawArgs = parseArgs(process.argv.slice(2))
  const args = validateArgs(rawArgs)
  await runCapture(args)
}

module.exports.runCapture = runCapture
async function runCapture(args) {
  const rawPath = path.join(ROOT_DIR, `e2e-raw-${args.target}.log`)
  const metaPath = path.join(ROOT_DIR, `e2e-meta-${args.target}.json`)

  // 1. 既存出力の保護(実際に確認された上書き事故の対策)。
  const rawExists = fs.existsSync(rawPath)
  const metaExists = fs.existsSync(metaPath)
  if ((rawExists || metaExists) && !args.force) {
    const existing = [rawExists && path.basename(rawPath), metaExists && path.basename(metaPath)].filter(Boolean).join(', ')
    throw new UsageError(`出力先が既に存在する(${existing})。--force を指定しない限り中止する(上書き事故防止)`)
  }

  const promptBody = fs.readFileSync(args.promptFilePath, 'utf8')
  const promptSha256 = crypto.createHash('sha256').update(promptBody, 'utf8').digest('hex')

  removeIfPlainFile(rawPath)
  const rawStream = fs.createWriteStream(rawPath, { flags: 'wx', mode: 0o600 })

  let streamErr = null
  rawStream.on('error', (e) => {
    streamErr = e
  })

  const CLAUDE_BIN = process.env.RECORD_FRAMES_CLAUDE_BIN || 'claude'
  const claudeArgs = ['--model', args.model, '--permission-mode', args.permissionMode]
  if (args.allowedTools) claudeArgs.push('--allowedTools', args.allowedTools)

  const screenTerm = new Terminal({ cols: args.cols, rows: args.rows, scrollback: 200, allowProposedApi: true })
  const frameOf = makeFrameOf(claudeWrapper)

  // TUI 起動判定は「入力欄が描かれたか」を構造で見る。プレースホルダ文言は出る回と
  // 出ない回があるため条件にしない。カーソル文字(❯ 等)+ 罫線 20 文字以上、の 2 条件を
  // production の境界文字定数(CURSOR_CHARS / BOX_CHARS / RULE_CHARS)から組み立てる
  // (手写ししない = 定数が増えても自動追従)。
  const READY_CURSOR_RE = new RegExp(`^[${CURSOR_CHARS}]`, 'm')
  const READY_RULE_RE = new RegExp(`^[\\s${BOX_CHARS}]*[${RULE_CHARS}]{20,}`, 'm')
  const tuiReady = (s) => READY_CURSOR_RE.test(s) && READY_RULE_RE.test(s)

  let bytesReceived = 0
  let overflow = false
  let lastDataAt = Date.now()
  let queue = ''
  let drainPromise = null

  async function drainOnce() {
    while (queue.length > 0) {
      const slice = queue.slice(0, args.chunk)
      queue = queue.slice(args.chunk)
      await new Promise((resolve) => screenTerm.write(slice, resolve))
    }
  }
  function scheduleDrain() {
    if (!drainPromise) {
      drainPromise = drainOnce().finally(() => {
        drainPromise = null
      })
    }
    return drainPromise
  }
  async function currentScreenText() {
    while (queue.length > 0 || drainPromise) await scheduleDrain()
    // 判定は表示領域のみ(scrollback 0)。既に閉じた枠が上に残っているフレームで
    // 判定が成立し、本命が描かれる前に確定する事故(D)を避ける。
    return screenTextFromBuffer(screenTerm.buffer.active, args.rows, 0)
  }

  let done = false
  let exitInfo = null
  let scriptExitCode = 1
  let finalMsg = '未確認'
  let finalStopReason = 'unknown'
  let finalPreview = null

  async function writeMetaAndPrint() {
    const rawExistsFinal = fs.existsSync(rawPath)
    const rawSha256 = rawExistsFinal ? crypto.createHash('sha256').update(fs.readFileSync(rawPath)).digest('hex') : null

    const capturedAt = process.env.SOURCE_DATE_EPOCH
      ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
      : new Date().toISOString()

    const metaObj = {
      target: args.target,
      cols: args.cols,
      rows: args.rows,
      chunk: args.chunk,
      model: args.model,
      permissionMode: args.permissionMode,
      allowedTools: args.allowedTools,
      stopOn: args.stopOn,
      settleMs: args.settleMs,
      idleMs: args.idleMs,
      timeoutMs: args.timeoutMs,
      maxBytes: args.maxBytes,
      // プロンプト本文そのものは入れない(個人情報混入判断は運用側)。
      // ファイルパス + sha256 + バイト数で再現性は担保する。
      promptFile: path.relative(ROOT_DIR, args.promptFilePath),
      promptSha256,
      promptBytes: Buffer.byteLength(promptBody, 'utf8'),
      bytesReceived,
      scriptExitCode,
      ptyExitCode: exitInfo ? exitInfo.exitCode : null,
      ptySignal: exitInfo ? exitInfo.signal : null,
      stopReason: finalStopReason,
      msg: finalMsg,
      rawSha256,
      capturedAt,
      screenPreview: finalPreview,
    }

    try {
      removeIfPlainFile(metaPath)
      fs.writeFileSync(metaPath, JSON.stringify(metaObj, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    } catch (e) {
      warn(`[record-frames][${args.target}] META の書き込みに失敗: ${e.message}`)
      scriptExitCode = 1
    }

    say(`[record-frames][${args.target}] ${finalMsg}`)
    say(
      `[record-frames] RAW=${path.basename(rawPath)} (${bytesReceived} B) / META=${path.basename(metaPath)} / exit=${scriptExitCode}`
    )
    if (finalPreview) {
      warn('[record-frames] --- 諦めた時点の画面(表示領域、空行除く先頭10行) ---')
      warn(finalPreview.join('\n'))
    }
    process.exitCode = scriptExitCode
  }

  /** PTY 未起動(spawn 失敗)時の終了経路。teardown 対象の term が無いので raw を閉じるだけ。 */
  async function finishSpawnFailure(msg) {
    if (done) return
    done = true
    scriptExitCode = 1
    finalMsg = msg
    finalStopReason = 'spawn-error'
    try {
      rawStream.end()
      await finished(rawStream)
    } catch (_) {}
    await writeMetaAndPrint()
  }

  let term
  try {
    term = pty.spawn(CLAUDE_BIN, claudeArgs, {
      name: 'xterm-256color',
      cols: args.cols,
      rows: args.rows,
      cwd: ROOT_DIR,
      env: { ...process.env },
    })
  } catch (e) {
    await finishSpawnFailure(`未確認: claude の起動に失敗した(コマンド=${CLAUDE_BIN}): ${e.message}`)
    return
  }

  const exitPromise = new Promise((resolve) => {
    term.onExit((info) => {
      exitInfo = info
      resolve(info)
    })
  })

  term.onData((data) => {
    if (overflow) return
    const buf = Buffer.from(data, 'utf8')
    bytesReceived += buf.length
    lastDataAt = Date.now()
    if (bytesReceived > args.maxBytes) {
      overflow = true
      return
    }
    rawStream.write(buf)
    queue += data
    scheduleDrain()
  })

  /** 承認キーは一切送らない。ESC → Ctrl+C ×2 → onExit 待ち → kill、の順で終了処理する(F 対策)。 */
  async function finish(code, msg, stopReason, screenPreview) {
    if (done) return
    done = true
    scriptExitCode = code
    finalMsg = msg
    finalStopReason = stopReason
    finalPreview = screenPreview || null

    try {
      term.write('\x1b') // ESC
      await wait(500)
      term.write('\x03') // Ctrl+C
      await wait(300)
      term.write('\x03') // Ctrl+C(2 回目、"Press Ctrl-C again to exit" 対策)
      if (!exitInfo) {
        await Promise.race([
          exitPromise,
          wait(5000).then(() => {
            if (!exitInfo) warn('[record-frames] 警告: PTY の終了を 5 秒待っても検知できず')
          }),
        ])
      }
    } catch (_) {}
    try {
      term.kill()
    } catch (_) {}
    await wait(300)

    try {
      rawStream.end()
      await finished(rawStream)
    } catch (e) {
      warn(`[record-frames] 書き出し失敗: ${e.message}`)
      scriptExitCode = 1
    }
    // overflow / streamErr は finish() 呼び出し後(書き出し完了待ちの間)にも起こりうるため、
    // 渡された stopReason より優先して上書きする(通常経路の成功終了ではここまで来ない = until()
    // 側で先に検出されるので、実質的には teardown 中に新規発生したケースのみを拾う)。
    if (overflow) {
      warn(`[record-frames] FAIL: 出力が上限 ${args.maxBytes} バイトを超えた`)
      scriptExitCode = 1
      finalStopReason = 'overflow'
    }
    if (streamErr) {
      warn(`[record-frames] FAIL: 生ログの書き出しでエラー: ${streamErr.message}`)
      scriptExitCode = 1
      finalStopReason = 'stream-error'
    }
    await writeMetaAndPrint()
  }

  // 証跡なしの終了を作らない(シグナル・例外でも必ず META を書く)。
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      finish(1, `未確認: ${sig} を受信して中断した`, `signal:${sig}`).catch(() => {})
    })
  }
  process.on('uncaughtException', (e) => {
    finish(1, `未確認: 例外が発生した: ${e && e.message}`, 'exception').catch(() => {})
  })
  process.on('unhandledRejection', (e) => {
    finish(1, `未確認: 未処理の rejection: ${e && e.message}`, 'unhandled-rejection').catch(() => {})
  })

  const deadline = Date.now() + args.timeoutMs
  async function until(fn, pollMs) {
    for (;;) {
      const v = await fn()
      if (v) return v
      if (overflow || streamErr) return null
      if (Date.now() > deadline) return null
      await wait(pollMs)
    }
  }

  // ---- フェーズ 1: TUI 起動待ち ----
  const ready = await until(async () => tuiReady(await currentScreenText()), 700)
  if (!ready) {
    const reason = overflow ? 'overflow' : streamErr ? 'stream-error' : 'timeout'
    const preview = previewLines(await currentScreenText())
    return finish(1, `未確認: TUI が timeout-ms(${args.timeoutMs}) 以内に起動しなかった(理由=${reason})`, `startup-${reason}`, preview)
  }

  // ---- フェーズ 2: プロンプト送信(承認キーは送らない。ここが唯一の書き込み) ----
  await wait(1500)
  term.write(promptBody)
  await wait(600)
  term.write('\r')
  lastDataAt = Date.now() // idle 判定の起点をプロンプト送信直後にリセットする
  say(`[record-frames][${args.target}] プロンプト送信。stop-on=${args.stopOn} を待つ…`)

  // ---- フェーズ 3: 停止条件待ち ----
  if (args.stopOn === 'frame') {
    const first = await until(async () => frameOf(await currentScreenText()), 900)
    if (!first) {
      const reason = overflow ? 'overflow' : streamErr ? 'stream-error' : 'timeout'
      const preview = previewLines(await currentScreenText())
      return finish(1, `未確認: 承認枠が timeout-ms(${args.timeoutMs}) 以内に検出できなかった(理由=${reason})`, reason, preview)
    }
    // 検出は描画途中でも成立しうる。settle-ms 待って落ち着いてから再確認する
    // (入力エコーの一瞬の一致 = 事故 B、末尾途中の保存を避けるための実測由来の対策)。
    await wait(args.settleMs)
    const after = frameOf(await currentScreenText())
    if (!after) {
      const preview = previewLines(await currentScreenText())
      return finish(1, '未確認: settle-ms 待機中に承認枠が消えた(保存しない)', 'frame-disappeared-during-settle', preview)
    }
    if (first.optLine !== after.optLine) {
      warn(
        `[record-frames][${args.target}] 注意: settle 待機前後で枠内容が変化した` +
          `(before=${JSON.stringify(first.optLine)} after=${JSON.stringify(after.optLine)})`
      )
    }
    return finish(0, `OK: 承認枠を捕捉した(枠 L${after.iRule}-L${after.iOpt})`, 'frame-detected', null)
  }

  // stop-on=idle: プロンプト送信後、画面が idle-ms 変化しなくなったら終了する
  // (ダイアログが出ない敵対サンプルの録画用)。「変化しない」は PTY からのデータ到着
  // 間隔で判定する(データが来ない = 画面は変化しようがない)。
  const idled = await until(async () => (Date.now() - lastDataAt >= args.idleMs ? true : null), 500)
  if (!idled) {
    const reason = overflow ? 'overflow' : streamErr ? 'stream-error' : 'timeout'
    const preview = previewLines(await currentScreenText())
    return finish(1, `未確認: idle-ms(${args.idleMs}) の無変化が timeout-ms(${args.timeoutMs}) 以内に成立しなかった(理由=${reason})`, reason, preview)
  }
  return finish(0, `OK: idle 条件で終了した(無変化 ${args.idleMs}ms)`, 'idle', null)
}
