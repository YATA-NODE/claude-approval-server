/**
 * approval-server.js
 *
 * エージェントからの承認依頼を管理するHTTPサーバー。
 * ngrokでトンネルして、スマホからアクセス可能にする。
 *
 * 使い方:
 *   npm install express cors
 *   node approval-server.js
 *   # 別ターミナルで: ngrok http 3000
 */

const http = require('http')
const express = require('express')
const cors = require('cors')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// 設定の読み込み優先順位:
//   PORT:  1. 環境変数 APPROVAL_PORT  2. approval-config.json の port  3. 3000
//   TOKEN: 1. approval-config.json の token  2. 環境変数 APPROVAL_TOKEN  3. ランダム生成
//
// PORT は env 優先（ポート衝突時に一時的に切り替えたい場面が多いため）。
// TOKEN は config 優先（長期固定したい値であり、無関係な env で上書きされると困るため）。
function loadConfig() {
  const configPath = path.join(__dirname, 'approval-config.json')
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (_) {
    return {}
  }
}
const config = loadConfig()

const app = express()
const PORT = parseInt(process.env.APPROVAL_PORT) || config.port || 3000
// C1: トークン未設定時は 32 バイト（256bit）のランダム値を自動生成
const SECRET_TOKEN =
  config.token || process.env.APPROVAL_TOKEN || crypto.randomBytes(32).toString('hex')

// ngrok 経由の X-Forwarded-For を信頼し、レート制限で本物のクライアント IP を使う。
// サーバーが 127.0.0.1 のみをバインドしているため、この設定で不当な偽装は起きない。
app.set('trust proxy', 'loopback')

app.use(cors())
app.use(express.json({ limit: '64kb' }))
// v1.12.0 (codex B001 修正): 旧 `express.static(__dirname)` を撤去。
// プロジェクトルート全体を未認証配信していたため、approval-config.json
// (APPROVAL_TOKEN を含む)が ngrok 経由で取得可能だった(2026-05-15 検証時に
// HTTP 200 で配信を確認 = token 漏洩リスク)。
// approval-ui.html は CSS/JS を全 inline で外部アセット参照なし = 個別ルート
// のみで配信し、それ以外のファイルへの直接アクセスは Express デフォルトの
// 404 で拒否する設計に変更。
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store, must-revalidate')
  res.sendFile(path.join(__dirname, 'approval-ui.html'))
})

// 承認待ちキュー: { id, description, status, createdAt, resolvedAt }
const queue = []

// resolved になってから RESOLVED_TTL_MS 経過したエントリを定期的に除去する。
// UI 側の「処理履歴」はブラウザローカルに保持されるため、サーバー側の resolved は
// long-poll の取りこぼし対策として短時間だけ保持すれば十分。
const RESOLVED_TTL_MS = 60 * 60 * 1000 // 1 時間
const RESOLVED_GC_INTERVAL_MS = 5 * 60 * 1000 // 5 分ごとに走査
function gcResolved() {
  const now = Date.now()
  let removed = 0
  for (let i = queue.length - 1; i >= 0; i--) {
    const it = queue[i]
    if (it.status !== 'resolved' || !it.resolvedAt) continue
    const age = now - new Date(it.resolvedAt).getTime()
    if (age >= RESOLVED_TTL_MS) {
      queue.splice(i, 1)
      removed++
    }
  }
  if (removed > 0) console.log(`[GC] removed ${removed} resolved entries`)
}
const gcTimer = setInterval(gcResolved, RESOLVED_GC_INTERVAL_MS)
gcTimer.unref?.()

// long-poll 待機中の /status/:id リクエスト通知用
const { EventEmitter } = require('events')
const resolveEvents = new EventEmitter()
resolveEvents.setMaxListeners(100)

// I1: description の最大長（ngrok 経由で機微情報が長大化するのを抑制）
const MAX_DESC_LEN = 500
// v1.12.0 フリーテキスト送信機能(Type something / Chat about this 経路)用。
// 制御文字を除いた上で 2000 文字を上限とする。Claude TUI のテキスト入力欄の
// 想定ユースケース(中規模メッセージ)を覆う長さで設定。
// ※ claude-wrapper.js MAX_FREE_TEXT_LEN / approval-ui.html textarea maxlength
//   と同期する(3 箇所、変更時は同時更新)。
const MAX_FREE_TEXT_LEN = 2000

// I2: レート制限（同一 IP の 401 連発を 10 分ブロック）
const failCounter = new Map() // ip -> { count, resetAt, blockedUntil }
const FAIL_WINDOW = 60 * 1000
const FAIL_LIMIT = 10
const BLOCK_MS = 10 * 60 * 1000

function checkRateLimit(ip) {
  const now = Date.now()
  const e = failCounter.get(ip)
  if (e && e.blockedUntil > now) return false
  return true
}
function recordFailure(ip) {
  const now = Date.now()
  let e = failCounter.get(ip)
  if (!e || e.resetAt < now) {
    e = { count: 1, resetAt: now + FAIL_WINDOW, blockedUntil: 0 }
  } else {
    e.count++
    if (e.count >= FAIL_LIMIT) {
      e.blockedUntil = now + BLOCK_MS
      console.warn(`[RATE-LIMIT] ${ip} blocked for ${BLOCK_MS / 1000}s`)
    }
  }
  failCounter.set(ip, e)
}
function recordSuccess(ip) {
  failCounter.delete(ip)
}

// I3: タイミング攻撃耐性のあるトークン比較
function tokensMatch(received, expected) {
  if (typeof received !== 'string' || received.length === 0) return false
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// トークン認証ミドルウェア
function authenticate(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many failed attempts' })
  }
  const token = req.headers['x-secret-token']
  if (!tokensMatch(token, SECRET_TOKEN)) {
    recordFailure(ip)
    return res.status(401).json({ error: 'Unauthorized' })
  }
  recordSuccess(ip)
  next()
}

// -------------------------------------------------------
// エージェント側API
// -------------------------------------------------------

/**
 * POST /request
 * エージェントが承認依頼を登録する
 * Body: { description: "ファイルを削除しようとしています: /tmp/test.txt" }
 * Returns: { id, status: "pending" }
 *
 * その後、エージェントは GET /status/:id をポーリングして結果を確認する
 */
// 文字列を最大長に切り詰めて末尾に "…" を付ける。短ければそのまま。
function clipString(s, max) {
  return s.length > max ? s.slice(0, max) + '…' : s
}

// options 配列を「文字列のみ・最大 9 件・各 200 文字」に正規化する。
function sanitizeOptions(arr) {
  return arr
    .filter((o) => typeof o === 'string')
    .slice(0, 9)
    .map((o) => clipString(o, 200))
}

// v1.12.0 フリーテキスト送信(Type something)用の入力検証。
// v1.12.0 (D2/W001 修正): エラー文と実装の不整合(silent 削除 vs "not allowed")
// を解消するため、削除型 → strict reject 型へ変更。UI 側で先に制御文字を削除して
// 送るので通常ケースで影響なし。wrapper validateFreeText と一貫した挙動になり、
// defense in depth は「UI 削除 → server reject → wrapper reject」の 3 段化。
// 検査: 文字列 / 長さ 1〜MAX_FREE_TEXT_LEN / 制御文字を含まない /
//      trim 後 length>0(空白のみ拒否、suggestion s2 対応)。
// 違反は null。通過したらそのままの文字列(変更しない)を返す。
// v1.12.0 (codex W3 修正): C0(\x00-\x1F)+ DEL(\x7F)+ C1(\x80-\x9F)を統一拒否。
// C1 は UTF-8 decode 後の string で単独出現するケースは限定的だが、端末/アプリ
// 解釈差を排除して defense in depth を完全化する。
const CONTROL_CHAR_TEST_RE = /[\x00-\x1F\x7F\x80-\x9F]/
function sanitizeFreeText(s) {
  if (typeof s !== 'string') return null
  if (s.length === 0 || s.length > MAX_FREE_TEXT_LEN) return null
  if (CONTROL_CHAR_TEST_RE.test(s)) return null
  if (s.trim().length === 0) return null
  return s
}

// v1.12.0: Chat about this は遠隔不能(数字キー単独で選べず、選んでもダイアログ
// 全体を抜ける TUI 仕様)。サーバ側で answer / answers が指す option がこのパターン
// に一致する場合は 400 reject(旧クライアントからの不正リクエスト防御)。
const CHAT_ABOUT_RE = /^Chat\s+about\s+this\.?$/i
// v1.12.0 (D1, codex B001/B002 修正): text 添付は Type something 系 option 限定。
// approval-ui.html / claude-wrapper.js の同名定数と完全同期。
// v1.12.0 (codex B002 修正): 前方一致だと "Type something custom" のような通常
// 選択肢を誤マッチして text 注入を許してしまう。末尾アンカー $ + period 任意で
// Claude TUI 組み込みの "Type something" / "Type something." だけに限定。
const FREE_TEXT_OPTION_RE = /^Type\s+something\.?$/i

// v1.12.0 (D1): answer 文字列(数字 or 完全一致 option 文字列)から該当 option を解決。
// codex B001-B003 の防御: API 直叩きで数字指定により option 種別チェックを迂回されない
// よう、サーバ側で必ず options 配列に照合する。
function resolveOption(opts, ans) {
  if (!Array.isArray(opts) || typeof ans !== 'string') return null
  const trimmed = ans.trim()
  if (/^[1-9]$/.test(trimmed)) {
    const idx = parseInt(trimmed, 10) - 1
    return idx < opts.length ? opts[idx] : null
  }
  return opts.includes(trimmed) ? trimmed : null
}

app.post('/request', authenticate, (req, res) => {
  const { description, options, tabs } = req.body
  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'description is required' })
  }

  // I1: 長過ぎる description は切り詰め（ngrok 経由の情報漏洩抑制・UI 表示の保護）
  const safeDesc = clipString(description, MAX_DESC_LEN)

  // options: 文字列配列のみ許可、最大 9 件・各 200 文字
  // AskUserQuestion 型ダイアログでは長文選択肢(平均 25 文字以上)が並ぶことがあるため
  // 各要素の上限を 200 文字に緩和。件数上限は数字キー注入の都合で 9 件まで。
  let safeOptions = ['Yes', 'No']
  if (Array.isArray(options)) {
    const sanitized = sanitizeOptions(options)
    if (sanitized.length > 0) safeOptions = sanitized
  }

  // tabs: タブ式 AskUserQuestion(複合質問)用、optional
  // 各タブは {label?, prompt, options} 形式、最大 9 タブ・各 9 options
  let safeTabs = null
  if (Array.isArray(tabs) && tabs.length > 0) {
    safeTabs = tabs
      .slice(0, 9)
      .filter(
        (t) =>
          t &&
          typeof t === 'object' &&
          typeof t.prompt === 'string' &&
          Array.isArray(t.options)
      )
      .map((t) => ({
        label: typeof t.label === 'string' ? clipString(t.label, 100) : undefined,
        prompt: clipString(t.prompt, MAX_DESC_LEN),
        options: sanitizeOptions(t.options),
      }))
      .filter((t) => t.options.length > 0)
    if (safeTabs.length === 0) safeTabs = null
    // tabs 存在時は options を Sentinel ["Submit"] に揃える(旧 UI 互換 + 一括承認除外の手がかり)
    if (safeTabs) safeOptions = ['Submit']
  }

  const item = {
    id: crypto.randomUUID(),
    description: safeDesc,
    options: safeOptions,
    tabs: safeTabs, // null または [{label?, prompt, options}]
    status: 'pending', // pending | resolved
    answer: null,
    answers: null, // 複合質問の回答配列(null または string[])
    text: null, // v1.12.0: フリーテキスト送信(Type something / Chat about this 経路)
    resolvedBy: null, // 'pc' | 'smartphone' | 'cli'
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  }
  queue.push(item)
  console.log(`[NEW REQUEST] ${item.id}: ${safeDesc}${safeTabs ? ` (${safeTabs.length} tabs)` : ''}`)
  res.json({ id: item.id, status: item.status })
})

/**
 * GET /status/:id[?wait=N]
 * エージェントが承認結果を取得する。
 *   wait = 秒数（1〜60）を指定すると、pending の場合はそのまま接続を保持し、
 *   resolve されたタイミングで即応答する（long-poll）。
 *   wait 無指定 or 0 なら従来どおり即応答。
 */
app.get('/status/:id', authenticate, (req, res) => {
  const item = queue.find((q) => q.id === req.params.id)
  if (!item) return res.status(404).json({ error: 'Not found' })

  const buildStatusResp = () => ({
    id: item.id,
    status: item.status,
    answer: item.answer,
    answers: item.answers, // 複合質問の回答配列(null または (string|{num,text})[])
    text: item.text, // v1.12.0: フリーテキスト(null またはサニタイズ済 string)
    action: item.action || null, // v1.12.0: 'cancel' または null
  })

  const wait = Math.min(Math.max(parseInt(req.query.wait) || 0, 0), 60)
  if (item.status === 'resolved' || wait === 0) {
    return res.json(buildStatusResp())
  }

  const send = () => {
    res.json(buildStatusResp())
  }
  const onResolve = () => {
    clearTimeout(timer)
    send()
  }
  const timer = setTimeout(() => {
    resolveEvents.off(item.id, onResolve)
    send()
  }, wait * 1000)
  resolveEvents.once(item.id, onResolve)
  req.on('close', () => {
    clearTimeout(timer)
    resolveEvents.off(item.id, onResolve)
  })
})

// -------------------------------------------------------
// スマホUI側API（トークン認証あり）
// -------------------------------------------------------

/**
 * GET /queue
 * pendingな依頼一覧を返す
 */
app.get('/queue', authenticate, (req, res) => {
  const pending = queue.filter((q) => q.status === 'pending')
  res.json(pending)
})

/**
 * POST /resolve/:id
 * スマホから承認 or 拒否する
 * Body: { action: "approved" | "rejected" }
 */
app.post('/resolve/:id', authenticate, (req, res) => {
  const { answer, answers, text, action, resolvedBy } = req.body
  const hasAnswers = Array.isArray(answers)
  const hasText = text != null
  const isCancel = action === 'cancel'
  if (!isCancel && !answer && !hasAnswers) {
    return res.status(400).json({ error: 'answer or answers is required' })
  }
  // v1.12.0 (D4 改善 + codex 3rd s1): action='cancel' と answer/answers/text の
  // 同時送信を排他化。truthy 判定だと answer:'' が抜けるので property presence で判定。
  if (isCancel) {
    const hasAny = ['answer', 'answers', 'text'].some((k) =>
      Object.prototype.hasOwnProperty.call(req.body, k)
    )
    if (hasAny) {
      return res.status(400).json({
        error: 'action=cancel cannot be combined with answer / answers / text',
      })
    }
  }

  const item = queue.find((q) => q.id === req.params.id)
  if (!item) return res.status(404).json({ error: 'Not found' })
  if (item.status !== 'pending') {
    return res.status(409).json({ error: 'Already resolved' })
  }

  // v1.12.0 (D3/suggestion): resolvedBy 不正値は null 丸めではなく 400 reject。
  // 未指定(null/undefined)は許可(後方互換)、指定があって不正値のみ reject。
  const allowedResolvedBy = ['pc', 'smartphone', 'cli']
  if (resolvedBy != null && !allowedResolvedBy.includes(resolvedBy)) {
    return res.status(400).json({
      error: `invalid resolvedBy "${resolvedBy}", must be one of ${allowedResolvedBy.join('|')}`,
    })
  }
  const safeResolvedBy = allowedResolvedBy.includes(resolvedBy) ? resolvedBy : null

  let safeAnswer = null
  let safeAnswers = null
  let safeText = null

  // v1.12.0: フリーテキスト送信。Type something 経路でスマホからテキスト入力を
  // 受信した場合、サニタイズして wrapper に渡す。
  // tabs を持つ複合 dialog のフリーテキストは answers[i].text 経由(下の Multi 経路)。
  // D1 (codex B001 修正): text は Type something option 選択時のみ許可。通常選択肢
  // に text を添付して送る経路を server 側で塞ぐ。
  if (hasText) {
    if (Array.isArray(item.tabs)) {
      return res.status(400).json({ error: 'text is not allowed for tabbed items (use answers[i].text)' })
    }
    const selectedOpt = resolveOption(item.options, answer)
    if (!selectedOpt || !FREE_TEXT_OPTION_RE.test(selectedOpt)) {
      return res.status(400).json({
        error: 'text is only allowed when the selected option matches "Type something"',
      })
    }
    safeText = sanitizeFreeText(text)
    if (safeText === null) {
      return res.status(400).json({
        error:
          'text must be a non-empty string under MAX_FREE_TEXT_LEN, control characters not allowed',
      })
    }
  }

  if (hasAnswers) {
    // 複合質問: tabs を持つ item でしか受理しない、長さ一致と数字 1〜9 を厳格チェック
    // 各要素は文字列(数字のみ) か { num, text? }(Type something 入力済み)
    if (!Array.isArray(item.tabs)) {
      return res.status(400).json({ error: 'answers is only allowed for tabbed items' })
    }
    if (answers.length !== item.tabs.length) {
      return res.status(400).json({ error: 'answers.length must match tabs.length' })
    }
    if (answers.length > 9) {
      return res.status(400).json({ error: 'answers too long' })
    }
    const norm = []
    for (let i = 0; i < answers.length; i++) {
      const item_i = answers[i]
      let num, rawText
      if (typeof item_i === 'string') {
        num = item_i.trim()
      } else if (item_i && typeof item_i === 'object' && !Array.isArray(item_i)) {
        num = String(item_i.num == null ? '' : item_i.num).trim()
        if (item_i.text != null) rawText = item_i.text
      } else {
        return res
          .status(400)
          .json({ error: `answers[${i}] must be string or {num,text}` })
      }
      if (!/^[1-9]$/.test(num)) {
        return res.status(400).json({ error: `answers[${i}].num must be a digit 1-9` })
      }
      const idx = parseInt(num, 10) - 1
      if (idx >= item.tabs[i].options.length) {
        return res.status(400).json({ error: `answers[${i}] out of range` })
      }
      const selectedOpt = item.tabs[i].options[idx]
      // v1.12.0: Chat about this オプションを指す回答は遠隔不能なので reject
      if (CHAT_ABOUT_RE.test(selectedOpt)) {
        return res.status(400).json({
          error: `answers[${i}] points to "Chat about this" which is not remote-controllable`,
        })
      }
      if (rawText !== undefined) {
        // D1 (codex B002 修正): text 添付は Type something option 限定。
        // 通常選択肢に text を添付すると、wrapper が数字キー押下後にテキスト本文を
        // 注入し、次タブや Submit 画面に流れ込む脆弱性を防ぐ。
        if (!FREE_TEXT_OPTION_RE.test(selectedOpt)) {
          return res.status(400).json({
            error: `answers[${i}].text is only allowed when the selected option matches "Type something"`,
          })
        }
        const safeAtText = sanitizeFreeText(rawText)
        if (safeAtText === null) {
          return res.status(400).json({
            error: `answers[${i}].text must be a non-empty string under MAX_FREE_TEXT_LEN, control characters not allowed`,
          })
        }
        norm.push({ num, text: safeAtText })
      } else {
        norm.push(num)
      }
    }
    safeAnswers = norm
    // 互換のため answer にも要約を残す(text 内容は含めず num のみ)
    safeAnswer = norm.map((a) => (typeof a === 'string' ? a : a.num)).join(',')
  } else if (isCancel) {
    // v1.12.0: ダイアログキャンセル(Esc 相当)。answer/answers は不要。
    // wrapper が cancel を検知して Esc キーを TUI に送る。
    safeAnswer = 'cancelled-by-remote'
  } else {
    if (typeof answer !== 'string') {
      return res.status(400).json({ error: 'answer must be a string' })
    }
    // tabs 持ち item は CLI からの "resolved-by-cli" 通知のみ answer 単独を受理する。
    // 旧 UI / 第三者から answer="Submit" 等が来ても wrapper では再生不能なので
    // ここで弾いて、複合質問は必ず answers 経路を通すようにする。
    if (Array.isArray(item.tabs) && answer !== 'resolved-by-cli') {
      return res.status(400).json({ error: 'tabbed items require answers array' })
    }
    // v1.12.0: Chat about this 直接指定も遠隔不能なので reject
    if (CHAT_ABOUT_RE.test(answer)) {
      return res.status(400).json({
        error: 'Chat about this is not remote-controllable (use cancel instead)',
      })
    }
    // v1.12.0 (codex W2/W3 修正): answer に制御文字が含まれていたら reject。
    // 通常 wrapper 側で再生不能だが、サーバログ([RESOLVED] answer=...)に
    // 制御文字が混入すると端末崩れ / ログ汚染になる。
    if (CONTROL_CHAR_TEST_RE.test(answer)) {
      return res.status(400).json({
        error: 'answer must not contain control characters',
      })
    }
    // v1.12.0 (codex 3rd W001 修正): 'resolved-by-cli' は wrapper 内部通知用 sentinel。
    // リモートクライアント(resolvedBy='pc' or 'smartphone')から送られた場合は
    // server 状態と TUI 状態の乖離を生むので 400 reject。CLI 経由(resolvedBy='cli'
    // または明示なし)からのみ許可。
    if (answer === 'resolved-by-cli' && safeResolvedBy && safeResolvedBy !== 'cli') {
      return res.status(400).json({
        error: 'resolved-by-cli is reserved for CLI internal use',
      })
    }
    // single dialog の answer は item.options に必ず一致する必要。
    // 旧設計は文字列をそのまま resolved にできたため、認証済み攻撃者が任意
    // answer を送信して承認フローを妨害できた。'resolved-by-cli' は CLI 通知
    // の内部 sentinel として例外的に許可。
    if (!Array.isArray(item.tabs) && answer !== 'resolved-by-cli') {
      const resolved = resolveOption(item.options, answer)
      if (!resolved) {
        return res.status(400).json({
          error: `answer "${String(answer).slice(0, 40)}" does not match any option in this dialog`,
        })
      }
      if (CHAT_ABOUT_RE.test(resolved)) {
        return res.status(400).json({
          error: 'Chat about this is not remote-controllable (use cancel instead)',
        })
      }
    }
    safeAnswer = answer.length > 100 ? answer.slice(0, 100) : answer
  }

  item.status = 'resolved'
  item.answer = safeAnswer
  item.answers = safeAnswers
  item.text = safeText
  item.action = isCancel ? 'cancel' : null
  item.resolvedBy = safeResolvedBy
  item.resolvedAt = new Date().toISOString()
  // ログには text 本文を出さない(defense in depth、長さのみ)
  const logSafeAnswers = safeAnswers
    ? safeAnswers.map((a) =>
        typeof a === 'string' ? a : { num: a.num, text_len: a.text.length }
      )
    : null
  let logBody
  if (isCancel) {
    logBody = 'action=cancel'
  } else if (logSafeAnswers) {
    logBody = `answers=${JSON.stringify(logSafeAnswers)}`
  } else {
    logBody = `answer=${item.answer}`
  }
  console.log(
    `[RESOLVED] ${item.id}: ${logBody} (by ${item.resolvedBy || 'unknown'})`
  )

  // long-poll 中の /status/:id を即座に返す
  resolveEvents.emit(item.id, item)

  res.json({ id: item.id, status: item.status })
})

/**
 * DELETE /history
 * resolved 済みエントリをサーバー側からまとめて除去する。
 * UI の「すべて削除」操作で呼ばれる。pending には触れない。
 */
app.delete('/history', authenticate, (req, res) => {
  let removed = 0
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].status === 'resolved') {
      queue.splice(i, 1)
      removed++
    }
  }
  console.log(`[HISTORY CLEAR] removed ${removed} resolved entries`)
  res.json({ removed })
})

// -------------------------------------------------------
// サーバー起動
// -------------------------------------------------------
const server = http.createServer(app)

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const alt = PORT + 1
    console.error(`\n❌ ポート ${PORT} は既に使用中です。`)
    console.error(`   他のターミナルで approval-server.js が起動済みでないか確認してください。`)
    console.error(`   別のポートで起動する場合:`)
    console.error(`     PowerShell: $env:APPROVAL_PORT=${alt}; node approval-server.js`)
    console.error(`     CMD:        set APPROVAL_PORT=${alt} && node approval-server.js`)
    console.error(`     bash:       APPROVAL_PORT=${alt} node approval-server.js`)
    if (config.port) {
      console.error(
        `   （APPROVAL_PORT を設定すれば approval-config.json の port (${config.port}) より優先されます）\n`
      )
    } else {
      console.error('')
    }
  } else {
    console.error(`\n❌ サーバー起動エラー: ${err.message}\n`)
  }
  process.exit(1)
})

// C2: 明示的に 127.0.0.1 にバインド（LAN 他端末からの直接アクセスを防止）
// 外部アクセスは ngrok トンネル経由のみに限定される。
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n✅ Approval server running on http://127.0.0.1:${PORT} (loopback only)`)
  console.log(`\n🔑 SECRET_TOKEN: ${SECRET_TOKEN}`)
  console.log(`   (スマホUIとエージェントコードにこのトークンを設定してください)\n`)
  console.log(`次のステップ:`)
  console.log(`  1. 別ターミナルで: ngrok http ${PORT}`)
  console.log(`  2. ngrokが表示したURLをスマホUIに設定`)
  console.log(`  3. エージェントコードでもURLとトークンを設定\n`)
})

// -------------------------------------------------------
// エージェントから使うヘルパー関数（同プロセス内で使う場合）
// -------------------------------------------------------

/**
 * requestApproval(description)
 * 承認が得られるまで待機するPromiseを返す
 *
 * 使用例:
 *   const { requestApproval } = require('./approval-server');
 *   const approved = await requestApproval('ファイルを削除します: /tmp/test.txt');
 *   if (approved) { ... }
 */
async function requestApproval(description, options = ['Yes', 'No']) {
  const BASE_URL = `http://localhost:${PORT}`

  // 依頼登録
  const res = await fetch(`${BASE_URL}/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-secret-token': SECRET_TOKEN,
    },
    body: JSON.stringify({ description, options }),
  })
  const { id } = await res.json()

  console.log(`[WAITING] 承認待ち: ${id}`)

  // ポーリングで結果待ち（5秒ごと、最大10分）
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    const poll = await fetch(`${BASE_URL}/status/${id}`, {
      headers: { 'x-secret-token': SECRET_TOKEN },
    })
    const { status } = await poll.json()
    if (status === 'approved') return true
    if (status === 'rejected') return false
  }

  console.warn(`[TIMEOUT] 承認タイムアウト: ${id}`)
  return false
}

module.exports = { requestApproval }
