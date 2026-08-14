#!/usr/bin/env node
/**
 * tools/extract-fixture.js — 実機録画の生ログ(PTY raw stream)から、セキュリティ判定を
 * fixture 単独で再現できる `approval-attr-fixture/v1` JSON を生成する。
 *
 * 目的: 録画本体(gitignore・非公開)を必要とせず、
 * redaction 済みの生 PTY + 期待セル属性 + 期待判定だけで `tools/verify-fixture.js` が
 * 判定を再現できるようにする。判定の算出は **production の関数をそのまま呼ぶ**
 * (parseDialog / __test.barRowIsCliDrawn / __test.getScreenText / readTabBarRow)。
 * ここで判定ロジックを手写ししない(手写しは drift の温床)。
 *
 * 枠の同定(どのフレームを fixture にするか)は tools/lib-cellattrs.js の makeFrameOf
 * (production の RULE_CHARS / CURSOR_CHARS から組み立てた構造判定)と、production の
 * readTabBarRow をそのまま使う。対象行は「readTabBarRow が成立していれば bar-row、
 * そうでなければ(frameOf の)rule-line」という一意な規則で自動選択する(手で行を選ばない
 * = 「測定対象を検出条件に混ぜない」という原則と同型の一貫性)。
 *
 * **redaction 前後で期待判定が不変であることを内部で検証してから書く**。不変でなければ
 * fixture を書かずにエラー終了する(fail-close。曖昧な fixture を
 * 残さない)。
 *
 * 使い方:
 *   node tools/extract-fixture.js --raw <rawlog> --id <fixture-id> \
 *     --kind <claude-tool|webfetch|mcp|tabbed|confirm> --label <authentic|adversarial> \
 *     --origin-via <cli-render|model-output|tool-output> --origin-payload "<text>" \
 *     [--attack-family <name>] [--state-axis <csv>] \
 *     [--cols 120] [--rows 40] [--chunk 512] \
 *     [--frame <n> | --select first-frameof|first-tabbar] \
 *     --manifest-ref <docs/attr-manifest.json#entry-id> [--manifest-recording <name>] \
 *     [--out <path>]
 */
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Terminal } = require('@xterm/headless')

const claudeWrapper = require(path.join(__dirname, '..', 'claude-wrapper.js'))
const { replayFrames, makeFrameOf, DEFAULT_CHUNK } = require('./lib-cellattrs.js')
const {
  redact,
  redactRawStream,
  findRawIdentifierLeaks,
  hasAnyHomePathShape,
  scanForSecrets,
  isChromeText,
  stripControlTokensToText,
  setRepoIdentifiers,
} = require('./lib-redact.js')
const { sha256Hex, canonicalStringify, captureFrameState, comparableFields } = require('./lib-fixture-frame.js')

const say = (...a) => process.stdout.write(a.join(' ') + '\n')
const warn = (...a) => process.stderr.write(a.join(' ') + '\n')

/**
 * fail-close ログに生の識別子(ユーザー名 / home パス / repo 名 / branch 名)をそのまま
 * 出さない。件数と digest(sha256 の先頭12桁)だけを見せる(digest は「前回と同じ値が
 * 漏れているか」の追跡には使えるが、値そのものは復元できない一方向性を持つ)。
 *
 * **既知の限界(判断済み、対処しない)**: ここで扱う識別子(ユーザー名・repo 名・branch 名)は
 * 低エントロピーなため、digest(sha256 prefix)は辞書攻撃(よくある値を総当りしてハッシュを
 * 突き合わせる)への耐性が弱い。それでもこのログの読み手は「今このツールをローカルで
 * 実行している開発者自身」であり、その人物は自分自身のユーザー名・repo 名・branch 名を
 * 最初から知っている(digest を介した推測が新たな情報を与えない)。実行結果がそのまま
 * 公開されるログ(fixture 本体・CI の公開出力等)ではなく、ローカル実行時の stderr に留まる
 * 前提のため、digest のまま残し「同じ値が繰り返し漏れているか」を追跡できる実用性を優先する
 * (件数のみへ縮退させない判断)。この前提が崩れる用途(この出力を第三者と共有する等)が
 * 生じた場合は再検討すること。
 *
 * @param {string[]} matches findRawIdentifierLeaks() の matches
 * @returns {string}
 */
function summarizeMatchesForLog(matches) {
  if (!Array.isArray(matches) || matches.length === 0) return '件数=0'
  const digests = matches.map((m) => sha256Hex(Buffer.from(String(m), 'utf8')).slice(0, 12))
  return `件数=${matches.length} digest=[${digests.join(', ')}…]`
}

/**
 * scanForSecrets() の検出結果をログ向けに要約する。値そのものは一切出さず、
 * パターン名と件数だけを見せる(API key / token は識別子よりさらに機微度が高いため、
 * digest すら出さない = summarizeMatchesForLog より一段厳しい扱い)。
 *
 * @param {Array<{name: string, line: number}>} matches scanForSecrets() の matches
 * @returns {string}
 */
function summarizeSecretMatchesForLog(matches) {
  if (!Array.isArray(matches) || matches.length === 0) return '件数=0'
  const counts = new Map()
  for (const m of matches) counts.set(m.name, (counts.get(m.name) || 0) + 1)
  const parts = [...counts.entries()].map(([name, n]) => `${name}×${n}`)
  return `件数=${matches.length} 内訳=[${parts.join(', ')}]`
}

/**
 * ログ(stdout/stderr)に埋め込む前に、CLI 引数由来の未検証文字列から制御文字を取り除く。
 * 検証されていない自由記述(--manifest-recording の指定値、--manifest-ref の `#` 以降等)を
 * warn()/say() へそのまま埋め込むと、改行やエスケープシーケンスでログの見た目を偽装できて
 * しまう(ログ注入)。C0/C1 制御文字(改行・ESC 等)をすべて除去する(内容の意味を変えない
 * 範囲の衛生措置。redact() の識別子マスクとは別レイヤで、両方独立に適用する)。
 *
 * @param {unknown} s
 * @returns {string}
 */
function sanitizeLogValue(s) {
  return String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, '')
}

// ---- 引数 ----
function parseArgs(argv) {
  const out = {
    raw: null,
    id: null,
    kind: null,
    label: null,
    originVia: null,
    originPayload: null,
    attackFamily: null,
    stateAxis: [],
    cols: 120,
    rows: 40,
    chunk: DEFAULT_CHUNK,
    frame: null,
    select: null,
    manifestRef: null,
    manifestRecording: null,
    out: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--raw') out.raw = argv[++i]
    else if (a === '--id') out.id = argv[++i]
    else if (a === '--kind') out.kind = argv[++i]
    else if (a === '--label') out.label = argv[++i]
    else if (a === '--origin-via') out.originVia = argv[++i]
    else if (a === '--origin-payload') out.originPayload = argv[++i]
    else if (a === '--attack-family') out.attackFamily = argv[++i]
    else if (a === '--state-axis') out.stateAxis = argv[++i].split(',').filter(Boolean)
    else if (a === '--cols') out.cols = Number(argv[++i])
    else if (a === '--rows') out.rows = Number(argv[++i])
    else if (a === '--chunk') out.chunk = Number(argv[++i])
    else if (a === '--frame') out.frame = Number(argv[++i])
    else if (a === '--select') out.select = argv[++i]
    else if (a === '--manifest-ref') out.manifestRef = argv[++i]
    else if (a === '--manifest-recording') out.manifestRecording = argv[++i]
    else if (a === '--out') out.out = argv[++i]
  }
  return out
}

const KIND_ENUM = ['claude-tool', 'webfetch', 'mcp', 'tabbed', 'confirm']
const LABEL_ENUM = ['authentic', 'adversarial']
const ORIGIN_VIA_ENUM = ['cli-render', 'model-output', 'tool-output']

function usage() {
  warn('使い方: node tools/extract-fixture.js --raw <rawlog> --id <id> --kind <kind> --label <label>')
  warn('  --origin-via <cli-render|model-output|tool-output> --origin-payload "<text>"')
  warn('  --manifest-ref <docs/attr-manifest.json#entry-id> [--manifest-recording <name>]')
  warn('  [--frame <n> | --select first-frameof|first-tabbar] [--cols 120] [--rows 40] [--chunk 512] [--out <path>]')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.raw || !args.id || !args.kind || !args.label || !args.originVia || !args.manifestRef) {
    usage()
    process.exit(1)
  }
  // --id は既定出力パス(test/fixtures/attr/<id>.json)にそのまま埋め込むため、
  // パス区切り・親ディレクトリ参照を含む値を拒否する(ローカル CLI の自己指定引数だが、
  // 意図しないファイル上書き経路を残さない)。
  if (!/^[A-Za-z0-9._-]+$/.test(args.id)) {
    warn('[extract-fixture] --id は英数字 . _ - のみ(パス区切りは不可)')
    process.exit(1)
  }
  if (!KIND_ENUM.includes(args.kind)) {
    warn(`[extract-fixture] --kind は ${KIND_ENUM.join('|')} のいずれか`)
    process.exit(1)
  }
  if (!LABEL_ENUM.includes(args.label)) {
    warn(`[extract-fixture] --label は ${LABEL_ENUM.join('|')} のいずれか`)
    process.exit(1)
  }
  if (!ORIGIN_VIA_ENUM.includes(args.originVia)) {
    warn(`[extract-fixture] --origin-via は ${ORIGIN_VIA_ENUM.join('|')} のいずれか`)
    process.exit(1)
  }
  if (!args.frame && !args.select) {
    warn('[extract-fixture] --frame <n> か --select first-frameof|first-tabbar のいずれかが必要')
    process.exit(1)
  }
  if (args.select && !['first-frameof', 'first-tabbar'].includes(args.select)) {
    warn('[extract-fixture] --select は first-frameof|first-tabbar のいずれか')
    process.exit(1)
  }
  if (![args.cols, args.rows, args.chunk].every((n) => Number.isInteger(n) && n > 0)) {
    warn('[extract-fixture] --cols/--rows/--chunk は正の整数')
    process.exit(1)
  }

  const RAW_PATH = path.resolve(args.raw)
  if (!fs.existsSync(RAW_PATH)) {
    // RAW_PATH は絶対パス(home ディレクトリ配下 = ユーザー名を含みうる)なので
    // basename だけを出す。
    warn(`[extract-fixture] ログが見つからない: ${path.basename(RAW_PATH)}`)
    process.exit(1)
  }
  const OUT_PATH = args.out ? path.resolve(args.out) : path.join(__dirname, '..', 'test', 'fixtures', 'attr', `${args.id}.json`)

  // ---- manifest 突合(必須化。省略時は --raw の basename でエントリを特定) ----
  // **git 動的取得は fail-open になる**: 従来は repo/branch 識別子を `git branch` の
  // 動的取得に頼っていた。Git 失敗 / detached HEAD / 削除済みブランチ / remote ブランチは
  // 識別子集合に入らず、しかも同じ集合を最終検査(findRawIdentifierLeaks)にも使うため、
  // 未知ブランチの残存を検出できない(fail-open)。実際、この録画群の一部(2026-08-08 収録の
  // e2e-raw-mcp.log 等)は録画当時のブランチが既に削除されており、`git branch` の現在地からは
  // 復元不能であることを確認済み。
  //
  // 修正 = git 動的取得を廃し、録画時点の repo/branch を docs/attr-manifest.json に固定記録し、
  // ここから読んだ値だけを識別子集合として使う(setRepoIdentifiers。git を一切呼ばない)。
  // manifest に repo/branch が無い / 取得不能ならエラーで停止する(fail-close)。
  // ログ注入対策(未検証の自由記述をそのまま warn()/say() へ埋め込まない、sanitizeLogValue
  // 参照): 派生した時点で一度だけ sanitize し、以後の照合・ログ出力の両方でこの値を使う
  // (照合に使っても実害は無い。正規のファイル名は制御文字を含まないため sanitize は no-op)。
  const manifestRecordingName = sanitizeLogValue(args.manifestRecording || path.basename(RAW_PATH))
  const manifestPath = path.join(__dirname, '..', 'docs', 'attr-manifest.json')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    // manifestPath は絶対パス、e.message は fs エラーの場合に絶対パスを埋め込みうるため
    // 両方とも出さない(basename と例外の種別名だけに留める)。
    warn(`[extract-fixture] 諦め: manifest を読めない(${path.basename(manifestPath)}): ${e && e.name ? e.name : 'Error'}`)
    warn('  repo/branch 識別子を manifest から固定取得できないため fail-close する。')
    process.exit(1)
  }
  const entryId = sanitizeLogValue(args.manifestRef.split('#')[1] || '')
  const manifestEntry = manifest.entries.find((e) => e.id === entryId)
  if (!manifestEntry) {
    warn(`[extract-fixture] 諦め: manifest エントリが見つからない: ${entryId}`)
    process.exit(1)
  }
  const manifestRec =
    manifestEntry.recordings && Array.isArray(manifestEntry.recordings.files)
      ? manifestEntry.recordings.files.find((f) => f.name === manifestRecordingName)
      : null
  if (!manifestRec) {
    warn(`[extract-fixture] 諦め: manifest に録画エントリが無い: ${manifestRecordingName}`)
    process.exit(1)
  }
  // TOCTOU 対策: RAW_PATH は hash 検証と後続の fixture 化処理の双方で同一の読込結果
  // (rawFileBuf)を使う。二度読みすると、検証と処理の間にファイルが差し替えられた場合に
  // 未検証のバイト列がそのまま fixture 化されうる(検証したのはハッシュ計算用の1回目の
  // 読込結果であって、実際に処理される2回目の読込結果ではないため)。
  const rawFileBuf = fs.readFileSync(RAW_PATH)
  const actualSha = crypto.createHash('sha256').update(rawFileBuf).digest('hex')
  if (actualSha !== manifestRec.sha256) {
    warn(`[extract-fixture] 諦め: 録画の sha256 が manifest と不一致(drift の疑い): ${manifestRecordingName}`)
    warn(`  manifest: ${manifestRec.sha256}`)
    warn(`  actual  : ${actualSha}`)
    process.exit(1)
  }
  say(`[extract-fixture] manifest 突合 OK: ${manifestRecordingName} sha256=${actualSha}`)

  // ---- repo/branch 識別子を manifest から固定取得し、git を呼ばずに setRepoIdentifiers する ----
  const manifestIdentifiers = manifestRec.identifiers
  const identifierRepo =
    manifestIdentifiers && typeof manifestIdentifiers.repo === 'string' ? manifestIdentifiers.repo.trim() : ''
  const identifierBranch =
    manifestIdentifiers && typeof manifestIdentifiers.branch === 'string' ? manifestIdentifiers.branch.trim() : ''
  if (!identifierRepo || !identifierBranch) {
    warn(`[extract-fixture] 諦め: manifest に repo/branch 識別子が記録されていない(recording=${manifestRecordingName})。`)
    warn('  録画時点の repo/branch が固定されていないと、タイトルバーの識別子マスクが')
    warn('  git の現在地(削除済みブランチ・detached HEAD・git 失敗等)に fail-open するため、')
    warn('  この録画は fixture 化しない(fail-close)。docs/attr-manifest.json の当該 recording に')
    warn('  identifiers.repo / identifiers.branch を追記してから再実行すること。')
    process.exit(1)
  }
  // **短すぎる識別子の fail-close ガード**: lib-redact.js の
  // buildIdentifierPatterns() は 2 文字未満の識別子を検出精度の都合で無条件に無視する
  // (短すぎる名前は境界ガード付きでも誤爆リスクが上がるため)。repo/branch が万一 1 文字だと、
  // この既定挙動により識別子集合から静かに脱落し、マスク・最終検査ともにその識別子を一切
  // 見なくなる(fail-open)。ここで明示的に長さを検査し、1 文字識別子が来たら fixture 化
  // そのものを拒否する(fail-close。buildIdentifierPatterns() 側の閾値と同じ値を使う)。
  const MIN_IDENTIFIER_LEN = 2
  if (identifierRepo.length < MIN_IDENTIFIER_LEN || identifierBranch.length < MIN_IDENTIFIER_LEN) {
    warn(
      `[extract-fixture] 諦め: repo/branch 識別子が短すぎる(${MIN_IDENTIFIER_LEN} 文字未満は` +
        ` lib-redact.js のマスク対象から静かに外れるため fail-close する、recording=${manifestRecordingName})。`
    )
    process.exit(1)
  }
  // repo 名(ディレクトリ名)はタイトルバー以外(例: MCP ツールの working-directory 表示
  // `/home/user/…/<repo>`)にも正当に出現し、そこは chrome 灰色ではないが伏せること自体は
  // 正しい(home パス開示の一部)。「よくある branch 名が無関係な文脈に偶然出現する」checkOverReplacement 本来の
  // 懸念は branch 名側だけ検査する(lib-redact.js buildIdentifierPatterns() のコメント参照)。
  setRepoIdentifiers([{ name: identifierRepo, checkOverReplacement: false }, { name: identifierBranch }])
  // **成功ログにも生の値を出さない**: repo/branch の
  // 生の値を成功ログにそのまま出さない(識別子は本関数の伏せ対象そのものであり、
  // stderr〔CI ログ等〕への平文出力自体が漏洩経路になる)。件数・digest のみ出す。
  say(
    `[extract-fixture] repo/branch 識別子を manifest から固定` +
      `(repo digest=${sha256Hex(Buffer.from(identifierRepo, 'utf8')).slice(0, 12)}… ` +
      `branch digest=${sha256Hex(Buffer.from(identifierBranch, 'utf8')).slice(0, 12)}…)`
  )

  /**
   * data(生 PTY 文字列)を再生し、指定フレーム(explicitFrame)またはフレーム選択規則
   * (selectMode)に最初に合致したフレームの状態を production 関数でそのまま判定して返す。
   * 「1 フレームぶんの判定」自体は tools/lib-fixture-frame.js の captureFrameState()
   * (verify-fixture.js と共有)に委譲し、ここでは「どのフレームが対象か」だけを決める。
   *
   * 合致規則(手で行を選ばない = 構造で選ぶ):
   *   first-frameof  : frameOf(viewportText) !== null になった最初のフレーム
   *   first-tabbar   : readTabBarRow(buf, rows) !== null になった最初のフレーム
   * 対象行(target_row)の決め方は captureFrameState() 側の一意な規則(bar-row 優先)を使う。
   *
   * @returns {Promise<object|null>} 合致フレームが無ければ null
   */
  async function computeFrameState(data, { cols, rows, chunk, explicitFrame, selectMode }) {
    const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
    claudeWrapper.__test.setHeadlessTerm(term)
    const frameOf = makeFrameOf(claudeWrapper)
    let captured = null
    let totalFrames = 0

    async function onFrame(frameIdx) {
      totalFrames = frameIdx
      if (captured) return

      // isTarget の判定だけは軽量に済ませる(select モードは対象フレームを事前に
      // 知らないため、毎フレーム最低限のチェックが要る)。合致するまで重い判定
      // (captureFrameState = parseDialog 2 回 + dumpRowAttrs)は呼ばない。
      let isTarget
      if (explicitFrame) {
        isTarget = frameIdx === explicitFrame
      } else {
        const buf = term.buffer.active
        const viewportText = claudeWrapper.__test.getViewportText()
        if (selectMode === 'first-frameof') isTarget = !!frameOf(viewportText)
        else if (selectMode === 'first-tabbar') {
          let barRow = null
          try {
            barRow = claudeWrapper.readTabBarRow(buf, rows)
          } catch (_) {}
          isTarget = !!(barRow && typeof barRow.y === 'number')
        } else isTarget = false
      }
      if (!isTarget) return

      captured = { frameIdx, ...captureFrameState(claudeWrapper, frameOf, term, rows) }
    }

    await replayFrames(term, data, { chunk, onFrame })
    term.dispose()
    if (!captured) return null
    captured.totalFrames = totalFrames
    return captured
  }

  /**
   * セル座標ベースの fail-close 安全網: data(redaction 後の生 PTY 文字列)を全フレームぶん
   * @xterm/headless で再生し、**実際に描画されたセルのテキスト**(バイト列上の行区切り推定に
   * 依存しない、production と同じ最終出力)に対して isChromeText / findRawIdentifierLeaks を
   * 独立に再度掛ける。redactRawStream() のバイト列レベルのマスク(マーカー位置基準のカット・
   * \r/\n ベースの行区切り)が取りこぼした残存があれば、対象行/フレームがどれであっても
   * ここで検出できる(セル座標ベースの検査は「今その瞬間に画面へ描画された文字列」を見るため、
   * バイト列側の行区切り誤りの影響を受けない)。
   *
   * @param {string} data redaction 後の生 PTY 文字列(rawRedacted)
   * @param {{cols:number, rows:number, chunk:number}} geo
   * @returns {Promise<Array<{frame:number, y:number, reason:string}>>}
   */
  async function scanReplayForResidue(data, { cols, rows, chunk }) {
    const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
    const residues = []
    const scanLine = (buf, y, frameLabel) => {
      const line = buf.getLine(y)
      if (!line) return
      const text = line.translateToString(true) // 行末の空白を落とす
      if (!text) return
      if (isChromeText(text)) {
        residues.push({ frame: frameLabel, y, reason: 'chrome マーカー(◉ / 📒 / manual mode on 等)の残存' })
        return
      }
      const leak = findRawIdentifierLeaks(text)
      if (leak.leaked) {
        // 生の識別子文字列を reason に埋め込まない(件数・digest のみ)。
        residues.push({ frame: frameLabel, y, reason: `識別子の残存(${summarizeMatchesForLog(leak.matches)})` })
      }
    }
    await replayFrames(term, data, {
      chunk,
      onFrame: (frameIdx) => {
        const buf = term.buffer.active
        // **viewportY 基準で走査する**: buf.getLine(y)
        // (0..rows-1)はバッファ絶対位置であり、scrollback が進んだ後の「今画面に見えている行」
        // ではない(y=0 は録画開始時点の最初の行を指したままで、以後増える scrollback を
        // 全く追わない。この録画は 1 フレームごとに new-line を多数出すため、数フレーム進んだ
        // 時点で y=0..rows-1 は既に画面から流れ去った過去の行を指すようになる)。現在の
        // ビューポート先頭は buf.viewportY のため、viewportY + y で「実際に描画されたセル」を
        // 走査する。
        for (let y = 0; y < rows; y++) scanLine(buf, buf.viewportY + y, frameIdx)
      },
    })
    // 追加防御: 個々のフレーム(viewportY 基準)の走査だけでは、1 チャンク(chunk バイト)を
    // 処理する間にビューポートを素通りしてスクロールバックへ落ちた行(=どの onFrame 呼び出し
    // 時点でもビューポートに写らなかった行)を取りこぼす。replay 完了後、バッファ全体
    // (0..length-1、scrollback 上限 1000 行 + rows ぶん)を一度だけ追加走査してこれを塞ぐ
    // (毎フレーム全体を走査すると計算量が frames×length で膨らむため、最後に1回だけ行う。
    // scrollback 上限を超えて追い出された行はこの最終走査でも見えない = 既知の限界だが、
    // このリポジトリの実録画〔数十KB、rows=30/40〕では scrollback 上限〔1000行〕への到達は
    // 未観測)。
    const finalBuf = term.buffer.active
    for (let y = 0; y < finalBuf.length; y++) scanLine(finalBuf, y, 'post-replay-full-scan')
    term.dispose()
    return residues
  }

  // TOCTOU 対策(上記 rawFileBuf 参照): ここで再度 fs.readFileSync(RAW_PATH) しない。
  // hash 検証に使ったのと同じバッファをそのまま使う。
  const rawOriginal = rawFileBuf.toString('utf8')

  const opts = { cols: args.cols, rows: args.rows, chunk: args.chunk, explicitFrame: args.frame, selectMode: args.select }
  const before = await computeFrameState(rawOriginal, opts)
  if (!before) {
    warn(
      `[extract-fixture] 対象フレームが見つからなかった(--frame ${args.frame || 'null'} / --select ${
        args.select || 'null'
      }、cols=${args.cols} rows=${args.rows} chunk=${args.chunk})。幾何 or 選択条件を見直すこと。`
    )
    process.exit(1)
  }
  say(
    `[extract-fixture] 対象フレーム確定: frame #${before.frameIdx}/${before.totalFrames}` +
      `  targetRowKind=${before.targetRowKind}  targetRowY=${before.targetRowY}`
  )

  // ---- 露出面積の根本的な削減: raw_pty を対象フレームの直後で切り詰める ----
  // fixture が実際に必要とするのは「対象フレーム時点の状態」だけ(expected_cells /
  // expected_verdict はいずれも対象フレームのみに由来し、それ以降のフレームは一切参照
  // しない)。にもかかわらず、これまでは録画全体を raw_pty として公開していた。
  // 実データで確認した事実: この CLI は部分再描画で
  // 「前回の描画済みセルの上に一部だけ書き足す」個体があり(実測: 列ジャンプで1文字だけ
  // 書き残されるケース)、対象フレームより**後**のフレームでのみ、既にマスク済みの識別子の
  // 断片がバイト列レベルでは検出できない形で画面上に再構成されることがある(scanReplayForResidue
  // が検出)。この種の残存はテキスト正規表現でのマスクが原理的に困難(該当文字がその時点の
  // バイト列に存在しない = 過去のセル状態がそのまま残っているだけ)だが、
  // **fixture はそもそも対象フレームより後の内容を必要としない**ため、切り詰めれば
  // 露出面積(=残存が起こりうる範囲)ごと無くせる。対象フレームのチャンク境界までで
  // 録画を打ち切り、以降のすべての処理(redaction / 各種検査 / fixture 化)はこの
  // 切り詰め後のデータに対して行う。
  const truncatedLen = Math.min(rawOriginal.length, before.frameIdx * args.chunk)
  const rawTruncated = rawOriginal.slice(0, truncatedLen)
  // fixture.frame.total_frames は「公開する raw_pty を再生すると何フレームになるか」を表す
  // (verify-fixture.js が実際の再生結果と突き合わせる値)。切り詰めた場合は元の録画全体の
  // totalFrames ではなく、切り詰め後の再生結果を使う。
  let finalTotalFrames = before.totalFrames
  if (rawTruncated.length !== rawOriginal.length) {
    say(`[extract-fixture] raw_pty を対象フレーム直後で切り詰め: ${rawOriginal.length} → ${rawTruncated.length} 文字`)
    // 切り詰め後も対象フレームの状態が変わらないことを確認する(fail-close の前提を保つ)。
    const beforeAfterTruncate = await computeFrameState(rawTruncated, { ...opts, explicitFrame: before.frameIdx, selectMode: null })
    if (!beforeAfterTruncate) {
      warn(`[extract-fixture] 諦め: raw_pty 切り詰め後にフレーム #${before.frameIdx} を再現できなかった(想定外)。`)
      process.exit(1)
    }
    const digestTruncateCheck = (c) => sha256Hex(Buffer.from(canonicalStringify(comparableFields(c)), 'utf8'))
    if (digestTruncateCheck(beforeAfterTruncate) !== digestTruncateCheck(before)) {
      warn('[extract-fixture] 諦め: raw_pty 切り詰めで対象フレームの判定が変わった(想定外、fail-close)。')
      process.exit(1)
    }
    finalTotalFrames = beforeAfterTruncate.totalFrames
  }
  const rawOriginalForFixture = rawTruncated

  // ---- redaction ----
  // redactRawStream(): エスケープ列(CSI/OSC/C0 制御)を1バイトも変更せず、印字文字
  // トークンだけを 'x' に置換する専用実装(lib-redact.js のコメント参照)。既定の
  // redact()(NFKC 正規化 + 行丸ごとマスク)は生ストリームに使うと ①NFKC が文字数を
  // 変える ②丸ごとマスクがカーソル位置指定シーケンスごと潰す、の 2 点で実測破綻したため
  // 採用しない(このコメントは実測で確認した理由。tools/lib-redact.js 参照)。
  const redactDiagnostics = { overReplacements: [] }
  const rawRedacted = redactRawStream(rawOriginalForFixture, redactDiagnostics)
  if (rawRedacted.length !== rawOriginalForFixture.length) {
    warn(
      `[extract-fixture] 諦め: redaction が文字列長を変えた(元 ${rawOriginalForFixture.length} → 後 ${rawRedacted.length})。` +
        ' redactRawStream() は文字数不変を前提にしており、変わった場合は想定外の置換経路がある。' +
        ' チャンク境界(フレーム番号)が redaction 前後でずれるため、この録画はこのままでは fixture 化できない。'
    )
    process.exit(1)
  }
  // **過剰置換チェック**: 一般的なブランチ名(例: "main")が承認コマンドや
  // 選択肢の正当な内容に偶然含まれても置換されうる(過剰マスクで内容を破壊する)。
  // redactRawStream() は repo/branch 一致が chrome(タイトルバー)色の外で起きた件数を
  // diagnostics.overReplacements に記録する(lib-redact.js 参照)。1件でもあれば、内容破壊の
  // 疑いを優先してこの録画は fixture 化しない(fail-close。マスク自体は既に実行済みなので
  // 個人情報が漏れることはないが、正当な内容が失われた fixture を公開しない)。
  if (redactDiagnostics.overReplacements.length > 0) {
    warn(
      `[extract-fixture] 諦め: repo/branch 識別子が chrome 色の外で ${redactDiagnostics.overReplacements.length} 件一致した(過剰置換の疑い)。`
    )
    for (const o of redactDiagnostics.overReplacements.slice(0, 5)) warn(`  - ${o.reason}`)
    warn(
      '  一般的な語(例: ブランチ名 "main")が承認コマンド等の正当な内容に偶然含まれ、' +
        ' マスクで内容を破壊した可能性がある。この録画・このフレームはこのままでは fixture 化しない(fail-close)。'
    )
    process.exit(1)
  }
  // 最終防御: preserveWidth モードは全角ホモグリフ分割への耐性を失うため、
  // 素のユーザー名 / home パス文字列がそのまま残っていないかを独立に確認する(fail-close)。
  const leakCheck = findRawIdentifierLeaks(rawRedacted)
  if (leakCheck.leaked) {
    // 生の識別子文字列を fail-close ログにそのまま出さない(件数・digest のみ)。
    warn(`[extract-fixture] 諦め: redaction 後も生の識別子が残っている(${summarizeMatchesForLog(leakCheck.matches)})`)
    warn('  公開物への個人情報混入を避けるため、この録画は fixture 化しない(fail-close)。')
    process.exit(1)
  }
  // 多層防御その2(findRawIdentifierLeaks とは別経路): 制御トークンを除去した「描画後
  // テキスト」に statusline / タイトルバー chrome のマーカー(◉ / 📒 / manual mode on 等)が
  // まだ残っていないかを確認する。redactRawStream() 側のマスク条件に将来抜けが出ても、
  // ここで機械的に検知して fixture を書かずに止める(findRawIdentifierLeaks はユーザー名 /
  // home パス / repo 名 / branch 名という「既知の識別子」の残存を見るのに対し、こちらは
  // 「chrome だと分かる形跡そのもの」が残っていないかを見る、独立した観点)。
  const strippedRedacted = stripControlTokensToText(rawRedacted)
  if (isChromeText(strippedRedacted)) {
    warn('[extract-fixture] 諦め: redaction 後も chrome マーカー(◉ / statusline 等)の痕跡が残っている。')
    warn('  公開物への個人情報混入を避けるため、この録画は fixture 化しない(fail-close)。')
    process.exit(1)
  }
  // secret scanner(findRawIdentifierLeaks とは別の脅威、個人環境情報ではなく API key /
  // token / 資格情報): 実機録画の画面には、認証エラーのメッセージ・env var のデバッグ出力・
  // コピペされたトークン等の形で secret が描画されうる。既存の識別子検査(ユーザー名 /
  // home パス / repo 名 / branch 名)は secret を対象にしないため見逃す。raw(生ストリーム)と
  // stripped(制御トークン除去後の論理テキスト、上の strippedRedacted を再利用。識別子検査と
  // 同じ2系統)の両方に掛ける。
  const secretCheckRaw = scanForSecrets(rawRedacted)
  const secretCheckStripped = scanForSecrets(strippedRedacted)
  if (secretCheckRaw.leaked || secretCheckStripped.leaked) {
    const combined = [...secretCheckRaw.matches, ...secretCheckStripped.matches]
    warn(`[extract-fixture] 諦め: redaction 後の raw_pty に API key/token/資格情報らしき文字列が残っている(${summarizeSecretMatchesForLog(combined)})`)
    warn('  公開物への機密情報混入を避けるため、この録画は fixture 化しない(fail-close)。')
    process.exit(1)
  }

  // 多層防御その3: バイト列レベルの行区切り
  // 推定(redactRawStream の isRowBoundary)や、マーカー位置基準のカットは、①統計値が
  // マーカーの手前に直接連結され前半が残る②\r/\n を伴わない CSI 垂直移動で複数の
  // 画面行が誤って同一の論理行として扱われる、の 2 経路で取りこぼす余地がある。
  // 「逆写像でのマスクが困難なら、再生画面(セル座標ベース)に chrome マーカー/識別子が
  // 残っていたら fixture 生成を fail-close で拒否する」という代替方針を、redactRawStream()
  // のバイト列処理とは独立した経路として実装する: redaction 後の生ストリームを
  // @xterm/headless で全フレーム・全行にわたって再生し、production と同じ判定関数
  // (isChromeText / findRawIdentifierLeaks)を「実際に描画されたセルのテキスト」に対して
  // もう一度掛ける。バイト列側のマスク精度に依存しない最終防御。
  const residues = await scanReplayForResidue(rawRedacted, { cols: args.cols, rows: args.rows, chunk: args.chunk })
  if (residues.length > 0) {
    warn(`[extract-fixture] 諦め: 再生画面(セル座標ベース)に redaction 後もマーカー/識別子の残存が見つかった(${residues.length} 件)。`)
    for (const r of residues.slice(0, 10)) warn(`  - frame #${r.frame} y=${r.y}: ${r.reason}`)
    if (residues.length > 10) warn(`  ...ほか ${residues.length - 10} 件`)
    warn(
      '  マーカー基準のマスクだけでは取りこぼす個体があるため、セル座標ベースの' +
        ' 再検査を独立に行っている。この録画・このフレームはこのままでは fixture 化できない(fail-close)。'
    )
    process.exit(1)
  }
  say(`[extract-fixture] セル座標ベースの残存検査 OK(${args.rows}行 × 全フレーム、残存 0 件)`)

  const after = await computeFrameState(rawRedacted, { ...opts, explicitFrame: before.frameIdx, selectMode: null })
  if (!after) {
    warn(`[extract-fixture] 諦め: redaction 後の再生でフレーム #${before.frameIdx} を再現できなかった。`)
    process.exit(1)
  }

  // ---- redaction 前後で期待判定(expected_cells + expected_verdict)が不変であることを確認 ----
  const digestOf = (c) => sha256Hex(Buffer.from(canonicalStringify(comparableFields(c)), 'utf8'))
  const digestBefore = digestOf(before)
  const digestAfter = digestOf(after)
  if (digestBefore !== digestAfter) {
    // before は未 redact の再生結果(cell の run テキスト /
    // parseDialog の args 等、画面由来の生データ)を含むため、fail-close ログにそのまま
    // JSON.stringify(before) を出すと個人環境情報が stderr(≒ CI ログ等)へ露出しうる。
    // 値そのものは出さず、①変化したフィールド名 ②対象行の座標 ③digest だけを出す。
    const bComp = comparableFields(before)
    const aComp = comparableFields(after)
    const changedFields = [...new Set([...Object.keys(bComp), ...Object.keys(aComp)])].filter(
      (key) => canonicalStringify(bComp[key]) !== canonicalStringify(aComp[key])
    )
    warn('[extract-fixture] 諦め: redaction 前後で期待判定(expected_cells + expected_verdict)が変わった。')
    warn(`  変化したフィールド: ${JSON.stringify(changedFields)}`)
    warn(
      `  target_row: kind=${before.targetRowKind} y=${before.targetRowY}(before) / ` +
        `kind=${after.targetRowKind} y=${after.targetRowY}(after)`
    )
    warn(`  digest: before=${digestBefore.slice(0, 16)}… after=${digestAfter.slice(0, 16)}…`)
    warn('  (run テキスト / args 等の値そのものは未 redact の可能性があるため出力しない)')
    warn('  redaction 前後の不変性が崩れたため、この録画・このフレームはこのままでは fixture として採用できない(fail-close)。')
    process.exit(1)
  }
  say(`[extract-fixture] redaction 不変性 OK(digest 一致 = ${digestBefore.slice(0, 16)}…)`)

  // ---- fixture 組み立て ----
  // **CLI 引数由来のフィールドも redact する**: origin.payload / attack_family / state_axis は
  // 画面由来ではなく CLI 引数(呼び出し側が手で入力する自由記述)だが、「画面の内容を
  // 人間の言葉で要約する」フィールドである以上、個人環境情報を書き写してしまう経路になり得る
  // (raw_pty のような構造的な redaction 検査を一度も通っていなかった)。書き出す前に
  // redact() を通す(defense in depth。この後の全体スキャンで検知されても「書かない」だけで
  // なく、まず積極的に伏せておく)。
  const sanitizedOriginPayload = args.originPayload ? redact(args.originPayload) : null
  const sanitizedAttackFamily = args.label === 'adversarial' && args.attackFamily ? redact(args.attackFamily) : null
  const sanitizedStateAxis = Array.isArray(args.stateAxis) ? args.stateAxis.map((s) => redact(s)) : args.stateAxis

  const redactedBuf = Buffer.from(rawRedacted, 'utf8')
  const fixture = {
    schema: 'approval-attr-fixture/v1',
    id: args.id,
    kind: args.kind,
    label: args.label,
    origin: {
      via: args.originVia,
      payload: sanitizedOriginPayload,
      attack_family: sanitizedAttackFamily,
    },
    state_axis: sanitizedStateAxis,
    geometry: { cols: args.cols, rows: args.rows, chunk: args.chunk },
    // **manifest_ref は検証済みの値だけから再構築する**: args.manifestRef
    // (CLI 引数の生値)をそのまま保存すると、`#` より前の部分が未検証のまま原文保存される。
    // 例えば別ユーザーの `/home/alice#valid-id` のような値は、現在ユーザー基準の
    // findRawIdentifierLeaks() を素通りしうる(別ユーザーの home パスは検出対象外)。
    // ここでは「固定文字列 docs/attr-manifest.json」+「manifest から検証済みで取得した
    // entry id(manifestEntry.id、この時点で既に manifest.entries に実在すると確認済み)」
    // だけから再構築する。CLI 引数の任意の文字列が manifest_ref に混入する経路を構造的に断つ。
    manifest_ref: `docs/attr-manifest.json#${manifestEntry.id}`,
    raw_pty: {
      encoding: 'base64',
      redacted: true,
      redaction_rules: [
        'lib-redact.redactRawStream() — ANSI エスケープ列は不変のまま、印字文字トークンのみ home-path/username を幅保存置換 + statusline/titlebar chrome を幅保存マスク',
        ...(rawTruncated.length !== rawOriginal.length
          ? [`対象フレーム(#${before.frameIdx})の直後で録画を切り詰め済み(露出面積削減、元は #${before.totalFrames} フレームぶんの録画)`]
          : []),
      ],
      data_b64: redactedBuf.toString('base64'),
      sha256: sha256Hex(redactedBuf),
    },
    frame: {
      select: args.select || 'explicit',
      frame_index: before.frameIdx,
      total_frames: finalTotalFrames,
    },
    expected_cells: {
      target_row_kind: before.targetRowKind,
      target_row_y: before.targetRowY,
      runs: before.runs,
    },
    expected_verdict: {
      frameOf: before.frameOfFound,
      readTabBarRow: before.barRowFound,
      barRowIsCliDrawn: before.cliDrawn,
      parseDialog: before.parseDialogFull,
      parseDialogScreenOnly: before.parseDialogScreenOnly,
    },
    digest: digestBefore,
  }

  // ---- write 前に fixture 全体(メタデータ含む)を独立に再検査する ----
  // これまでの検査(leakCheck / isChromeText(strippedRedacted) / scanReplayForResidue)は
  // いずれも raw_pty(生 PTY ストリーム)だけが対象だった。origin.payload / label / kind /
  // manifest_ref 等、CLI 引数や manifest 経由で持ち込まれる他のフィールドは一度も検査されて
  // いなかった。raw_pty.data_b64 は上記で既に独立検査済みかつ
  // base64 は識別子と偶然一致しないため除外し、残り全フィールド(sanitizedOriginPayload 等、
  // 上で redact() 済みのものも含む)を対象に同じ 2 系統の検査をもう一度掛ける。
  const scanClone = JSON.parse(JSON.stringify(fixture))
  if (scanClone.raw_pty) scanClone.raw_pty.data_b64 = ''
  const fixtureSerialized = JSON.stringify(scanClone)
  const metaLeakCheck = findRawIdentifierLeaks(fixtureSerialized)
  if (metaLeakCheck.leaked) {
    // 生の識別子文字列を fail-close ログにそのまま出さない(件数・digest のみ)。
    warn(`[extract-fixture] 諦め: fixture 全体(メタデータ含む)に生の識別子が残っている(${summarizeMatchesForLog(metaLeakCheck.matches)})`)
    warn('  origin.payload / label 等、raw_pty 以外のフィールドに個人環境情報が混入していないか確認すること(fail-close)。')
    process.exit(1)
  }
  if (isChromeText(stripControlTokensToText(fixtureSerialized))) {
    warn('[extract-fixture] 諦め: fixture 全体に chrome マーカー(◉ / 📒 等)の痕跡が残っている(fail-close)。')
    process.exit(1)
  }
  // **他ユーザーの home パスも検査する**: findRawIdentifierLeaks
  // は現在の OS ユーザー基準の検査のため、別ユーザーの home パス(例: manifest_ref 等に
  // 紛れ込んだ `/home/alice/...`)は検出できない。hasAnyHomePathShape() で「home パスという
  // 形状そのもの」を、埋め込まれたユーザー名の値によらず全メタデータに対して検査する。
  if (hasAnyHomePathShape(fixtureSerialized)) {
    warn('[extract-fixture] 諦め: fixture 全体(メタデータ含む)に home パス形状の文字列が残っている')
    warn('  (現在のユーザーとは無関係な値の可能性があるため fail-close する)。')
    process.exit(1)
  }
  // secret scanner をメタデータ全体(origin.payload / state_axis / expected_cells.runs 等、
  // raw_pty.data_b64 は上記と同じ理由で除外済みの scanClone)にも掛ける。raw_pty は既に
  // 独立に検査済みだが、CLI 引数 / manifest 経由で持ち込まれるフィールドは一度も secret
  // scanner を通っていなかったため、raw_pty 側の検査(上)と対にして両方を独立に見る。
  const metaSecretCheck = scanForSecrets(fixtureSerialized)
  if (metaSecretCheck.leaked) {
    warn(`[extract-fixture] 諦め: fixture 全体(メタデータ含む)に API key/token/資格情報らしき文字列が残っている(${summarizeSecretMatchesForLog(metaSecretCheck.matches)})`)
    warn('  origin.payload 等、raw_pty 以外のフィールドに機密情報が混入していないか確認すること(fail-close)。')
    process.exit(1)
  }
  say('[extract-fixture] fixture 全体(メタデータ含む)の write 前検査 OK(残存 0 件)')

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true })
  fs.writeFileSync(OUT_PATH, JSON.stringify(fixture, null, 2) + '\n')
  say(`[extract-fixture] 書き出し完了: ${path.relative(process.cwd(), OUT_PATH)}`)
}

// この catch は main() 全体(引数解析・manifest 読込・redaction・fixture 書き出しの
// すべて)を対象にする(main() 側で個別に扱っていない例外は、ここで最終的に捕まる)。
// 以前は引数解析・manifest 操作・raw の初回読込が module 直下(この catch の外)にあり、
// そこで例外が起きると Node の既定の未捕捉例外ハンドラがスタックトレース(ソースの
// 絶対パスを含む)をそのまま stderr に出していた。main() へ一本化したことで、
// この経路で起こりうる例外はすべてここを通る。
main().catch((e) => {
  // e.stack はソースファイルの絶対パス(home ディレクトリ配下 = ユーザー名を含みうる)を、
  // e.message は fs エラー等で絶対パスをそのまま埋め込みうる。スタック全体は出さず、
  // redact() で home パス / ユーザー名 / repo 名 / branch 名を伏せたメッセージだけを出す。
  // sanitizeLogValue() も重ねて掛ける(redact() は識別子だけを見るため、万一メッセージに
  // 制御文字が混入していてもログ注入されないようにする多層防御)。
  const safeMessage = redact(sanitizeLogValue(String((e && e.message) || e)))
  warn(`[extract-fixture] 予期しないエラー: ${e && e.name ? e.name + ': ' : ''}${safeMessage}`)
  process.exit(1)
})
