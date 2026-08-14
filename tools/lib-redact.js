/**
 * tools/lib-redact.js — 実機録画に由来するテキストから個人環境情報を落とす共有関数。
 *
 * 録画は実機の画面そのものなので、承認枠の外の行に home パス(= ユーザー名)が写り込む。
 * 観測ツールの出力は `docs/` へ転記される前提なので、**画面由来のテキストを書き出す経路は
 * すべてこの関数を通す**(出口が 1 つでないと、後から足した出力箇所が素通りする)。
 *
 * **statusline も落とす対象に含める**。
 * Claude Code の statusline(モデル名 + rate limit 使用率 + リセット時刻)は承認枠の外の
 * chrome だが、選択肢行の直下に空行なく描画される個体があり、観測ツールの走査に拾われて
 * 個人の利用状況(モデル名・使用率・時刻)がそのまま出力へ混入していた。
 *
 * **リポ名 / ブランチ名も識別子として扱う**(公開 fixture の
 * decode で実残存を確認した続き)。タイトルバー(リポ名 / ブランチ名 / effort インジケータ)
 * は ①同一「論理行」に無関係な内容が \n なしで連結される個体があり、マーカー位置基準の
 * 単純なマスクだと前後を取り違える ②effort インジケータそのものが描画されない(部分再描画
 * で repo/branch だけが単独で流れる)個体があり、マーカーに頼る検出では原理的に拾えない、
 * の 2 系統の残存経路がある。後者への対処として、このリポジトリ自身のディレクトリ名と
 * git branch 名を(os.homedir() 由来の HOME_USER と同列の)「環境固有の識別子」として
 * 動的に取得し、マーカーの有無によらず地の文から機械的に除去する。
 *
 * **幅を保つ置換にする**: 観測ツールの出力は列位置(x=…)が意味を持つため、
 * 置換で文字数が変わると読み手が列を突き合わせられなくなる。NFKC 正規化は「照合専用」に
 * 限定し、実際のマスクは常に原文(未正規化)の該当範囲に対して行う(正規化で文字数が
 * 変わる全角文字を含む入力でも、redact() の出力は原文と同じ長さを保つ)。
 *
 * **UTF-16 長の保存 ≠ 表示幅の保存**: 全角(CJK 等)は
 * 1 UTF-16 unit で表示幅 2 列を占めるため、半角の 'x' へ置換すると unit 数は保たれても
 * 表示幅が縮み、@xterm/headless での再生がずれる。maskVisible() は East Asian Width の
 * 近似判定(charDisplayWidth())で全角には全角の伏せ字を、結合文字にはゼロ幅の詰め物を
 * 割り当て、UTF-16 unit 数と表示幅の両方を保つ。
 *
 * **識別子側も NFKC 正規化してから照合する**: findIdentifierRanges()
 * は haystack を NFKC 正規化してから探すため、識別子(HOME_USER / repo 名 / branch 名)が
 * 全角を含む場合は識別子側も同じ NFKC 規則で正規化しないと、正規化後の haystack と
 * 生の識別子文字列が一致しない(伏せ字漏れ)。
 */
'use strict'

const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const HOME_DIR = os.homedir()
const HOME_USER = HOME_DIR ? path.basename(HOME_DIR) : ''

// 複数トークンにまたがる地の文を組み立てる際、「見た目の隙間はあるが文字としては何も
// 無い」箇所(カーソル位置ジャンプ等、下記 ctrlTokenBreaksAdjacency 参照)に挿入する
// センチネル。Unicode の noncharacter(U+FFFF、正規の文字として割り当てられることが
// 無い符号位置)を使う = 実データと衝突しない。挿入箇所は maskIdentifiersAcrossTokens が
// トークン境界として認識した位置のみで、実際の出力文字列には決して含めない(owner が
// null のコードポイントとして扱われ、マスク適用の対象からも除外される)。
const SENTINEL = '￿'

// ユーザー名の文字の**間に**挟まっても人間には同じに見える文字。攻撃者(モデル / tool 出力)は
// 画面に任意の文字列を出せるので、`k oishi` や `k<ZWSP>oishi` のように 1 文字挟むだけで
// 単純な完全一致は外れる(実行で確認)。伏せ字はこの分断にも耐えるようにする。
// SENTINEL も許容する(トークン境界をまたいで分断されたユーザー名を拾うため)。
const SPLITTER = '[\\s"\'|\\u200B-\\u200D\\uFEFF\\u00AD\\uFFFF]*'
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 識別子は NFKC 正規化してから regex を組む(findIdentifierRanges の haystack が
// NFKC 正規化済みのため、識別子側が生のままだと全角を含む識別子で不一致になる)。
const HOME_USER_NFKC = HOME_USER ? HOME_USER.normalize('NFKC') : ''

// ユーザー名は 3 文字以上のときだけ分断耐性パターンを使う。短い名前(1-2 文字)で
// 任意文字の間に一致させると本文を壊すため(過剰マスクの方が害が大きい)。
const USER_LOOSE_RE =
  HOME_USER_NFKC && HOME_USER_NFKC.length >= 3
    ? new RegExp([...HOME_USER_NFKC].map(escapeRe).join(SPLITTER), 'g')
    : null

// POSIX home パス: /home/<user> /Users/<user>
// ユーザー名部分の
// 否定文字クラスに SENTINEL(U+FFFF)が含まれていなかったため、`/home/alice` の直後に
// カーソル位置ジャンプ(SENTINEL に変換されるトークン境界)を挟んで選択肢文言(例 "Yes")が
// 隙間なく連結描画される個体で "alice￿Yes" のように選択肢文言までユーザー名部分の一致に
// 巻き込まれ、過剰マスクで選択肢が消えていた。SPLITTER(ユーザー名の分断耐性パターン)は
// 既に SENTINEL を許容していたのに、home パス側の否定クラスだけ抜けていた。
const POSIX_HOME_PATH_RE = /(\/home\/|\/Users\/)([^/\s"'|\uFFFF]+)/g
// Windows home パス: C:\Users\<user>(ドライブ文字・"Users" とも大小文字無視)/
// \\<host>\Users\<user>(UNC 越しの home パス)。host 部は変更しない(共有名は本関数の
// 対象外 = 「home パス相当」に絞る)。host 部・ユーザー名部いずれの否定クラスにも
// SENTINEL を追加する(POSIX home パスと同じ理由、UNC host 部でも同型の過剰マスクが起こりうるため)。
// `i` フラグで大小文字を問わず一致させる("USERS" / "UseRs" 等、`[Uu]sers` の2択だけでは
// 拾えない表記も含める)。
//
// 既知の限界(未対処): この正規表現は生のバックスラッシュ区切り表記だけを見る。JSON へ
// シリアライズされた文字列(バックスラッシュが `\\\\` のように二重にエスケープされる)は
// 別の文字表現になるため一致しない。このリポジトリの実機録画(WSL/Linux 環境)7 fixture を
// decode して確認した限り、Windows home パスの出現自体が 0 件であり、この限界による実害は
// 確認されていない。
const WIN_HOME_PATH_RE = /((?:[A-Za-z]:|\\\\[^\\\s"'\uFFFF]+)\\[Uu]sers\\)([^\\/\s"'|\uFFFF]+)/gi

// WSL home path form: /mnt mount prefix + a single drive letter + the Windows Users
// directory. Only the "Users" literal folds case (matches [Uu][Ss][Ee][Rr][Ss]
// independently per letter); drive letter and name segment stay as-is, unlike
// WIN_HOME_PATH_RE which applies a blanket `i` flag. Name char class reused from
// POSIX_HOME_PATH_RE (same '/' separator convention).
const WSL_HOME_PATH_RE = /(\/mnt\/[A-Za-z]\/[Uu][Ss][Ee][Rr][Ss]\/)([^/\s"'|\uFFFF]+)/g

// ---- repo 名 / branch 名(HOME_USER と同列の「環境固有識別子」) ----
// tools/lib-redact.js は本番コード(claude-wrapper.js / approval-server.js)からは
// require されないツール専用モジュールのため、git への依存を許容する(取得失敗時は
// best-effort でリポ名のみになる。実行不能でも例外を投げてツール全体を止めない)。
const REPO_ROOT = path.resolve(__dirname, '..')
const REPO_NAME = path.basename(REPO_ROOT)

function listGitBranchesBestEffort() {
  try {
    const out = execFileSync('git', ['branch', '--format=%(refname:short)'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch (_) {
    return []
  }
}

// 各識別子を「英数字に挟まれていない完全一致」でのみ拾う(例: branch "main" は "domain" や
// "maintenance" の部分文字列には一致しない)。name/re をセットで持ち、検出側(用途:
// findRawIdentifierLeaks)でも同じ境界規則を再利用する(drift 防止)。短すぎる名前
// (1文字ブランチ等)は境界ガード付きでも誤爆リスクが上がるため除外する。識別子は
// NFKC 正規化してから regex を組む(name 自体は元の表示用に残す。エラーメッセージ等で
// 生の識別子を示すため)。
//
// **checkOverReplacement(過剰マスクの誤検知チェックの適用範囲を絞る)**: 各要素は文字列、または
// `{name, checkOverReplacement}` を渡せる。省略時(文字列指定時)は true。実機データで
// 確認した理由 = repo 名(ディレクトリ名)はタイトルバー以外の場所(例: MCP ツールの
// working-directory 表示 `/home/user/…/<repo>`)にも正当に出現し、そこは chrome 灰色では
// ない(bold 等、別のスタイルで描画される)。これは「一般的な語が偶然一致して正当な内容を
// 破壊する」という懸念とは異なる(repo 名は衝突しにくい固有文字列で、そこに出現しても
// 伏せること自体は正しい = home パス開示の一部)。checkOverReplacement が本来警戒する「よくある branch 名
// (main 等)が無関係な文脈に偶然出現する」ケースだけを対象にするため、branch 名側だけ
// checkOverReplacement: true(既定)、repo 名側は tools/extract-fixture.js が false を渡す。
function buildIdentifierPatterns(names) {
  const seen = new Set()
  const out = []
  for (const n of names) {
    const name = typeof n === 'string' ? n : n && n.name
    const checkOverReplacement = typeof n === 'string' ? true : !(n && n.checkOverReplacement === false)
    if (!name || name.length < 2 || seen.has(name)) continue
    seen.add(name)
    out.push({
      name,
      checkOverReplacement,
      re: new RegExp(`(?<![A-Za-z0-9])${escapeRe(name.normalize('NFKC'))}(?![A-Za-z0-9])`, 'g'),
    })
  }
  return out
}

// 既定値(dump-attrs.js 等、実機録画を直後に処理する経路が使う。「今チェックアウトされて
// いるブランチの生ログを直後に処理する」用途では、現在の git 状態 = 録画時の状態とみなせる
// リスクの低さのため、この既定は変更しない)。
//
// **fixture 生成パイプラインでは使わない**: この既定値は
// tools/extract-fixture.js の fixture 生成パイプラインには使わない。過去の録画を後から
// 再生する用途では「今の git 状態」が録画時と一致する保証が無く(ブランチ削除・
// detached HEAD・git 失敗等)、しかも同じ識別子集合を最終検査(findRawIdentifierLeaks)にも
// 使うため、識別子が欠けていても検査がすり抜ける(fail-open)。extract-fixture.js は
// 録画時点の repo/branch を docs/attr-manifest.json に固定記録し、setRepoIdentifiers() で
// この既定値を明示的に上書きしてから redaction を行う(git を一切呼ばない)。
let REPO_IDENTIFIER_PATTERNS = buildIdentifierPatterns([REPO_NAME, ...listGitBranchesBestEffort()])

/**
 * repo 名 / branch 名の識別子集合を明示的に差し替える。tools/extract-fixture.js が
 * docs/attr-manifest.json から読んだ固定値で呼ぶことを想定する。
 *
 * @param {Array<string|{name: string, checkOverReplacement?: boolean}>} names 識別子の配列
 *   (2文字未満は buildIdentifierPatterns() 内で無視される。checkOverReplacement の詳細は
 *   buildIdentifierPatterns() のコメント参照)
 */
function setRepoIdentifiers(names) {
  REPO_IDENTIFIER_PATTERNS = buildIdentifierPatterns(Array.isArray(names) ? names : [])
}

// ---- statusline 検出 ----
// 承認枠の構成要素には絶対に出ない固有マーカーで判定する(承認枠の罫線・ラベル・選択肢・
// tool 行のいずれにも 📒 / "manual mode on" / "↻ <時刻>" は現れない)。
const STATUSLINE_ICON = '📒'
// **実データから発見した事実**: この CLI は statusline の語同士の
// 間隔を、実際のスペース文字ではなく「カーソル横移動(CSI n G の列絶対指定)」で作る個体が
// ある(例: "manual" + CSI[12G] + "mode" + CSI[17G] + "on")。redactRawStream() の
// バイト列レベルの `joined` はカーソル移動を反映しないため、この個体では文字だけを連結すると
// "manualmodeon"(空白なし)になる。単純な `.includes('manual mode on')` はこれを検出できず、
// マスクされないまま生ストリームに残る(セル座標ベースの再生検査で実際に検出・反証確認)。
// ↻ + 時刻の判定(STATUSLINE_RESET_RE)が既に `\s*`(0個以上の空白)で同じ問題に耐性を
// 持っていたのに倣い、manual mode on も語間を `\s*` にした正規表現へ変更する。
const STATUSLINE_MANUAL_MODE_RE = /manual\s*mode\s*on/
const STATUSLINE_RESET_RE = /↻\s*\d/

/**
 * 対象文字列(1行)が Claude Code の statusline に由来するかを判定する。
 * dump-attrs.js の走査終端判定と、この redact() の行分類が同じ判定条件を共有する
 * (検出条件を2箇所に別々に持つと drift する)。
 *
 * @param {unknown} s 判定対象の1行
 * @returns {boolean}
 */
function isStatuslineText(s) {
  const t = String(s)
  return t.includes(STATUSLINE_ICON) || STATUSLINE_MANUAL_MODE_RE.test(t) || STATUSLINE_RESET_RE.test(t)
}

// ---- タイトルバー chrome 検出(第2段: 塞ぐ残存2種のうちの1つ) ----
// Claude Code のタイトルバー(リポ名 / ブランチ名 / effort インジケータ / スラッシュコマンド
// 表示)も承認枠の外の chrome で、選択肢行の直下ではなく**同一 y**に連結描画される個体がある。
// リポ名・ブランチ名そのものは可変で直接検出できないため、CLI が描画する固有マーカー
// (effort インジケータ ◉ / スラッシュコマンド区切り "· /" / スラッシュコマンド表示末尾
// "/effort")で判定する。判定述語はここ(string only)に置くが、実際に伏せる処理は
// run 境界の精密な位置決めが要るため、下の maskTitlebarRunsInText() が runs を受け取る形で
// 提供する(runs 自体の生成〔dumpRowAttrs〕は呼び出し側 dump-attrs.js の責務のまま)。
//
// **既知の限界**: これらのマーカーは effort インジケータが描画されているフレームでしか
// 現れない。部分再描画でタイトルバー行だけが(マーカーを伴わず)単独で流れる個体は、
// この述語では検出できない(redactRawStream() 側は REPO_IDENTIFIERS の直接除去で別途対処)。
const TITLEBAR_EFFORT_ICON = '◉'
const TITLEBAR_SLASH_SEP_RE = /·\s*\//
const TITLEBAR_EFFORT_SUFFIX_RE = /\/effort\b/

/**
 * 対象文字列(1行、または run 単体のテキスト)が Claude Code のタイトルバー chrome に
 * 由来するかを判定する。
 *
 * @param {unknown} s 判定対象
 * @returns {boolean}
 */
function isTitlebarChromeText(s) {
  const t = String(s)
  return t.includes(TITLEBAR_EFFORT_ICON) || TITLEBAR_SLASH_SEP_RE.test(t) || TITLEBAR_EFFORT_SUFFIX_RE.test(t)
}

/**
 * statusline / タイトルバーいずれかの chrome マーカーを含むか。dump-attrs.js の走査終端判定
 * と run フィルタが同じ判定条件を共有するための単一の入口(検出条件を複数箇所に別々に
 * 持つと drift する)。
 *
 * **既知の限界(過剰マスク、対処しない判断)**: この判定はマーカー文字列の存在だけを見る。
 * モデル出力や tool 出力が本文として "manual mode on" / "◉" / "· /" / "/effort" 等を
 * そのまま含めた場合、CLI chrome ではなく正当な内容であっても chrome 判定され、
 * redactRawStream() で丸ごと伏せられる(過剰マスク)。これは個人情報の漏洩ではなく
 * 観測ツールの完全性(見せるべき内容が消える)の問題であり、実データでは稀にしか
 * 起こらない。判定を緩めると chrome 検出そのものが弱まり漏洩リスクが増すトレードオフに
 * なるため、このモジュールでは対処せず記録に留める(マスク漏れの方を過剰マスクより
 * 重く見る方針、findRawIdentifierLeaks() のコメント参照)。
 *
 * @param {unknown} s 判定対象
 * @returns {boolean}
 */
function isChromeText(s) {
  return isStatuslineText(s) || isTitlebarChromeText(s)
}

/**
 * タイトルバー行内で、effort インジケータ系マーカー(◉ / "· /" / "/effort")のうち
 * もっとも手前にある位置を返す。1つも無ければ 0(=行頭、行全体が対象)を返す。
 *
 * @param {string} joined
 * @returns {number}
 */
function titlebarMarkerPos(joined) {
  const iEffort = joined.indexOf(TITLEBAR_EFFORT_ICON)
  const mSlash = TITLEBAR_SLASH_SEP_RE.exec(joined)
  const mSuffix = TITLEBAR_EFFORT_SUFFIX_RE.exec(joined)
  const candidates = [iEffort, mSlash ? mSlash.index : -1, mSuffix ? mSuffix.index : -1].filter((n) => n >= 0)
  return candidates.length ? Math.min(...candidates) : 0
}

// 混合行(選択肢行の直下に空行なく statusline が描画され、"❯ 1. Yes5 📒: 9% …" のように
// 同一行へ連結された個体)を見分けるための「選択肢らしさ」パターン。redact() が受け取る
// 行は `- y=17 cursor=true text="…"` のように整形済みの場合があるため行の絶対先頭には
// アンカーせず、statusline マーカーより手前の区間にこのパターンが現れるかで判定する。
// カーソル文字は claude-wrapper.js の CURSOR_CHARS(❯ / ›)の両方を見る(❯ のみだと
// › カーソルの個体で選択肢部分ごと誤って伏せる)。lib-redact.js は
// production を require しない設計のためハードコードするが、値自体は CURSOR_CHARS と
// 同一に保つ(drift させない)。
// `\d+\.\s` はドット直後に空白を要求する(モデル名 "gpt-5.6-sol" の "5." を選択肢番号の
// "1. " と誤認しないため)。dump-attrs.js 側の OPTION_START_RE(生の画面行に対する判定)は
// ドット直後の空白を要求しない非対称があるが、その行は isStatuslineText 一致が前提のため
// 実データでの誤爆リスクは無い(gpt-5.6-sol はカーソル文字/数字始まりでないため)。
const OPTION_MARK_RE = /[❯›]|>\s|\d+\.\s/

// ---- 表示幅(East Asian Width)を保つマスク ----
// CJK 等の全角文字は 1 UTF-16 unit で表示幅 2 列を占めるため、半角の 'x' 1 個へ置換すると
// UTF-16 unit 数は保たれても表示幅が縮み、@xterm/headless での再生位置がずれる。
// 専用ライブラリを追加せず、実務上出現しうる範囲
// (CJK 統合漢字・かな・カタカナ・ハングル・全角記号等。絵文字面は実測どおり
// 半角〔幅1〕として扱う、下記 charDisplayWidth() のコメント参照)を近似的にカバーする
// 簡易版を自前で持つ(未知の範囲は半角側〔幅1〕に倒す。個人情報の伏せ字自体の完全性は
// UTF-16 長の保存〔このモジュールの他の不変条件〕で別途担保されるため、幅判定の粒度は
// 「表示のズレをどこまで防ぐか」の問題に閉じる)。
const FULLWIDTH_MASK_CH = 'Ｘ' // U+FF38(全角ラテン大文字 X)。1 UTF-16 unit・表示幅2。
const ZERO_WIDTH_FILLER = '​' // ゼロ幅スペース。1 UTF-16 unit・表示幅0。

/**
 * コードポイント単位の表示幅を返す(0=結合文字等のゼロ幅、1=半角、2=全角)。
 *
 * **絵文字面は表示幅1として扱う(実測で修正)**: 当初は
 * 絵文字面(U+1F300-U+1FAFF)も表示幅2として扱っていたが、この @xterm/headless
 * (unicode11 等の追加 Unicode プロバイダを読み込まない既定設定)ではこの範囲は実測で
 * すべて表示幅1(半角相当)として描画される(📒 ⏸ 🔥 🚀 等、範囲の境界値含め
 * @xterm/headless の Terminal.write() → cell.getWidth() で直接確認済み。CJK 統合漢字・
 * ハングル・全角形は実測どおり表示幅2のまま変更なし)。この関数は「xterm が実際に描画する
 * 幅」に合わせることが目的のため、絵文字面を width-2 の対象から外す(未知の範囲・絵文字は
 * 半角側〔幅1〕に倒す、という元々の設計方針とも整合する)。
 *
 * **既知の限界(grapheme cluster 非対応)**: variation selector(U+FE00-FE0F)・
 * 結合文字・ZWJ で連結される複合絵文字は、xterm 自身も内部でグラフェムクラスタとして幅を
 * 合成する場合があり、この関数はコードポイント単位でしか判定しない(結合の結果を動的に見る
 * には @xterm/headless の Terminal に実際に書き込んで cell 幅を読み返す必要があり、この
 * 関数を非同期化する大きな設計変更になる)。この実機録画 7 fixture
 * (docs/attr-manifest.json#env-2026-08-10)の raw_pty を実測した限り、variation
 * selector・結合文字(U+0300-036F)・ZWJ 連結絵文字の出現は 0 件(絵文字面は単独
 * コードポイントのみ出現)。現時点でこの限界による実害は確認されていないが、将来これらを
 * 含む録画を fixture 化する場合は本関数の限界を踏まえて再検討すること。
 *
 * @param {number} cp
 * @returns {0|1|2}
 */
function charDisplayWidth(cp) {
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // 結合分音記号
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0xfeff // ZWSP/ZWNJ/ZWJ/BOM
  ) {
    return 0
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // ハングル字母
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首・記号
    (cp >= 0x3041 && cp <= 0x33ff) || // ひらがな・カタカナ・CJK 互換
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 拡張A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 統合漢字
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文字
    (cp >= 0xac00 && cp <= 0xd7a3) || // ハングル音節
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 互換漢字
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 互換形
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形(全角英数・記号)
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角記号
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 拡張B以降
  ) {
    return 2
  }
  return 1
}

/**
 * 幅保存の近似マスク。半角文字は 'x'、全角文字は表示幅2の 'Ｘ' へ置換して表示幅を保つ。
 * サロゲートペア(1コードポイントが2 UTF-16 unit)の全角文字は 'Ｘ' + ゼロ幅フィラーで
 * 埋め、UTF-16 unit 数を常に元と一致させる(呼び出し側 applyMaskedRanges の前提を維持)。
 */
function maskVisible(segment) {
  let out = ''
  for (const ch of segment) {
    const cp = ch.codePointAt(0)
    const w = charDisplayWidth(cp)
    const units = ch.length
    if (w === 2) {
      out += FULLWIDTH_MASK_CH + ZERO_WIDTH_FILLER.repeat(Math.max(0, units - 1))
    } else if (w === 0) {
      out += ZERO_WIDTH_FILLER.repeat(units)
    } else {
      out += 'x'.repeat(units)
    }
  }
  return out
}

/** statusline マスクを開始する行内インデックス。📒 を優先し、無ければ ↻+数字の位置。無ければ -1。 */
function statuslineSplitIndex(line) {
  const iIcon = line.indexOf(STATUSLINE_ICON)
  if (iIcon !== -1) return iIcon
  const m = STATUSLINE_RESET_RE.exec(line)
  return m ? m.index : -1
}

const LEADING_WS_RE = /^\s*/

/**
 * 1行分の statusline マスク(混合行 / 純行)。呼び出し時点で home パス / ユーザー名の
 * redaction は既に(行分割前に)完了している前提(redact() 参照)。
 */
function maskStatuslineInLine(line) {
  if (!isStatuslineText(line)) return line

  const splitIdx = statuslineSplitIndex(line)
  if (splitIdx !== -1 && OPTION_MARK_RE.test(line.slice(0, splitIdx))) {
    // 混合行: 選択肢部分(marker より手前)は残し、marker 以降だけ幅保存で伏せる。
    return line.slice(0, splitIdx) + maskVisible(line.slice(splitIdx))
  }
  // 純 statusline 行: 先頭インデントを除く可視部分を丸ごと伏せる(モデル名も含めて消す)。
  const indent = LEADING_WS_RE.exec(line)[0]
  return indent + maskVisible(line.slice(indent.length))
}

// ---- NFKC は「照合専用」: 原文の該当範囲だけを幅保存でマスクする共通基盤 ----
// 「正規化後テキストで見つけた一致範囲」を「原文のコードポイント範囲 → UTF-16 オフセット」
// へ機械的に写像する(照合は正規化後テキストに対して行うが、実際のマスクは常に原文
// 〔未正規化〕の該当範囲に対して行う、という設計)。
//
// **文字列全体としての prefix 正規化(旧実装の誤り訂正)**:
// 旧実装は「コードポイント単位で個別に normalize('NFKC') しても文字列全体を正規化した
// 結果と同じになる」という前提でコードポイントごとに個別へ normalize() していたが、これは
// 誤りだった。normalize() は結合文字の正準結合(例: "e" + 結合アキュート U+0301 →
// 合成済み "é")を隣接コードポイントとの関係で行うため、1 コードポイントずつ個別に
// normalize() すると、この結合が一切起こらない(単一コードポイントの normalize() は
// 互換分解のみで、結合は起こさない)。normalizedLength() ヘルパー(下記)で「prefix 全体を
// 毎回文字列全体として正規化する」ことでこれを正す。

/**
 * 共有ヘルパー: `prefix`(これまでに処理した原文の断片を連結した文字列)を文字列全体として
 * normalize('NFKC') した長さを返す。buildCodepointMap()(単一文字列)と
 * maskIdentifiersAcrossTokens()(複数トークン + SENTINEL 境界)の両方が、この関数を使って
 * 「prefix を毎回文字列全体として正規化する」ことで真の結合を反映する(2箇所に同じ技法を
 * 別々に持つと drift するため、ここへ集約する)。
 *
 * **プレフィックス正規化の安定性**: Unicode 正規化は「次の starter(結合クラス 0 の文字)に
 * 到達した時点で、それより前の文字列は以後どんな文字が続いても再正規化結果が変わらない」
 * という有界先読みの性質を持つ(ストリーミング正規化の標準的な前提)。この関数の呼び出し元
 * (ユーザー名 / home パス / repo 名 / branch 名 / 画面由来テキスト)は、結合文字列の途中で
 * 意図的に境界を作るような入力を想定しないため、prefix 単位の逐次 normalize() は文字列
 * 全体を一度に normalize() した結果と一致する(実行で確認済み)。SENTINEL(U+FFFF、非文字)
 * は正規化マッピングを持たないため、結合の firewall として安全に働く(実行で確認済み:
 * "e" + SENTINEL + 結合アキュートは合成されず3コードポイントのまま)。
 *
 * @param {string} prefix
 * @returns {number}
 */
function normalizedLength(prefix) {
  return prefix.normalize('NFKC').length
}

// 既知の限界(パフォーマンス、実データでは未対処のままでも実害なし): normalizedLength() は
// 「これまでの原文プレフィックス全体を毎回 normalize('NFKC') する」ため、入力長 N に対して
// 総コストは O(N^2) になる(buildCodepointMap() / maskIdentifiersAcrossTokens() の双方が
// この関数をループの中で呼ぶ)。このリポジトリの実 fixture 規模(1 フレームあたり数十KB)
// では実測 0.5ms/frame 程度で問題ない。以下の上限は「正しさ(結合文字の真の結合を検出する)を
// 保ったまま実装を軽量に保つ」トレードオフを維持しつつ、極端に大きい入力(将来の録画長の
// 伸長・意図しない巨大入力)で処理が実用外の時間を要する事態を、マスクを省略してごまかす
// のではなく処理そのものを止める形で防ぐガード(fail-close。中途半端にマスクされた出力を
// 返さない)。真の修正(インクリメンタル正規化への書き換え)はこのガードの範囲外。
const MAX_REDACT_INPUT_LEN = 2_000_000

/**
 * @param {number} len
 */
function assertRedactableLength(len) {
  if (len > MAX_REDACT_INPUT_LEN) {
    throw new Error(`redact 対象の入力が上限(${MAX_REDACT_INPUT_LEN} 文字)を超えている(${len} 文字)`)
  }
}

/**
 * 原文の各コードポイントについて、①原文内の UTF-16 開始オフセット ②NFKC 正規化後の
 * 文字列(文字列全体を一括で normalize() したもの) ③正規化後文字列中でそのコード
 * ポイントが占める範囲の終端オフセット、を並べた対応表を作る。
 *
 * @param {string} str
 * @returns {{ utf16Starts: number[], normalized: string, normOffsets: number[] }}
 *   utf16Starts / normOffsets はいずれも長さ (コードポイント数 + 1)。
 */
function buildCodepointMap(str) {
  const utf16Starts = []
  const normOffsets = [0]
  let pos = 0
  let prefix = ''
  for (const ch of str) {
    utf16Starts.push(pos)
    pos += ch.length
    prefix += ch
    normOffsets.push(normalizedLength(prefix))
  }
  utf16Starts.push(pos)
  return { utf16Starts, normalized: str.normalize('NFKC'), normOffsets }
}

/**
 * 正規化後テキストの範囲 [normStart, normEnd) に重なる原文コードポイント範囲
 * [charStart, charEnd) を求める(buildCodepointMap() の normOffsets を使う)。
 *
 * @param {number[]} normOffsets
 * @param {number} normStart
 * @param {number} normEnd
 * @returns {[number, number]}
 */
function mapNormRangeToChars(normOffsets, normStart, normEnd) {
  const n = normOffsets.length - 1
  let start = 0
  while (start < n && normOffsets[start + 1] <= normStart) start++
  let end = start
  while (end < n && normOffsets[end] < normEnd) end++
  return [start, end]
}

/**
 * 正規化後テキストから、ユーザー名 / home パス / repo 名 / branch 名の一致範囲を
 * すべて集める(マスクはしない。範囲を集めるだけ = 複数パターンの一致を後段でまとめて
 * 原文へ写像するため。順序依存で一致が壊れる問題〔後から掛けたパターンが、先のマスクで
 * 書き換え済みの文字列に対して不一致になる〕を、逐次置換ではなく一括写像にすることで
 * 構造的に無くす)。
 *
 * source は一致の由来(repo/branch 一致を home パス等と区別して chrome 文脈チェックに
 * 使うため)。'user' | 'home-path' | 'repo' のいずれか。
 *
 * @param {string} normalized
 * @returns {Array<{start: number, end: number, source: string}>}
 */
function findIdentifierRanges(normalized) {
  const ranges = []
  if (USER_LOOSE_RE) {
    USER_LOOSE_RE.lastIndex = 0
    let m
    while ((m = USER_LOOSE_RE.exec(normalized)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length, source: 'user' })
      if (m[0].length === 0) USER_LOOSE_RE.lastIndex++
    }
  } else if (HOME_USER_NFKC) {
    let idx = 0
    while ((idx = normalized.indexOf(HOME_USER_NFKC, idx)) !== -1) {
      ranges.push({ start: idx, end: idx + HOME_USER_NFKC.length, source: 'user' })
      idx += HOME_USER_NFKC.length
    }
  }
  for (const re of [POSIX_HOME_PATH_RE, WIN_HOME_PATH_RE, WSL_HOME_PATH_RE]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(normalized)) !== null) {
      const s = m.index + m[1].length
      ranges.push({ start: s, end: s + m[2].length, source: 'home-path' })
    }
  }
  for (const { re, checkOverReplacement } of REPO_IDENTIFIER_PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(normalized)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length, source: 'repo', checkOverReplacement })
    }
  }
  return ranges
}

/**
 * [start, end) 範囲の配列を昇順・重複結合してから、原文 s の該当範囲を幅保存でマスクする。
 *
 * @param {string} s
 * @param {Array<[number, number]>} ranges UTF-16 オフセットの範囲(s に対するもの)
 * @returns {string}
 */
function applyMaskedRanges(s, ranges) {
  if (ranges.length === 0) return s
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0])
  const merged = []
  for (const [s0, e0] of sorted) {
    const last = merged[merged.length - 1]
    if (last && s0 <= last[1]) last[1] = Math.max(last[1], e0)
    else merged.push([s0, e0])
  }
  let out = ''
  let cursor = 0
  for (const [s0, e0] of merged) {
    out += s.slice(cursor, s0)
    out += maskVisible(s.slice(s0, e0))
    cursor = e0
  }
  out += s.slice(cursor)
  return out
}

/**
 * 単一文字列からユーザー名 / home パス / repo 名 / branch 名を、原文の長さを保ったまま
 * マスクする(redact() の識別子マスク・redactRawStream() の OSC body マスクが共有する処理。
 * 3 箇所に同じ置換ロジックをコピペしない = drift 防止)。
 *
 * NFKC 正規化は照合にのみ使う(normalize() で文字数が変わりうるため、出力をそのまま返すと
 * 列位置の対応が崩れる。原文の該当範囲だけを幅保存で伏せることで、この関数の出力は常に
 * 入力と同じ UTF-16 長を保つ)。
 *
 * @param {unknown} str
 * @returns {string}
 */
function maskIdentifiersInString(str) {
  const s = String(str)
  if (!s) return s
  assertRedactableLength(s.length)
  const { utf16Starts, normalized, normOffsets } = buildCodepointMap(s)
  const ranges = findIdentifierRanges(normalized)
  if (ranges.length === 0) return s
  const utf16Ranges = ranges.map(({ start, end }) => {
    const [cpStart, cpEnd] = mapNormRangeToChars(normOffsets, start, end)
    return [utf16Starts[cpStart], utf16Starts[cpEnd]]
  })
  return applyMaskedRanges(s, utf16Ranges)
}

/**
 * 画面由来テキストから個人環境情報を伏せる。
 *
 * **保証の範囲**: これは公開物への**事故的な混入**を防ぐ衛生措置であって、
 * 画面内容を制御できる相手に対する保証ではない。全角化・同形異字・分割表示など、
 * 「人間には同じに見えるが文字列としては別物」の形は原理的に拾いきれない。
 * 公開前の目視 / grep を置き換えるものではない。
 *
 * @param {unknown} s 画面由来のテキスト(文字列以外は String() で変換する)
 * @returns {string} 個人環境情報を伏せた文字列
 */
function redact(s) {
  let t = String(s)
  if (!t) return t
  // ユーザー名 / home パス / repo 名 / branch 名のマスクは maskIdentifiersInString() に
  // 委譲する(redactRawStream() の OSC body マスクと共有)。NFKC は照合専用のため、この
  // 呼び出しの前後で t の長さは変わらない(改行をまたいだ一致も一括で検出できるため、
  // 行分割の**前**に全体へ一度だけ掛ける。行分割してから掛けると、ユーザー名が実改行で
  // 分断されている個体を取りこぼす〔実行で確認した回帰〕)。
  t = maskIdentifiersInString(t)
  // statusline(混合行 / 純行)の判定・伏せ方は行ごとに異なるため、ここから行単位で処理する。
  return t.includes('\n') ? t.split('\n').map(maskStatuslineInLine).join('\n') : maskStatuslineInLine(t)
}

/** 配列の各要素へ redact を掛ける(画面プレビュー行の配列など)。 */
function redactLines(lines) {
  return Array.isArray(lines) ? lines.map(redact) : lines
}

// ---- 生 PTY ストリーム(ANSI エスケープ混じり)専用の redaction ----
// tools/extract-fixture.js が fixture 化する `raw_pty` はこの後 @xterm/headless に
// **再生**される。redact()(既定)を生ストリームへそのまま適用すると 2 つの問題がある:
//   ①NFKC 正規化が文字数を変える(例: 省略記号 U+2026 "…" → "..." で 1→3 文字)。
//     CHUNK 分割(lib-cellattrs.replayFrames)は文字インデックス基準なので、文字数が
//     変わると redaction 前後でチャンク境界(= フレーム番号)がずれる。
//   ②行単位のマスク(maskStatuslineInLine)は「マーカー位置から行末までを丸ごと 'x' に
//     置換する」設計で、**レンダリング後のテキスト**(エスケープ列を含まない)を前提にしている。
//     生ストリームの 1 "行"(改行文字区切り)は 1 端末行の描画に対応するとは限らず、
//     カーソル位置指定(CSI …G 等)や色指定(SGR)が印字文字の間に大量に挟まる。
//     そこを単純に 'x' で埋めると **カーソル位置指定シーケンスごと潰れ**、以後の描画位置が
//     崩れる(実測: 1 箇所のマスクで表示領域が 10 行ずれた)。
//
// 対策 = **エスケープ列(制御トークン)は 1 バイトも変更せず、印字文字トークンだけを
// 'x' に置換する**。エスケープが実行するカーソル移動・色指定はそのまま残るため、
// 置換後も端末上の列消費・折返しは変化しない(印字文字トークンの文字数だけを保つため)。

// CSI(`ESC [ params intermediates final`)/ OSC(`ESC ] ... BEL|ST`)/ 単純エスケープ
// (`ESC` + 1 文字、charset 切替等)/ C0 制御文字(改行以外)をまとめて「制御トークン」とする。
// 改行 \n は行区切り(chrome 判定の単位)として別に扱うため、このトークンには含めない。
const ANSI_TOKEN_RE =
  /(\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-9;:<=>?]*[ -/]*[@-~]|\x1b[0-9A-Za-z()#][0-9A-Za-z]?|[\x00-\x09\x0b-\x1f\x7f])/g

// 既知の限界(未対処): ANSI_TOKEN_RE は CSI / OSC(開始〜終端子までの単位)/ 単純エスケープ
// (1文字)/ C0 制御文字をトークン化するが、DCS(ESC P … ST)/ APC(ESC _ … ST)/
// PM(ESC ^ … ST)/ SOS(ESC X … ST)は OSC と同じ「開始〜終端子までを1トークン」としては
// 扱わない(ECMA-48 の全シーケンス種別をカバーする完全な状態機械ではない)。これらが出現
// すると、開始のエスケープだけが単純エスケープとして切り出され、本体は後続の text トークン
// として扱われる(本体中の識別子自体は maskIdentifiersAcrossTokens が通常の text と同様に
// 検出・マスクするが、@xterm/headless がこれらのシーケンスを画面セルとして描画しない場合、
// tools/extract-fixture.js のセル座標ベースの再検査は本体の内容を見ない = 独立防御の
// 片方が効かない構成になる)。同様に、バッファの終端までに終端子(BEL/ST)へ到達しない
// OSC(切断された OSC)も、OSC_BODY_RE が閉じた形しか一致させないため body マスクの対象外
// になる。このリポジトリの実機録画 7 fixture(docs/attr-manifest.json#env-2026-08-10)を
// decode して確認した限り、これらのシーケンス種別・切断 OSC の出現は 0 件。完全な
// ECMA-48 状態機械への拡張は大きな設計変更になるため、現時点では対応せず記録に留める。

/**
 * 文字列をトークン列へ分割する。ctrl トークン(エスケープ列 / \n 以外の C0 制御文字。
 * 単独の \r もここに含まれる)はそのまま、それ以外は連続する印字文字を 1 つの text
 * トークンにまとめる。`\n` は type: 'nl' の独立トークンにする(chrome マスクの行区切りに
 * 使うため)。
 *
 * @param {string} s
 * @returns {Array<{type: 'text'|'ctrl'|'nl', value: string}>}
 */
function tokenizeAnsi(s) {
  const tokens = []
  let lastIndex = 0
  ANSI_TOKEN_RE.lastIndex = 0
  let m
  const pushText = (str) => {
    // text トークンをさらに \n で分割し、\n は独立の nl トークンにする。
    const parts = str.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]) tokens.push({ type: 'text', value: parts[i] })
      if (i < parts.length - 1) tokens.push({ type: 'nl', value: '\n' })
    }
  }
  while ((m = ANSI_TOKEN_RE.exec(s)) !== null) {
    if (m.index > lastIndex) pushText(s.slice(lastIndex, m.index))
    tokens.push({ type: 'ctrl', value: m[0] })
    lastIndex = ANSI_TOKEN_RE.lastIndex
  }
  if (lastIndex < s.length) pushText(s.slice(lastIndex))
  return tokens
}

// SGR(色・装飾指定、`ESC [ ... m`)とカーソル表示 / 同期更新の on-off トグルは、印字位置を
// 動かさない制御シーケンスなので、これを挟んで隣り合う text トークンは「見た目でも隙間の
// 無い連結」とみなして地の文の結合を許す(SGR に分断されたユーザー名 "al" + SGR + "ice"
// を "alice" として検出するための橋渡し)。
const SOFT_CTRL_RE = /^\x1b\[[0-9;:<=>?]*m$/
const CURSOR_TOGGLE_RE = /^\x1b\[\?(?:25|2026)[hl]$/

/**
 * ctrl トークンが「隣接する text トークンを地の文として連結してよいか」を判定する。
 * true を返す(= 境界を作る)のは、カーソル位置ジャンプ・行消去等、印字位置に隙間を
 * 生む制御シーケンス。実データでは列位置ジャンプ(`CSI ...G` 等)が空白 1 文字も無いまま
 * 無関係な文字列同士(例: ブランチ名の直後に来る "ctrl+g to edit" ヒント文)を隣接させて
 * しまい、識別子の境界判定(英数字に挟まれていないか)を誤らせる実例が見つかったため、
 * それ以外の制御シーケンスはすべて安全側(= 境界あり)として扱う。
 *
 * @param {string} value ctrl トークンの値
 * @returns {boolean}
 */
function ctrlTokenBreaksAdjacency(value) {
  if (SOFT_CTRL_RE.test(value)) return false
  if (CURSOR_TOGGLE_RE.test(value)) return false
  return true
}

// ---- SGR の前景色から「chrome(タイトルバー/statusline)色で描画された
// text トークン」を追跡する ----
// 実機録画で確認した事実: Claude Code の statusline / タイトルバーは常に
// `ESC[38;2;153;153;153m`(truecolor rgb(153,153,153) の淡灰色)で描画される
// (docs/attr-dump-*.md の実測 fg=rgb:10066329 = 0x999999 と一致)。選択肢のカーソル文字列は
// 別の色(実測 fg=rgb:11647481)で描画されるため、「今の前景色が chrome 灰色かどうか」を
// SGR ctrl トークンだけを見て追跡すれば、印字文字を伴わない列ジャンプに頼らず
// 「マーカーの手前に直接連結された同色の chrome 文字列」を同定できる。
//
// **既知の限界**: 灰色(0x999999)は chrome 専用の色ではなく、選択肢番号("1.")や
// ● bullet にも使われる(実測)。そのため本追跡だけを「これは chrome/これは違う」の
// 確定判定には使わない。マスク精度向上(maskLogicalLine のカット位置をマーカーの
// 直前まで連続する同色 text トークンへ遡って広げる、下記 extendCutBackwardThroughChromeGray)
// にのみ使い、選択肢部分と地続きでない(= 別の色を経由しない限り遡らない)ため、
// 番号"1."のような chrome 色だが選択肢に属す text までは決して食い込まない
// (選択肢ラベル自体の色〔chrome 灰色ではない〕が遮断の役割を果たす)。
// それでも取りこぼる余地(逆に取り過ぎる余地)は tools/extract-fixture.js 側の
// 再生ベースの fail-close 検査(セル座標ベース)が最終防御として補う。
const SGR_PARAMS_RE = /^\x1b\[([0-9;]*)m$/
const CHROME_GRAY_RGB = [153, 153, 153]

function parseSgrParams(paramsStr) {
  if (paramsStr === '') return []
  return paramsStr.split(';').map((p) => (p === '' ? 0 : Number(p)))
}

/**
 * SGR パラメータ列(`ESC[<params>m` の `<params>`)を順に読み、前景色の変化だけを判定する。
 * bold/dim/underline 等、前景色に無関係なパラメータは無視する(状態を変えない)。
 *
 * @param {string} paramsStr
 * @returns {{resets: boolean, setsChromeGray: boolean, setsOtherFg: boolean}}
 */
function classifySgrFgChange(paramsStr) {
  if (paramsStr === '') return { resets: true, setsChromeGray: false, setsOtherFg: false }
  const nums = parseSgrParams(paramsStr)
  let result = { resets: false, setsChromeGray: false, setsOtherFg: false }
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i]
    if (n === 0) {
      result = { resets: true, setsChromeGray: false, setsOtherFg: false }
    } else if (n === 39) {
      result = { resets: false, setsChromeGray: false, setsOtherFg: true }
    } else if (n === 38 && nums[i + 1] === 2) {
      const isGray = nums[i + 2] === CHROME_GRAY_RGB[0] && nums[i + 3] === CHROME_GRAY_RGB[1] && nums[i + 4] === CHROME_GRAY_RGB[2]
      result = { resets: false, setsChromeGray: isGray, setsOtherFg: !isGray }
      i += 4
    } else if (n === 38 && nums[i + 1] === 5) {
      result = { resets: false, setsChromeGray: false, setsOtherFg: true }
      i += 2
    } else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) {
      result = { resets: false, setsChromeGray: false, setsOtherFg: true }
    }
    // 他の SGR コード(bold=1 / dim=2 / underline=4 等)は前景色を変えない → result 据え置き
  }
  return result
}

/**
 * tokens 配列(tokenizeAnsi の出力)を順に読み、各 text トークンが「chrome 灰色
 * (rgb(153,153,153))の前景色で描画されたか」を示す真偽値配列を返す(tokens と同じ長さ、
 * text 以外のインデックスは無意味な false)。1 つの text トークンの中で SGR が変わることは
 * 無い(SGR は必ず別の ctrl トークンとして分離される、tokenizeAnsi の設計上)ため、
 * トークン単位の真偽値で十分。改行(nl)をまたいで色状態を引き継がない(実データで
 * 新しい行の chrome 出力は毎回自前で色指定し直す個体しか確認していない。安全側)。
 *
 * @param {Array<{type: string, value: string}>} tokens
 * @returns {boolean[]}
 */
function computeChromeGrayTokenFlags(tokens) {
  const flags = new Array(tokens.length).fill(false)
  let active = false
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.type === 'ctrl') {
      const m = SGR_PARAMS_RE.exec(tok.value)
      if (m) {
        const c = classifySgrFgChange(m[1])
        if (c.resets || c.setsOtherFg) active = false
        else if (c.setsChromeGray) active = true
      }
    } else if (tok.type === 'text') {
      flags[i] = active
    } else if (tok.type === 'nl') {
      active = false
    }
  }
  return flags
}

/**
 * text トークンだけを対象に、複数トークンにまたがって分断された識別子(ユーザー名 / home
 * パス / repo 名 / branch 名)を検出してマスクする(redactRawStream() のトークン配列を
 * 直接書き換える。破壊的)。
 *
 * トークン単位で個別にマスクすると、SGR 等の制御トークンで識別子が分断された個体
 * (例: "koi" + SGR + "shi")を取りこぼす(各フラグメント単体では一致しない。
 * findRawIdentifierLeaks() は stripControlTokensToText() で検出できるが、従来のマスク側は
 * 同じ手当てをしていなかった)。この関数は「対象トークンを連結した地の文」に対して
 * 一括で検索し、一致範囲をトークン境界をまたいで元のトークンへ書き戻すことでこれを塞ぐ。
 *
 * ただし、すべてのトークン境界を無条件に連結すると別の問題が起きる: カーソル位置ジャンプ
 * (印字文字を伴わない空白の代わり)を挟んで無関係な内容が直接隣り合ってしまい、
 * repo 名 / branch 名の境界ガード付き一致(英数字に挟まれていないことを要求する)が
 * 誤って不一致になる(実データで確認: ブランチ名の直後に "ctrl+g to edit" ヒントが
 * 隙間なく連結され、"...channel" の直後が "c"(ctrl の先頭)になっていた)。
 * ctrlTokenBreaksAdjacency() が「境界あり」と判定したトークンの位置には SENTINEL を
 * 1 つ挟み、地の文の上でも境界として機能させる。
 *
 * 過剰マスクの誤検知チェック: repo/branch 識別子(例: よくあるブランチ名
 * "main")は、承認コマンドや選択肢の地の文に偶然含まれても置換されうる(過剰マスクで
 * 正当な内容を破壊する)。chromeGrayTokenFlags(computeChromeGrayTokenFlags 参照)を使い、
 * repo/branch 一致がタイトルバーの chrome 色の**外**で起きた場合は diagnostics に記録する
 * (呼び出し側 redactRawStream が fixture 生成の fail-close 判断に使う。マスク自体は
 * 引き続き行う = 漏洩を優先して防ぐ側に倒す。「検出したら生成を止める」の判断は
 * tools/extract-fixture.js 側)。
 *
 * @param {Array<{type: string, value: string}>} tokens
 * @param {boolean[]} [chromeGrayTokenFlags] computeChromeGrayTokenFlags(tokens) の結果
 * @param {{overReplacements: Array<object>}} [diagnostics] 過剰置換の検出結果の書き出し先
 * @returns {void}
 */
function maskIdentifiersAcrossTokens(tokens, chromeGrayTokenFlags, diagnostics) {
  let totalTextLen = 0
  for (const tok of tokens) if (tok.type === 'text') totalTextLen += tok.value.length
  assertRedactableLength(totalTextLen)
  const owner = []
  // 個別コードポイントを ch.normalize('NFKC') で逐次連結するのではなく、
  // 「これまでの原文(rawConcat)を毎回まるごと正規化した長さ」を記録する
  // (normalizedLength() = buildCodepointMap() と共有する技法、コメントはそちら参照)。
  let rawConcat = ''
  const normOffsets = [0]
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.type === 'text') {
      let local = 0
      for (const ch of tok.value) {
        owner.push({ tokenIdx: i, utf16Start: local, utf16End: local + ch.length })
        local += ch.length
        rawConcat += ch
        normOffsets.push(normalizedLength(rawConcat))
      }
    } else if (tok.type === 'nl' || (tok.type === 'ctrl' && ctrlTokenBreaksAdjacency(tok.value))) {
      owner.push(null) // どのトークンにも属さない(マスク適用の対象外)= 境界そのもの
      rawConcat += SENTINEL
      normOffsets.push(normalizedLength(rawConcat))
    }
  }
  if (owner.length === 0) return

  const normalized = rawConcat.normalize('NFKC')
  const ranges = findIdentifierRanges(normalized)
  if (ranges.length === 0) return

  const perToken = new Map()
  for (const { start: ns, end: ne, source, checkOverReplacement } of ranges) {
    const [cpStart, cpEnd] = mapNormRangeToChars(normOffsets, ns, ne)
    if (source === 'repo' && checkOverReplacement && diagnostics && chromeGrayTokenFlags) {
      let anyOwner = false
      let allChromeGray = true
      for (let k = cpStart; k < cpEnd; k++) {
        const o = owner[k]
        if (!o) continue
        anyOwner = true
        if (!chromeGrayTokenFlags[o.tokenIdx]) {
          allChromeGray = false
          break
        }
      }
      if (anyOwner && !allChromeGray) {
        diagnostics.overReplacements.push({
          normalizedRange: [ns, ne],
          reason: 'repo/branch 識別子が chrome(タイトルバー)色の外で一致した(過剰置換の疑い)',
        })
      }
    }
    for (let k = cpStart; k < cpEnd; k++) {
      const o = owner[k]
      if (!o) continue
      if (!perToken.has(o.tokenIdx)) perToken.set(o.tokenIdx, [])
      perToken.get(o.tokenIdx).push([o.utf16Start, o.utf16End])
    }
  }
  for (const [tokenIdx, spans] of perToken) {
    tokens[tokenIdx].value = applyMaskedRanges(tokens[tokenIdx].value, spans)
  }
}

// OSC(`ESC ] body BEL|ST`)の body 部分を抜き出す。file:// hyperlink(OSC 8)等、body
// 自体が個人パスを含みうるため、ctrl トークンとして丸ごと素通りさせず body だけ潰す。
const OSC_BODY_RE = /^(\x1b\])([\s\S]*?)(\x07|\x1b\\)$/

/**
 * 生 PTY ストリーム(ANSI エスケープ混じり)から個人環境情報を、エスケープ列を一切
 * 変更せずに伏せる。redact() と目的は同じ(home パス / ユーザー名 / repo 名 / branch 名 /
 * statusline / タイトルバー chrome を隠す)だが、適用対象が「レンダリング後のテキスト」
 * ではなく「@xterm/headless に再生する生バイト列」である点が異なる(上記コメント参照)。
 *
 * **保証の範囲は redact() と同じ**(事故的混入の衛生措置。全角ホモグリフ等は拾いきれない)。
 * 呼び出し側(tools/extract-fixture.js)は redaction 後に findRawIdentifierLeaks() で
 * 素の文字列一致を独立に再確認すること(多層防御。エスケープによる分断で per-token マスクを
 * すり抜けたケースも stripControlTokensToText() 経由で検出する)。
 *
 * repo/branch 識別子は setRepoIdentifiers() で明示的に設定された値のみを使う
 * (tools/extract-fixture.js が docs/attr-manifest.json の固定値で呼ぶ想定)。
 *
 * @param {unknown} s 生 PTY ストリーム文字列
 * @param {{overReplacements: Array<object>}} [diagnostics] 呼び出し側が渡すと、
 *   repo/branch 識別子が chrome 色の外で一致した(過剰置換の疑いがある)件数を
 *   `diagnostics.overReplacements` に書き出す(省略時は診断を行わない)。
 * @returns {string} 個人環境情報を伏せた生 PTY ストリーム文字列(長さは常に不変)
 */
function redactRawStream(s, diagnostics) {
  const t = String(s)
  if (!t) return t
  assertRedactableLength(t.length)
  const tokens = tokenizeAnsi(t)
  if (diagnostics && !Array.isArray(diagnostics.overReplacements)) diagnostics.overReplacements = []
  // 選択肢混在行のマスク精度向上と過剰置換チェックの両方で使う: 各 text トークンが chrome 灰色(rgb(153,153,153))で描画されたかの
  // 追跡(computeChromeGrayTokenFlags のコメント参照)。
  const chromeGrayTokenFlags = computeChromeGrayTokenFlags(tokens)

  // 1. ユーザー名 / home パス / repo 名 / branch 名を、トークン境界をまたいで検出・マスクする
  //    (制御トークンに挟まれた分断も、地の文を連結してから検索するため取りこぼさない)。
  maskIdentifiersAcrossTokens(tokens, chromeGrayTokenFlags, diagnostics)

  // 1b. OSC の body(`ESC ] ... BEL|ST` の `...` 部分)も同様にマスクする。OSC 8
  //     ハイパーリンク(`ESC]8;id=…;file:///home/user/…BEL`)は URI がパラメータとして
  //     エスケープシーケンスの中に入るため、text トークンにならず 1. を素通りする
  //     (実測で発見: Plan 参照リンクの file:// URI が home パスをそのまま含んでいた)。
  //     BEL/ST の終端子自体は変更しない(OSC の構文を壊さない)。OSC body は 1 つの
  //     エスケープシーケンス内で完結し、実測でも分断は見られないため単一文字列として扱う。
  //
  //     **OSC body は識別子だけでなく丸ごとマスクする**: 当初は
  //     識別子(maskIdentifiersInString)だけをマスクしていたが、OSC body(ウィンドウ/タブ
  //     タイトル設定等)には statusline/タイトルバーの chrome マーカー(例:
  //     `ESC]0;📒 usage=77%BEL`)が含まれうる。OSC body は画面セルとして描画されない
  //     (production の parseDialog / dialog 判定はいずれも「画面に描画されたセル」だけを
  //     見るため、OSC body は判定に一切影響しない)ため、識別子かどうかを個別に判定せず
  //     内容を丸ごとマスクしてよい。個別の識別子/マーカー検出条件に依存させないことで、
  //     将来 OSC 経由で別の chrome/秘密情報が混入する余地自体を構造的に塞ぐ(検出条件の
  //     抜けに依存する経路をそもそも作らない)。
  for (const tok of tokens) {
    if (tok.type !== 'ctrl') continue
    const m = OSC_BODY_RE.exec(tok.value)
    if (!m) continue
    tok.value = m[1] + maskVisible(m[2]) + m[3]
  }

  // 2. statusline / タイトルバー chrome を「実際の描画行」単位でマスクする。
  //    改行 \n だけでなく、単独の \r(復帰)も行区切りとして扱う。この CLI は部分再描画で
  //    「\r + 相対カーソル移動」を使い、複数の画面行が \n を挟まずに 1 つの塊として
  //    書き込まれることがある(実測: 履歴表示・警告文・タイトルバー・statusline が \n
  //    なしで連結された 900 文字超のバーストが実在した)。\n だけを区切りにすると、
  //    その塊全体が「1 論理行」になってしまい、
  //      ①マーカーの手前にある無関係な行の内容までマーカー位置基準で伏せてしまう
  //      ②逆にタイトルバー行自体は「マーカーより手前」にあるリポ名・ブランチ名が
  //        伏せられずに残る(公開 fixture の decode で実残存を確認)
  //    の 2 つの問題が起きる。\r も区切りに含めると、この CLI の実際の描画行とほぼ一致する
  //    粒度になり、両方解消する(\r 自体は ctrl トークンなので値は変更しない。区切りとして
  //    使うだけ)。
  //
  //    **復帰(\r)を伴わない画面行切替も行区切りに含める**: \r/\n に加えて、印字文字を伴わず画面行を
  //    切り替える制御コードをすべて行区切りに含める。これらは復帰(\r)を伴わずに別の画面行へ
  //    移ることがあり、含めないと無関係な複数行が 1 つの「論理行」として扱われ、マーカー基準の
  //    カット位置が誤って計算される(chrome マーカーが実際とは異なる行の内容と混ざる)。
  //
  //    **行境界として扱う制御コードの範囲**: CSI A/B/H/f/d/e に加えて、CSI E/F(次/前の
  //    行の先頭へ)・単純エスケープ D/E/M(IND/NEL/RI)・C0 の VT(0x0b)/FF(0x0c、いずれも
  //    LF 相当の行送り)も含める。これらは「印字文字を伴わず画面行を切り替える」点で
  //    A/B 等と同じであるため、行境界の判定に含める。
  //
  //    **H/f(絶対位置指定)は「同一行への移動」でも常に境界とみなす(既知の制限)**: 本関数は
  //    バイト列トークンだけを見ており、xterm のようなカーソル行の継続的な追跡状態を持たない。
  //    H/f が実際に「今の行」と同じ行を指しているかを判定するには、A/B/CSI E/F/VT/FF/
  //    IND/NEL/RI 等のあらゆる相対移動を合算した現在行を独立に追跡する必要があり、これは
  //    xterm 相当の実装を再構築するに等しい複雑さ・バグ混入リスクを持ち込む(この関数の
  //    設計方針 = バイト列だけを見る軽量実装、から外れる)。過剰分割(必要以上に細切れの
  //    論理行にする)の実害は chrome 判定/マーカー基準マスクの粒度が過度に細かくなることに
  //    留まる。識別子(ユーザー名/home パス/repo名/branch名)のマスクは
  //    maskIdentifiersAcrossTokens によるトークン全体を対象にしたグローバル走査、および
  //    findRawIdentifierLeaks の stripControlTokensToText 再検査という、行区切りに依存しない
  //    別系統の多層防御が個人情報漏洩自体は独立に塞ぐため、この既知の限界は許容し、常に
  //    境界とみなす現状の判定を維持する。
  const CSI_VERTICAL_MOVE_RE = /^\x1b\[[0-9;]*[ABEFHfde]$/
  // IND(D)/NEL(E)/RI(M)。ANSI_TOKEN_RE の `\x1b[0-9A-Za-z()#][0-9A-Za-z]?` は次の1文字が
  // 英数字なら巻き込むことがあるため、末尾1文字の有無どちらでも一致するようにする
  // (トークナイザ側の既存の曖昧さに対応するだけで、トークナイザ自体は変更しない)。
  const ESC_SINGLE_ROW_MOVE_RE = /^\x1b[DEM][0-9A-Za-z]?$/
  const isRowBoundary = (tok) =>
    tok.type === 'nl' ||
    (tok.type === 'ctrl' &&
      (tok.value === '\r' ||
        tok.value === '\x0b' || // VT(垂直タブ、LF 相当の行送り)
        tok.value === '\x0c' || // FF(改ページ、LF 相当の行送り)
        CSI_VERTICAL_MOVE_RE.test(tok.value) ||
        ESC_SINGLE_ROW_MOVE_RE.test(tok.value)))

  /**
   * マーカー(📒/↻ 等)の直前に、\r/\n や
   * OPTION_MARK_RE 境界を挟まずに直接連結された chrome 灰色の text トークンがあれば、
   * カット位置をその先頭まで遡って広げる(選択肢ラベルの直後に間隔なく統計値が連結描画
   * される個体で、マーカー基準カットだけでは「マーカーより手前」に分類されてしまう
   * 統計値〔モデル名・使用率等〕が残る問題への対処)。選択肢ラベル自体は chrome 灰色とは
   * 別の色で描画されるため、色が変わった時点で遡りを止める(選択肢の文字までは食い込まない)。
   *
   * @param {Array<{i: number, from: number, to: number}>} textIdxs joined 内での出現順
   * @param {number} cut 現在のカット位置(joined 内オフセット)
   * @returns {number} 遡って広げた後のカット位置
   */
  function extendCutBackwardThroughChromeGray(textIdxs, cut) {
    let newCut = cut
    // cut が
    // 「トークンの途中」にある場合(マーカー自身がトークン先頭ではない個体、例えば
    // "Claude 77% 📒" が分割されず 1 トークンのままの場合)、旧実装は下の遡りループが
    // このトークンを `to > newCut` で常にスキップし、トークン内でマーカーより手前にある
    // 地の文("Claude 77% ")を一切遡れなかった(同一 token 前置の取りこぼし)。遡り
    // ループへ入る前に、cut を含む text トークン自身が chrome 灰色かを確認し、灰色なら
    // まずそのトークンの先頭まで cut を戻す。
    for (const tIdx of textIdxs) {
      if (tIdx.from <= newCut && newCut < tIdx.to) {
        if (chromeGrayTokenFlags[tIdx.i]) newCut = tIdx.from
        break
      }
    }
    for (let k = textIdxs.length - 1; k >= 0; k--) {
      const tIdx = textIdxs[k]
      if (tIdx.to > newCut) continue // マーカー自身を含む text トークン等、まだ手前ではない
      if (tIdx.to !== newCut) break // 隣接していない(cut が token の途中にある)= 遡り終了
      if (!chromeGrayTokenFlags[tIdx.i]) break // chrome 灰色でない token に達した = 選択肢本体
      newCut = tIdx.from
    }
    return newCut
  }

  const maskLogicalLine = (start, end) => {
    const textIdxs = []
    let joined = ''
    for (let i = start; i < end; i++) {
      if (tokens[i].type === 'text') {
        textIdxs.push({ i, from: joined.length, to: joined.length + tokens[i].value.length })
        joined += tokens[i].value
      }
    }
    if (!isChromeText(joined)) return
    const splitIdx = statuslineSplitIndex(joined)
    const isTitlebar = isTitlebarChromeText(joined)
    let cut
    if (splitIdx !== -1 && OPTION_MARK_RE.test(joined.slice(0, splitIdx))) {
      cut = extendCutBackwardThroughChromeGray(textIdxs, splitIdx) // 選択肢 + statusline の混合行
    } else if (isTitlebar && !isStatuslineText(joined)) {
      // 選択肢 + タイトルバーが同一行に連結描画される個体(この行区切り粒度では実データ
      // 未観測だが、将来の描画差分への備えとして statusline 混合行と同じ規則を適用する):
      // タイトルバーのマーカーより手前に選択肢マーカーがあれば、そこまでは残す。
      // 無ければ、この行に選択肢は無いということなので行全体(= リポ名・ブランチ名を
      // 含むタイトルバー全体)を伏せる。これが「マーカーの前にあるリポ名・ブランチ名が
      // 残る」不具合の直接の修正箇所。
      const markerPos = titlebarMarkerPos(joined)
      cut = OPTION_MARK_RE.test(joined.slice(0, markerPos))
        ? extendCutBackwardThroughChromeGray(textIdxs, markerPos)
        : 0
    } else {
      cut = 0 // 純 statusline 行: 選択肢マーカーが無い以上、可視部分を丸ごと伏せる。
    }
    for (const { i, from, to } of textIdxs) {
      if (to <= cut) continue
      const localCut = Math.max(0, cut - from)
      const v = tokens[i].value
      // 幅保存の近似マスクを共有する(maskVisible。全角文字を含む text でも
      // 表示幅を保つ。以前は 'x'.repeat() を直接使っていて全角文字の幅を保てなかった)。
      tokens[i].value = v.slice(0, localCut) + maskVisible(v.slice(localCut))
    }
  }
  let lineStart = 0
  for (let i = 0; i <= tokens.length; i++) {
    if (i === tokens.length || isRowBoundary(tokens[i])) {
      maskLogicalLine(lineStart, i)
      lineStart = i + 1
    }
  }

  return tokens.map((tok) => tok.value).join('')
}

// ---- run 境界を使った精密なマスク(dump-attrs.js 等、セル属性の run 配列を持つ
// 呼び出し側から使う。run の形は {text, ...} を持てば十分で、xterm/dumpRowAttrs 固有の
// 形には依存しない)----

/**
 * compressed(空白を含まない圧縮テキスト)を、文字ごとに任意空白を許容する緩やか一致で
 * haystack 内から探す。dumpRowAttrs() は run 内の空白セルを除外して連結するため、
 * run.text は元の行内では文字間に(1文字とは限らない量の)空白を挟みうる「圧縮テキスト」に
 * なる(USER_LOOSE_RE と同種の「文字の間に何か挟まる」問題への対処)。
 *
 * @param {string} haystack 検索対象の行テキスト
 * @param {string} compressed 空白が抜けた圧縮テキスト(run.text 相当)
 * @returns {number} 一致開始インデックス。見つからなければ -1。
 */
function looseFindIndex(haystack, compressed) {
  if (!compressed) return -1
  const pattern = [...compressed].map(escapeRe).join('\\s*')
  const m = new RegExp(pattern).exec(String(haystack))
  return m ? m.index : -1
}

/**
 * タイトルバー chrome(◉ / ' · /' / '/effort')を含む run が見つかった場合、その run の
 * 実際の開始位置(looseFindIndex で特定)から行末までを幅保存で伏せる。
 *
 * タイトルバーは観測上、常に行の末尾側に選択肢と連結描画され、かつ観測した実データでは
 * リポ名 + ブランチ名 + effort + スラッシュコマンドが単一の run にまとまっている
 * (色境界で分かれていない)。**既知の限界**: chrome が将来複数 run に分割され、かつ
 * マーカーを含まない run がマーカー run より手前に来る個体が現れた場合、その手前の
 * 断片は本関数では伏せられない(実測データに基づく対応であり、汎用的な chrome 境界
 * 検出ではない)。statusline(📒 等)は redact() が行単位で正しく処理できるため対象外
 * にする(責務を分け、動いている既存経路を変えない)。
 *
 * @param {string} text 元の行テキスト(runs は同じ行から取得したもの)
 * @param {Array<{text?: string}>} runs dumpRowAttrs() 相当の run 配列
 * @returns {string}
 */
function maskTitlebarRunsInText(text, runs) {
  const t = String(text)
  if (!Array.isArray(runs)) return t
  let masked = t
  for (const run of runs) {
    if (!run || !run.text || !isTitlebarChromeText(run.text)) continue
    const idx = looseFindIndex(masked, run.text)
    if (idx === -1) continue
    masked = masked.slice(0, idx) + maskVisible(masked.slice(idx))
  }
  return masked
}

/**
 * chrome(statusline / タイトルバー)由来で redact 済みテキストから消えた run を取り除く。
 * ① run 単体が chrome マーカーを含む → 除外(タイトルバーの巨大 run 等を直接検出)
 * ② run の可視テキストが redactedText にもう残っていない → 除外
 *   (statusline の統計値 run 等、行単位マスクで文字ごと消えた run を落とす)
 * 選択肢の実体 run(redactedText に残る文字)はいずれにも該当しないため残る。
 *
 * ①は現在の呼び出し側(dump-attrs.js)では②と同じ run を落とす場面が大半(chrome run は
 * maskTitlebarRunsInText / redact() で先に text からも消えているため)だが、削らずに残す。
 * looseFindIndex が run を見つけられず text 側のマスクに失敗した場合でも、run 自身が
 * マーカーを含んでいれば①で独立に落とせるフェイルセーフになる(このモジュールはマスク漏れ
 * =個人情報漏洩の方を過剰マスクより重く見る)。
 *
 * @param {string} redactedText 対象行の redact 済みテキスト(この関数自身は redact しない)
 * @param {Array<{text?: string}>} runs dumpRowAttrs() 相当の run 配列
 * @returns {Array} 出力に値する run のみを残した配列
 */
function filterPrintableRuns(redactedText, runs) {
  if (!Array.isArray(runs)) return runs
  const t = String(redactedText)
  return runs.filter((run) => {
    if (!run || !run.text) return true
    if (isChromeText(run.text)) return false
    return t.includes(run.text)
  })
}

/**
 * 文字列からエスケープ/制御トークンを取り除き、text トークンだけを連結した
 * 「論理テキスト」を返す(nl は含めない = 改行をまたいだ結合も検査対象にするため)。
 * redactRawStream() の per-token マスクは、識別子が SGR 等のエスケープで
 * 分断されている(例: `"al" + "\x1b[0m" + "ice"`)と各フラグメント単独では
 * USER_LOOSE_RE に一致せずマスクを素通りする(実機データ相当の
 * 入力で再現・確認)。この関数で制御トークンを除去してから再検査すれば、
 * 分断で隠れていた連続文字列("alice")が復元されて検出できる。
 *
 * @param {unknown} s
 * @returns {string}
 */
function stripControlTokensToText(s) {
  return tokenizeAnsi(String(s))
    .filter((tok) => tok.type === 'text')
    .map((tok) => tok.value)
    .join('')
}

/**
 * 文字列に
 * POSIX/Windows の home パス形状(`/home/<name>` `/Users/<name>` `C:\Users\<name>`
 * `\\host\Users\<name>`)が、**現在のユーザーかどうかに関わらず**含まれているかを判定する。
 * WSL の home パス形状(/mnt マウント接頭辞 + ドライブ文字 + Users ディレクトリ)も同様に
 * 対象とする。
 *
 * findRawIdentifierLeaks() は現在の OS ユーザー(HOME_USER)を基準に検査するため、
 * 別ユーザーの home パス(例: `manifest_ref` 等のメタデータに紛れ込んだ
 * `/home/alice/...`)は現在のユーザー名と一致せず検出できない。そのため、
 * `#` より前を未検証で原文保存する経路を通ると、他ユーザーの home パスが素通りしうる。
 * この関数は「home パスという形状そのもの」を、埋め込まれたユーザー名の値によらず検出する
 * (fail-close の追加防御。tools/extract-fixture.js が fixture のメタデータ全体
 * 〔raw_pty 以外〕の write 前検査に使う)。
 *
 * @param {unknown} s
 * @returns {boolean}
 */
function hasAnyHomePathShape(s) {
  const t = String(s)
  POSIX_HOME_PATH_RE.lastIndex = 0
  WIN_HOME_PATH_RE.lastIndex = 0
  WSL_HOME_PATH_RE.lastIndex = 0
  return POSIX_HOME_PATH_RE.test(t) || WIN_HOME_PATH_RE.test(t) || WSL_HOME_PATH_RE.test(t)
}

/**
 * 文字列から home パスの出現を全て列挙する(POSIX、macOS、Windows のドライブ文字または
 * UNC 接頭辞(区切りは / も同一視)、WSL の /mnt マウント接頭辞、の4形式)。
 * findIdentifierRanges() はマスク用の位置情報を返すが、こちらは形式別に name を返す
 * 検出専用関数(tools/test-pii-scan.js が使う)。
 */
// Judgment-only name re-slice. The shared masking REs (POSIX_HOME_PATH_RE etc.) keep a
// wide negated char class on purpose (redact() must swallow trailing junk so nothing
// visually leaks). For judgment (violation vs not), that width causes false positives:
// a broad-class capture like "alice`" or "alice#valid-id" no longer string-equals the
// allowlisted "alice". This re-slices from the same start position with a strict
// identifier-segment class and returns null when the first character isn't a segment
// character at all (e.g. "<user>" starts with "<", "${homeUser}" starts with "$").
const STRICT_NAME_SEGMENT_RE = /^[A-Za-z0-9._-]+/

function strictNameSegment(broadName) {
  const m = STRICT_NAME_SEGMENT_RE.exec(broadName)
  return m ? m[0] : null
}

function findHomePathIdentifiers(s) {
  const t = String(s)
  const out = []

  POSIX_HOME_PATH_RE.lastIndex = 0
  let m
  while ((m = POSIX_HOME_PATH_RE.exec(t)) !== null) {
    const name = strictNameSegment(m[2])
    if (name) out.push({ form: m[1] === '/home/' ? 'posix' : 'macos', name })
  }

  WSL_HOME_PATH_RE.lastIndex = 0
  while ((m = WSL_HOME_PATH_RE.exec(t)) !== null) {
    const name = strictNameSegment(m[2])
    if (name) out.push({ form: 'wsl', name })
  }

  // Windows は2パスで判定する。①元の t にそのまま適用(生の単一バックスラッシュ表記や、
  // 本物の UNC 2連続バックスラッシュ接頭辞を正しく拾う)。②二重バックスラッシュ(JSON
  // エスケープ由来)を単一へ畳み、区切り '/' も '\' と同一視した正規化コピーにも適用する
  // (JSON エスケープ形・/ 区切り形を拾う)。①を先に畳み込むと本物の UNC 接頭辞まで
  // 単一バックスラッシュへ縮退し、UNC 検出が失われるため2パスに分ける。同一の一致文字列
  // (m[0])は重複計上しない(name 再スライス前の広いマッチ全体で dedup する)。
  const winMatched = new Set()
  WIN_HOME_PATH_RE.lastIndex = 0
  while ((m = WIN_HOME_PATH_RE.exec(t)) !== null) {
    winMatched.add(m[0])
    const name = strictNameSegment(m[2])
    if (name) out.push({ form: 'windows', name })
  }
  const winNormalized = t.replace(/\\\\/g, '\\').replace(/\//g, '\\')
  WIN_HOME_PATH_RE.lastIndex = 0
  while ((m = WIN_HOME_PATH_RE.exec(winNormalized)) !== null) {
    if (winMatched.has(m[0])) continue
    const name = strictNameSegment(m[2])
    if (name) out.push({ form: 'windows', name })
  }

  return out
}

/**
 * redact() / redactRawStream() 後の文字列に、伏せたはずの生のホームパス / ユーザー名 /
 * repo 名 / branch 名が**そのままの形で**残っていないかを確認する最終防御。
 * redactRawStream() は NFKC の全角ホモグリフ分割への耐性が限定的なため、呼び出し側
 * (tools/extract-fixture.js)がこの関数で「素の文字列一致」を独立に再確認してから
 * 公開物へ書き出す(1 つの機構だけに頼らない = fail-close の多層防御)。
 *
 * **素の文字列だけでなく、制御トークンを除去した論理テキストに対しても検査する**
 * (stripControlTokensToText() 参照)。エスケープで分断されて画面上は連続して見える
 * 識別子(実機の TUI は SGR/CSI を印字文字の間に多用する)を、素の部分文字列一致
 * だけでは見逃すため。
 *
 * repo 名 / branch 名は境界ガード付き(英数字に挟まれていない完全一致)で検査する
 * (マスク側 findIdentifierRanges と同じ REPO_IDENTIFIER_PATTERNS を再利用 = drift 防止)。
 *
 * **NFKC 正規化後の文字列も検査する**: 生の文字列一致(t / stripped)に加えて、
 * NFKC 正規化後の文字列(tNfkc / strippedNfkc)に対しても検査する。REPO_IDENTIFIER_PATTERNS
 * の regex は NFKC 正規化済みの識別子から組んでいる(buildIdentifierPatterns)ため、
 * 生の t を素通りしても正規化後にだけ一致する残存(全角ホモグリフ等)を追加で拾える
 * (検出は多いほど安全側 = fail-close の多層防御)。HOME_USER / HOME_DIR も同様に
 * NFKC 正規化後の比較を追加する。
 *
 * @param {unknown} s redact() 済みの文字列
 * @returns {{leaked: boolean, matches: string[]}}
 */
function findRawIdentifierLeaks(s) {
  const t = String(s)
  const stripped = stripControlTokensToText(t)
  const tNfkc = t.normalize('NFKC')
  const strippedNfkc = stripped.normalize('NFKC')
  const matches = []
  if (HOME_USER_NFKC && (t.includes(HOME_USER) || stripped.includes(HOME_USER) || tNfkc.includes(HOME_USER_NFKC) || strippedNfkc.includes(HOME_USER_NFKC))) {
    matches.push(HOME_USER)
  }
  if (HOME_DIR) {
    const homeDirNfkc = HOME_DIR.normalize('NFKC')
    if (t.includes(HOME_DIR) || stripped.includes(HOME_DIR) || tNfkc.includes(homeDirNfkc) || strippedNfkc.includes(homeDirNfkc)) {
      matches.push(HOME_DIR)
    }
  }
  for (const { name, re } of REPO_IDENTIFIER_PATTERNS) {
    re.lastIndex = 0
    const hitRaw = re.test(t)
    re.lastIndex = 0
    const hitStripped = re.test(stripped)
    re.lastIndex = 0
    const hitRawNfkc = re.test(tNfkc)
    re.lastIndex = 0
    const hitStrippedNfkc = re.test(strippedNfkc)
    if (hitRaw || hitStripped || hitRawNfkc || hitStrippedNfkc) matches.push(name)
  }
  return { leaked: matches.length > 0, matches }
}

// ---- secret scanner(API key / token / 資格情報。個人環境情報とは別の脅威) ----
// findRawIdentifierLeaks() 等はユーザー名 / home パス / repo 名 / branch 名(個人環境情報)を
// 検査するが、実機録画には画面に描画された API key / token / 資格情報が混入する経路が
// 別途ありうる(認証エラーのメッセージ・env var のデバッグ出力・コピペされたトークン等)。
// これらは既存の識別子検査の対象外のため、専用のパターン検査を追加する。
//
// パターンは dotfiles の check-hardcoded-secrets.sh(コード commit 前のハードコーディング
// 機密検知、PreToolUse hook)と同じ意味の正規表現に揃える(2つの独立した検査系統が違う
// 基準で判定すると drift するため)。実装言語がシェル(grep -E、POSIX ERE)と JS(RegExp)で
// 異なるため、コードとしては複製ではなく移植になる。大文字小文字の扱いも移植元(grep -E に
// -i オプション無し)に揃える(Generic password / Generic api_key の 2 パターンのみ)。
const SECRET_PATTERNS = [
  { name: 'AWS Access Key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub Token', re: /gh[psouar]_[A-Za-z0-9]{36,}/ },
  { name: 'Anthropic API Key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API Key', re: /sk-[A-Za-z0-9]{32,}/ },
  { name: 'Slack Token', re: /xox[bpoa]-[0-9A-Za-z-]{10,}/ },
  { name: 'Google API Key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Stripe Key', re: /(sk|pk|rk)_(test|live)_[0-9a-zA-Z]{24,}/ },
  { name: 'Private Key PEM', re: /-----BEGIN[ A-Z]+PRIVATE KEY-----/ },
  { name: 'JWT', re: /ey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'Generic password', re: /(password|passwd|pwd)\s*[:=]\s*["'][^"'$]{4,}["']/ },
  { name: 'Generic api_key', re: /(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][^"'$]{8,}["']/ },
]

// 誤検知回避(dotfiles check-hardcoded-secrets.sh と同じプレースホルダ語、大小文字無視)。
const SECRET_PLACEHOLDER_RE =
  /(EXAMPLE|DUMMY|SAMPLE|PLACEHOLDER|YOUR_|YOUR-|FAKE|MOCK|REPLACE_ME|XXXXX|<your|<token|<api|<secret|<password|\.\.\.\.\.)/i

/**
 * 文字列(複数行可)から API key / token / 資格情報らしきパターンを検査する。
 * プレースホルダ語を含む行は誤検知回避のためスキップする(dotfiles
 * check-hardcoded-secrets.sh と同じ運用)。値そのものは返さない(パターン名と行番号のみ、
 * 検出結果を呼び出し側がログへ出しても値自体は漏れない)。
 *
 * @param {unknown} s
 * @returns {{leaked: boolean, matches: Array<{name: string, line: number}>}}
 */
function scanForSecrets(s) {
  const t = String(s)
  const lines = t.split('\n')
  const matches = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (SECRET_PLACEHOLDER_RE.test(line)) continue
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(line)) matches.push({ name, line: i + 1 })
    }
  }
  return { leaked: matches.length > 0, matches }
}

module.exports = {
  redact,
  redactLines,
  isStatuslineText,
  isTitlebarChromeText,
  isChromeText,
  maskTitlebarRunsInText,
  filterPrintableRuns,
  findRawIdentifierLeaks,
  hasAnyHomePathShape,
  findHomePathIdentifiers,
  scanForSecrets,
  tokenizeAnsi,
  redactRawStream,
  stripControlTokensToText,
  setRepoIdentifiers,
}
