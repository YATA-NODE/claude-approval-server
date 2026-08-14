/**
 * test-approval-server.js — kind:'notice'(スマホ通知)機能の実 HTTP 回帰テスト。
 *
 * approval-server.js の app を require で取得し、app.listen(0)(ephemeral port)で
 * 実際に HTTP リクエストを送って検証する。素の node スクリプト + assert 相当の
 * 手書きチェック + `passed:` 行出力という既存テスト(test-config-keys.js 等)の
 * 流儀に合わせている。
 *
 * --- token 注入方法について ---
 * loadConfig() は APPROVAL_CONFIG_PATH(運用者制御の env)があればそこから config を
 * 読む。テストは一時ディレクトリに専用 config を書き、require の前に env を張るだけで
 * 既知トークンを注入できる。ユーザーの実 approval-config.json には一切触れない
 * (旧方式 = 実 config の一時上書き + 復元 は、復元前にプロセスが落ちると実 config を
 * 失う経路があったため廃止)。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

// DUMMY を含めて機密スキャナのプレースホルダ判定に確実に載せる。実サービスでは
// 使われない、このテストファイル専用の固定値。
const TEST_TOKEN = 'DUMMY-test-approval-server-fixed-token-not-a-real-secret'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-server-test-'))
const tmpConfig = path.join(tmpDir, 'approval-config.json')
fs.writeFileSync(tmpConfig, JSON.stringify({ token: TEST_TOKEN }))
process.env.APPROVAL_CONFIG_PATH = tmpConfig
const serverMod = require('./approval-server.js')

const { app, queue, gcResolved, NOTICE_PENDING_TTL_MS } = serverMod

// -------------------------------------------------------
let passed = 0
let failed = 0
function ok(label, cond) {
  if (cond) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}`)
  }
}
function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (same) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}`)
    console.log(`     expected: ${JSON.stringify(expected)}`)
    console.log(`     actual  : ${JSON.stringify(actual)}`)
  }
}

// test-e2e.js の httpReq(実サーバー直結・status>=400 で reject)とは別物:
// 本テストは 400/401/409/413 の status 自体を assert するため、reject しない fetch 形にしている。
async function httpJson(base, method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' }
  if (token !== undefined) headers['x-secret-token'] = token
  const res = await fetch(`${base}${p}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch (_) {}
  return { status: res.status, json, text }
}

async function main() {
  const server = app.listen(0)
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  try {
    // -----------------------------------------------------
    console.log('\n[1] 認証(token 無し / 不正 token → 401)')
    // -----------------------------------------------------
    {
      const r1 = await httpJson(
        base,
        'POST',
        '/request',
        { kind: 'notice', reason: 'rewind-failed' },
        undefined
      )
      eq('① token 無し → 401', r1.status, 401)

      const r2 = await httpJson(
        base,
        'POST',
        '/request',
        { kind: 'notice', reason: 'rewind-failed' },
        'DUMMY-wrong-token-value'
      )
      eq('② 不正 token → 401', r2.status, 401)
    }

    // -----------------------------------------------------
    console.log('\n[2] notice 登録の正常系')
    // -----------------------------------------------------
    let noticeId
    {
      const r = await httpJson(
        base,
        'POST',
        '/request',
        { kind: 'notice', reason: 'rewind-failed' },
        TEST_TOKEN
      )
      eq('③ 正規 token + notice → 200', r.status, 200)
      ok('③ id を返す', typeof r.json?.id === 'string' && r.json.id.length > 0)
      noticeId = r.json.id

      const q = await httpJson(base, 'GET', '/queue', undefined, TEST_TOKEN)
      const item = (q.json || []).find((i) => i.id === noticeId)
      ok('③ GET /queue に notice item が現れる', !!item)
      if (item) {
        eq('③ item.kind === notice', item.kind, 'notice')
        eq('③ item.options === [OK]', item.options, ['OK'])
        eq('③ item.tabs === null', item.tabs, null)
        eq('③ item.freeTextOptions === null', item.freeTextOptions, null)
        ok(
          '③ item.description が存在しない',
          !Object.prototype.hasOwnProperty.call(item, 'description')
        )
      }
    }

    // -----------------------------------------------------
    console.log('\n[3] 不明 reason → 400')
    // -----------------------------------------------------
    {
      const r = await httpJson(
        base,
        'POST',
        '/request',
        { kind: 'notice', reason: 'unknown-reason-xyz' },
        TEST_TOKEN
      )
      eq('④ 不明 reason → 400', r.status, 400)
      eq('④ error message', r.json?.error, 'unknown notice reason')
    }

    // -----------------------------------------------------
    console.log('\n[4] 余剰フィールド拒否 → 400')
    // -----------------------------------------------------
    {
      const r = await httpJson(
        base,
        'POST',
        '/request',
        { kind: 'notice', reason: 'rewind-failed', description: 'x' },
        TEST_TOKEN
      )
      eq('⑤ description 同梱 → 400', r.status, 400)
      eq('⑤ error message', r.json?.error, 'notice accepts only {kind, reason}')

      // 許可リスト方式の固定: 既知のコンテンツ系フィールドだけでなく、未知キーも拒否する
      // ({kind, reason} 以外の一切を受理しない = 拒否リストの更新漏れという回帰を封じる)。
      const rUnknown = await httpJson(
        base,
        'POST',
        '/request',
        { kind: 'notice', reason: 'rewind-failed', foo: 1 },
        TEST_TOKEN
      )
      eq('⑤b 未知キー同梱 → 400', rUnknown.status, 400)
    }

    // -----------------------------------------------------
    console.log('\n[5] /resolve への notice ガード')
    // -----------------------------------------------------
    let noticeId2
    {
      const r = await httpJson(
        base,
        'POST',
        '/request',
        { kind: 'notice', reason: 'rewind-failed' },
        TEST_TOKEN
      )
      noticeId2 = r.json.id

      const rAnswers = await httpJson(
        base,
        'POST',
        `/resolve/${noticeId2}`,
        { answers: ['1'] },
        TEST_TOKEN
      )
      eq('⑥ answers 提示 → 400', rAnswers.status, 400)
      eq('⑥ error message', rAnswers.json?.error, 'notice accepts only acknowledgement')

      const rCancel = await httpJson(
        base,
        'POST',
        `/resolve/${noticeId2}`,
        { action: 'cancel' },
        TEST_TOKEN
      )
      eq('⑥ action=cancel 提示 → 400', rCancel.status, 400)
      eq('⑥ error message', rCancel.json?.error, 'notice accepts only acknowledgement')

      // text 単独(answer なし)は実装を読んで確認した実際の挙動として、notice
      // ガードより前に走る既存の汎用チェック(「answer or answers is required」、
      // item 取得より前にある)に先に引っかかる。これも 400 ではあるが notice
      // ガード由来のメッセージではない点を区別して記録する。
      const rTextAlone = await httpJson(
        base,
        'POST',
        `/resolve/${noticeId2}`,
        { text: 'hi' },
        TEST_TOKEN
      )
      eq('⑥ text 単独(answer なし)→ 400', rTextAlone.status, 400)
      eq(
        '⑥ text 単独時のメッセージは notice ガードでなく既存の汎用チェック由来',
        rTextAlone.json?.error,
        'answer or answers is required'
      )

      // notice ガード自体の text 分岐を実際に通すには answer を伴わせる必要がある
      const rTextWithAnswer = await httpJson(
        base,
        'POST',
        `/resolve/${noticeId2}`,
        { answer: 'OK', text: 'hi' },
        TEST_TOKEN
      )
      eq('⑥ answer+text 提示 → 400(notice ガード本体)', rTextWithAnswer.status, 400)
      eq(
        '⑥ answer+text 提示 error message',
        rTextWithAnswer.json?.error,
        'notice accepts only acknowledgement'
      )
    }

    // -----------------------------------------------------
    console.log('\n[6] /resolve 正常系 + 二重 resolve')
    // -----------------------------------------------------
    {
      const r1 = await httpJson(base, 'POST', `/resolve/${noticeId2}`, { answer: 'OK' }, TEST_TOKEN)
      eq('⑦ answer=OK → 200', r1.status, 200)
      eq('⑦ status resolved', r1.json?.status, 'resolved')

      const r2 = await httpJson(base, 'POST', `/resolve/${noticeId2}`, { answer: 'OK' }, TEST_TOKEN)
      // 実装確認済み(approval-server.js の /resolve/:id ハンドラ、item 取得直後の
      // `if (item.status !== 'pending') return res.status(409).json({ error:
      // 'Already resolved' })`): 二重 resolve は 409 'Already resolved'。
      eq('⑦ 二重 resolve → 409(実装で確認済み)', r2.status, 409)
      eq('⑦ error message', r2.json?.error, 'Already resolved')

      // 最初に登録した notice(id=noticeId)も後片付けしておく(GC テストの
      // 「時点別件数」を正しく検証するため、ここで pending を残さない)。
      await httpJson(base, 'POST', `/resolve/${noticeId}`, { answer: 'OK' }, TEST_TOKEN)
    }

    // -----------------------------------------------------
    console.log('\n[7] 65KB 超 body → 413')
    // -----------------------------------------------------
    {
      const bigDesc = 'a'.repeat(70 * 1024)
      const res = await fetch(`${base}/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-secret-token': TEST_TOKEN },
        body: JSON.stringify({ description: bigDesc }),
      })
      ok('⑧ 65KB 超 body → 413', res.status === 413)
    }

    // -----------------------------------------------------
    console.log('\n[8] GC seam: notice 限定 pending TTL')
    // -----------------------------------------------------
    {
      const preGcNoticePending = queue.filter(
        (q) => q.kind === 'notice' && q.status === 'pending'
      ).length
      eq(
        '⑨ GC 前時点: notice pending は 0 件(前段で全て resolve 済み)',
        preGcNoticePending,
        0
      )

      const now = Date.now()
      // queue item の共通ボイラープレートを 1 箇所に寄せる(literal を 3 連打すると、
      // 将来フィールドが増えたとき 1 つだけ更新漏れして「間違った理由で緑」になりやすい)。
      const makeQueueItem = (overrides) => ({
        kind: 'notice',
        reason: 'rewind-failed',
        options: ['OK'],
        tabs: null,
        freeTextOptions: null,
        status: 'pending',
        answer: null,
        answers: null,
        text: null,
        resolvedBy: null,
        resolvedAt: null,
        ...overrides,
      })
      const noticeExact60 = makeQueueItem({
        id: 'test-gc-notice-exact60',
        createdAt: new Date(now - NOTICE_PENDING_TTL_MS).toISOString(), // 60 分ちょうど
      })
      const noticeUnder60 = makeQueueItem({
        id: 'test-gc-notice-under60',
        createdAt: new Date(now - (NOTICE_PENDING_TTL_MS - 60 * 1000)).toISOString(), // 59 分
      })
      const approvalPending100 = makeQueueItem({
        id: 'test-gc-approval-100m',
        kind: 'approval',
        reason: undefined,
        description: 'gc test approval pending',
        options: ['Yes', 'No'],
        createdAt: new Date(now - 100 * 60 * 1000).toISOString(), // 100 分
      })
      queue.push(noticeExact60, noticeUnder60, approvalPending100)

      const afterInjectNoticePending = queue.filter(
        (q) => q.kind === 'notice' && q.status === 'pending'
      ).length
      eq('⑨ 合成 item 注入直後: notice pending 2 件', afterInjectNoticePending, 2)

      gcResolved()

      const idsAfter = queue.map((q) => q.id)
      ok('⑨ 60 分ちょうどの notice pending は除去される(>=)', !idsAfter.includes('test-gc-notice-exact60'))
      ok('⑨ 60 分未満の notice pending は残存する', idsAfter.includes('test-gc-notice-under60'))
      ok(
        '⑨ approval pending 100 分は除去されない(approval pending は対象外)',
        idsAfter.includes('test-gc-approval-100m')
      )

      const afterGcNoticePending = queue.filter(
        (q) => q.kind === 'notice' && q.status === 'pending'
      ).length
      eq('⑨ GC 後時点: notice pending 1 件(under60 のみ残存)', afterGcNoticePending, 1)

      // 後片付け(以後のテストへ影響しないよう合成 item を除去)
      for (let i = queue.length - 1; i >= 0; i--) {
        if (
          queue[i].id === 'test-gc-notice-under60' ||
          queue[i].id === 'test-gc-approval-100m'
        ) {
          queue.splice(i, 1)
        }
      }
    }

    // -----------------------------------------------------
    console.log('\n[9] 回帰: 通常 approval 登録(kind 無し)')
    // -----------------------------------------------------
    {
      const r = await httpJson(base, 'POST', '/request', { description: '通常の承認依頼' }, TEST_TOKEN)
      eq('⑩ kind 無し description あり → 200', r.status, 200)

      const q = await httpJson(base, 'GET', '/queue', undefined, TEST_TOKEN)
      const item = (q.json || []).find((i) => i.id === r.json.id)
      ok('⑩ GET /queue に approval item が現れる', !!item)
      if (item) {
        eq('⑩ item.kind === approval', item.kind, 'approval')
        eq('⑩ item.description が従来どおり', item.description, '通常の承認依頼')
        eq('⑩ item.options が従来のデフォルト', item.options, ['Yes', 'No'])
      }

      // 後片付け
      await httpJson(base, 'POST', `/resolve/${r.json.id}`, { answer: 'Yes' }, TEST_TOKEN)
    }
  } finally {
    server.close()
  }

  console.log('\n────────────────────────────────────────')
  console.log(`  passed: ${passed}, failed: ${failed}`)
  console.log('────────────────────────────────────────\n')
  process.exit(failed ? 2 : 0)
}

main().catch((e) => {
  console.error('[FATAL]', e)
  process.exit(1)
})
