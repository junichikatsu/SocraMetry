import { MOCK_DIAGNOSIS } from '@socrametry/llm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { app } from './app'
import { gateTimeouts } from './config'
import { installFakeDataStore, uninstallFakeDataStore, type FakeDataStore } from './test-support/fake-datastore'

/**
 * 主要導線の統合テスト（F13 / DoD #5・#8）。
 *
 * **`MOCK_MODE=true` で LLM を一切呼ばずに全導線を通す。**
 * これができることが MOCK モードを最初に作った理由そのものであり（ADR-014）、
 * CI で LLM 課金が発生しないことの担保でもある。
 *
 * データストアは実行環境が注入する認証情報を要求するため、
 * 同じインターフェースの代替に差し替えている（→ `test-support/fake-datastore.ts`）。
 */

const ENV = {
  MOCK_MODE: 'true',
  OPS_LOG_ENABLED: 'false',
  SESSION_JWT_SECRET: 'test-secret-do-not-use-in-production',
  INVITE_CODE: 'test-invite',
  DS_TABLE_USERS: 'users',
  DS_TABLE_SESSIONS: 'sessions',
  DS_TABLE_SECRETS: 'secrets',
  DS_TABLE_REPORTS: 'reports',
  DS_TABLE_OPS_LOGS: 'ops_logs',
}

const ERROR_TEXT =
  "TypeError: Cannot read properties of undefined (reading 'map')\n    at ProductList (ProductList.tsx:24:18)"

let store: FakeDataStore

beforeAll(() => {
  for (const [key, value] of Object.entries(ENV)) process.env[key] = value
  store = installFakeDataStore()
})

afterAll(() => {
  uninstallFakeDataStore()
  for (const key of Object.keys(ENV)) delete process.env[key]
})

beforeEach(() => {
  store.reset()
})

// ── テストヘルパ ─────────────────────────────────────────────────────────────

// レスポンスの JSON は API 契約の**外側から**触るのがテストの役目なので、
// 公開型ではなく素の形で扱う（型に守られると契約違反を検出できない）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

async function call(
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string } = {},
): Promise<{ status: number; body: Json; cookie: string | null; headers: Headers }> {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.cookie) headers['cookie'] = options.cookie

  const res = await app.request(path, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })

  const setCookie = res.headers.get('set-cookie')
  return {
    status: res.status,
    body: (await res.json()) as Json,
    cookie: setCookie ? (setCookie.split(';')[0] ?? null) : null,
    // 契約はボディだけではない。Retry-After のように**ヘッダが仕様の一部**の応答がある
    headers: res.headers,
  }
}

async function signIn(email = 'sato@example.com'): Promise<string> {
  const res = await call('POST', '/v1/auth/signup', {
    body: { email, password: 'password1234', displayName: '佐藤', inviteCode: ENV.INVITE_CODE },
  })
  expect(res.status).toBe(201)
  return res.cookie as string
}

async function startSession(cookie: string): Promise<Json> {
  const res = await call('POST', '/v1/sessions', {
    cookie,
    body: { mode: 'live', errorText: ERROR_TEXT, language: 'typescript', framework: 'nextjs' },
  })
  expect(res.status).toBe(201)
  return res.body
}

/** 正解を選ぶ。テストは答えを知らないので、保存先（非公開テーブル）から引く */
function correctOptionFor(sessionId: string, seq: number): string {
  const keys = store.dump('secrets').find((i) => i['kind'] === 'answerkeys' && i['sessionId'] === sessionId)
  return (keys?.['keys'] as Json)[String(seq)].correctOptionId as string
}

function wrongOptionFor(sessionId: string, seq: number, options: Json[]): string {
  const correct = correctOptionFor(sessionId, seq)
  return options.find((o) => o.id !== correct)?.id as string
}

// ─────────────────────────────────────────────────────────────────────────────

describe('認証（FR-31a）', () => {
  it('招待コードなしでは登録できない（公開 URL に無制限のサインアップを置かない）', async () => {
    const res = await call('POST', '/v1/auth/signup', {
      body: { email: 'a@example.com', password: 'password1234', displayName: 'A', inviteCode: 'wrong' },
    })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('INVALID_INVITE_CODE')
  })

  it('サインアップで Cookie が発行され、HttpOnly と SameSite=Lax が付く', async () => {
    const res = await app.request('/v1/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'cookie@example.com',
        password: 'password1234',
        displayName: 'C',
        inviteCode: ENV.INVITE_CODE,
      }),
    })
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('sm_session=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
  })

  /**
   * enebular は 1 ホストを複数インスタンスがパスで分け合う。`Path=/` のままだと
   * 同じホストの別パスに載っている**他の関数にも JWT が送られる**。
   * HttpOnly は JS からの読み取りを防ぐだけで、送信自体は止められない。
   */
  it('Cookie の適用範囲をトリガーのパス配下に絞る', async () => {
    const res = await app.request('/socrametry/v1/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'scoped@example.com',
        password: 'password1234',
        displayName: 'S',
        inviteCode: ENV.INVITE_CODE,
      }),
    })

    const issued = res.headers.getSetCookie().find((line) => !line.includes('Max-Age=0'))
    expect(issued).toContain('Path=/socrametry')
    // 過去に Path=/ で発行したものは同時に消す（2 つ送られて曖昧になるのを防ぐ）
    expect(res.headers.getSetCookie().some((line) => line.includes('Max-Age=0'))).toBe(true)
  })

  it('トリガーのパスが無い経路では Path=/ のまま（ローカル・テスト）', async () => {
    const res = await app.request('/v1/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'plain@example.com',
        password: 'password1234',
        displayName: 'P',
        inviteCode: ENV.INVITE_CODE,
      }),
    })

    const issued = res.headers.getSetCookie().find((line) => !line.includes('Max-Age=0'))
    expect(issued).toContain('Path=/')
    expect(issued).not.toContain('Path=/v1')
  })

  it('同じメールアドレスは二重登録できない', async () => {
    await signIn('dup@example.com')
    const res = await call('POST', '/v1/auth/signup', {
      body: {
        email: 'dup@example.com',
        password: 'password1234',
        displayName: 'D',
        inviteCode: ENV.INVITE_CODE,
      },
    })
    expect(res.status).toBe(409)
  })

  it('パスワードが違えば、存在の有無を漏らさない同じ応答になる', async () => {
    await signIn('who@example.com')
    const wrongPassword = await call('POST', '/v1/auth/login', {
      body: { email: 'who@example.com', password: 'wrong-password' },
    })
    const unknownUser = await call('POST', '/v1/auth/login', {
      body: { email: 'nobody@example.com', password: 'wrong-password' },
    })
    expect(wrongPassword.status).toBe(401)
    expect(unknownUser.body).toEqual(wrongPassword.body)
  })

  it('ログインすると /v1/me が自分を返す', async () => {
    await signIn('me@example.com')
    const login = await call('POST', '/v1/auth/login', {
      body: { email: 'me@example.com', password: 'password1234' },
    })
    const me = await call('GET', '/v1/me', { cookie: login.cookie as string })
    expect(me.body.me).toMatchObject({ email: 'me@example.com', displayName: '佐藤' })
    // v0.1 は組織・ロールを持たない。持たせるとテナント分離が実装済みと誤読される
    expect(me.body.me.role).toBeUndefined()
    expect(me.body.me.tenantId).toBeUndefined()
  })

  it('未ログインではすべての API が 401（/v1/health を除く）', async () => {
    for (const [method, path] of [
      ['POST', '/v1/sessions'],
      ['GET', '/v1/sessions/01J8XK4M2N0000000000000001'],
      ['POST', '/v1/sessions/01J8XK4M2N0000000000000001/hints'],
      ['GET', '/v1/me/sessions'],
      ['GET', '/v1/me/stats'],
    ] as const) {
      const res = await call(method, path)
      expect(res.status, `${method} ${path}`).toBe(401)
      expect(res.body.error.code).toBe('UNAUTHENTICATED')
    }
    expect((await call('GET', '/v1/health')).status).toBe(200)
  })
})

describe('Gate A — ヒントのみ（FR-03）', () => {
  it('セッション作成で Lv1 ヒントが返り、設問は返らない', async () => {
    const cookie = await signIn()
    const body = await startSession(cookie)

    expect(body.session).toMatchObject({ gate: 'A', status: 'active', hintLevel: 1 })
    expect(body.hint.level).toBe(1)
    // ★ Gate A は着眼点のヒントのみ。設問を返した時点で 3 ゲートが崩れる
    expect(body.question).toBeUndefined()
  })

  it('診断を待たずに返る（ADR-006: diagnosisStatus は pending）', async () => {
    const cookie = await signIn()
    const body = await startSession(cookie)
    expect(body.session.diagnosisStatus).toBe('pending')
    expect(body.actions).toMatchObject({
      canRequestHint: true,
      canAdvanceToQuestions: true,
      canDeclareConclusion: true,
      // Gate C は塞がっている
      canReveal: false,
    })
  })

  it('入力はマスキングして保存する（FR-11 / 保存前に処理する）', async () => {
    const cookie = await signIn()
    await call('POST', '/v1/sessions', {
      cookie,
      body: {
        errorText: `${ERROR_TEXT}\nkey=sk-orca-abcdefghijklmnopqrstuvwx\nat /Users/tanaka/acme/src/a.ts:1`,
        recentChange: 'sato@example.com に連絡した',
      },
    })

    const stored = store.dump('sessions')[0] as Json
    expect(stored.errorText).not.toContain('sk-orca-')
    expect(stored.errorText).toContain('[REDACTED_KEY]')
    // 中間ディレクトリの顧客名（acme）まで消えていること
    expect(stored.errorText).not.toContain('acme')
    expect(stored.recentChange).toContain('[REDACTED_EMAIL]')
  })

  it('ヒントは Lv3 まで開放でき、それ以上は 409', async () => {
    const cookie = await signIn()
    const session = await startSession(cookie)
    const id = session.session.id

    const lv2 = await call('POST', `/v1/sessions/${id}/hints`, { cookie })
    expect(lv2.body.hint.level).toBe(2)
    const lv3 = await call('POST', `/v1/sessions/${id}/hints`, { cookie })
    expect(lv3.body.hint.level).toBe(3)
    expect(lv3.body.actions.canRequestHint).toBe(false)

    const lv4 = await call('POST', `/v1/sessions/${id}/hints`, { cookie })
    expect(lv4.status).toBe(409)
    expect(lv4.body.error.code).toBe('HINT_EXHAUSTED')
  })

  it('診断後のヒントは診断由来のものを使い、LLM を呼ばない', async () => {
    const cookie = await signIn()
    const session = await startSession(cookie)
    const id = session.session.id

    await call('POST', `/v1/sessions/${id}/diagnose`, { cookie })
    const lv2 = await call('POST', `/v1/sessions/${id}/hints`, { cookie })
    expect(lv2.body.hint.body).toBe(MOCK_DIAGNOSIS.gateAHints[1])
  })

  /**
   * 時間経過による Gate A → B（FR-07 / #20）。
   * Lambda は定期実行を持てないため、タイマーはクライアントに置く。
   * サーバが渡すのは**残り時間だけ**で、発火条件はサーバ側にある。
   */
  it('ヒントを Lv3 まで開放すると、自動遷移までの残り時間が返る', async () => {
    const cookie = await signIn()
    const session = await startSession(cookie)
    const id = session.session.id

    // Lv3 に達するまでは発火しない（ヒントを読んでいる最中に送られない）
    expect(session.session.autoAdvanceInMs).toBeNull()
    const lv2 = await call('POST', `/v1/sessions/${id}/hints`, { cookie })
    expect(lv2.body.session.autoAdvanceInMs).toBeNull()

    const lv3 = await call('POST', `/v1/sessions/${id}/hints`, { cookie })
    expect(lv3.body.session.autoAdvanceInMs).toBeGreaterThan(0)
    // 絶対時刻ではなく残り時間。クライアントの時計とのずれを持ち込まない
    expect(lv3.body.session.autoAdvanceInMs).toBeLessThanOrEqual(gateTimeouts().gateAMs)
  })

  it('Gate B に入った後は自動遷移の残り時間を返さない', async () => {
    const cookie = await signIn()
    const session = await startSession(cookie)
    const id = session.session.id

    await call('POST', `/v1/sessions/${id}/hints`, { cookie })
    await call('POST', `/v1/sessions/${id}/hints`, { cookie })
    const advanced = await call('POST', `/v1/sessions/${id}/advance`, { cookie })

    expect(advanced.body.session.gate).toBe('B')
    expect(advanced.body.session.autoAdvanceInMs).toBeNull()
  })
})

describe('先行診断（ADR-006 / FR-13）', () => {
  it('診断すると ready になり、答えは非公開テーブルにだけ入る（ADR-005）', async () => {
    const cookie = await signIn()
    const session = await startSession(cookie)
    const id = session.session.id

    const res = await call('POST', `/v1/sessions/${id}/diagnose`, { cookie })
    expect(res.body.diagnosisStatus).toBe('ready')

    // ★ 答えは session_secrets にのみ存在する
    const secret = store.dump('secrets').find((i) => i['kind'] === 'diagnosis') as Json
    expect(secret.rootCause).toBe(MOCK_DIAGNOSIS.rootCause)

    // ★ sessions テーブルには答えが入っていない
    expect(JSON.stringify(store.dump('sessions'))).not.toContain(MOCK_DIAGNOSIS.rootCause)
  })

  it('二重発火しても何も起きない（冪等 / api-spec.md §4）', async () => {
    const cookie = await signIn()
    const id = (await startSession(cookie)).session.id

    await call('POST', `/v1/sessions/${id}/diagnose`, { cookie })
    const second = await call('POST', `/v1/sessions/${id}/diagnose`, { cookie })

    expect(second.status).toBe(200)
    expect(second.body.diagnosisStatus).toBe('ready')
    expect(store.dump('secrets').filter((i) => i['kind'] === 'diagnosis')).toHaveLength(1)
  })
})

/**
 * ADR-006 は診断を**別リクエストとして並行実行**させる。
 * その間に利用者は Gate B へ進み、回答している。
 * どちらかが古いコピーを丸ごと書き戻すと、進行か診断状態が失われる。
 * 実環境で「DIAGNOSIS_TIMEOUT が返り続ける」として表面化した。
 */
describe('診断と操作の並行実行（ADR-006）', () => {
  it('診断の完了が、その間に進んだ Gate B の状態を消さない', async () => {
    const cookie = await signIn()
    const id = (await startSession(cookie)).session.id

    // 診断がセッションを読んだ直後に、利用者が Gate B へ進んだ状況を作る
    store.interceptAfterNextGet(() => {
      const session = store.dump('sessions')[0] as Json
      session['gate'] = 'B'
      session['currentStage'] = 'observe'
    })
    await call('POST', `/v1/sessions/${id}/diagnose`, { cookie })

    const state = await call('GET', `/v1/sessions/${id}`, { cookie })
    expect(state.body.session.gate).toBe('B')
    expect(state.body.session.diagnosisStatus).toBe('ready')
  })

  it('diagnosisStatus が古くても、診断が保存されていれば設問を返す', async () => {
    const cookie = await signIn()
    const id = (await startSession(cookie)).session.id
    await call('POST', `/v1/sessions/${id}/diagnose`, { cookie })

    // 並行更新で pending に巻き戻された状態を再現する
    const stored = store.dump('sessions')[0] as Json
    stored['diagnosisStatus'] = 'pending'

    const advanced = await call('POST', `/v1/sessions/${id}/advance`, { cookie })
    const answered = await call('POST', `/v1/sessions/${id}/answers`, {
      cookie,
      body: {
        questionId: advanced.body.question.id,
        selectedOptionId: correctOptionFor(id, 1),
      },
    })

    // 202 で待たされず、次の設問まで進む
    expect(answered.status).toBe(200)
    expect(answered.body.nextQuestion).not.toBeNull()
    // 状態そのものも修復される
    expect(answered.body.session.diagnosisStatus).toBe('ready')
  })
})

describe('Gate B — 段階的出題（FR-04 / FR-06）', () => {
  async function enterGateB(cookie: string) {
    const id = (await startSession(cookie)).session.id
    await call('POST', `/v1/sessions/${id}/diagnose`, { cookie })
    const advanced = await call('POST', `/v1/sessions/${id}/advance`, { cookie })
    return { id, advanced }
  }

  it('設問に進むと Lv1（観察）の選択式設問が返る', async () => {
    const cookie = await signIn()
    const { advanced } = await enterGateB(cookie)

    expect(advanced.body.session).toMatchObject({ gate: 'B', currentStage: 'observe', stageIndex: 1 })
    expect(advanced.body.question.options.length).toBeGreaterThanOrEqual(2)
    // ★ 公開型に正解が存在しない
    expect(advanced.body.question.correctOptionId).toBeUndefined()
  })

  it('正解すると次の段階へ進む', async () => {
    const cookie = await signIn()
    const { id, advanced } = await enterGateB(cookie)
    const question = advanced.body.question

    const res = await call('POST', `/v1/sessions/${id}/answers`, {
      cookie,
      body: {
        questionId: question.id,
        selectedOptionId: correctOptionFor(id, 1),
        elapsedMs: 12400,
      },
    })

    expect(res.body.result.isCorrect).toBe(true)
    expect(res.body.session.currentStage).toBe('localize')
    expect(res.body.nextQuestion.stage).toBe('localize')
  })

  it('不正解では同じ段階に留まり、角度を変えた設問が出る', async () => {
    const cookie = await signIn()
    const { id, advanced } = await enterGateB(cookie)
    const question = advanced.body.question

    const res = await call('POST', `/v1/sessions/${id}/answers`, {
      cookie,
      body: {
        questionId: question.id,
        selectedOptionId: wrongOptionFor(id, 1, question.options),
      },
    })

    expect(res.body.result.isCorrect).toBe(false)
    expect(res.body.session.currentStage).toBe('observe')
    expect(res.body.nextQuestion.seqInStage).toBe(2)
  })

  it('同段階 3 問目も不正解なら、ヒントレベルが上がって次の段階へ送られる（詰まらせない）', async () => {
    const cookie = await signIn()
    const { id, advanced } = await enterGateB(cookie)

    let question = advanced.body.question
    let res: Awaited<ReturnType<typeof call>> | null = null
    for (let seq = 1; seq <= 3; seq += 1) {
      res = await call('POST', `/v1/sessions/${id}/answers`, {
        cookie,
        body: {
          questionId: question.id,
          selectedOptionId: wrongOptionFor(id, seq, question.options),
        },
      })
      question = res.body.nextQuestion
    }

    expect(res?.body.session.currentStage).toBe('localize')
    expect(res?.body.session.hintLevel).toBe(2)
  })

  it('同じ回答を再送しても二重にならない（冪等 / F04 のサーバ側防御）', async () => {
    const cookie = await signIn()
    const { id, advanced } = await enterGateB(cookie)
    const question = advanced.body.question
    const body = { questionId: question.id, selectedOptionId: correctOptionFor(id, 1) }

    const first = await call('POST', `/v1/sessions/${id}/answers`, { cookie, body })
    const second = await call('POST', `/v1/sessions/${id}/answers`, { cookie, body })

    expect(second.body.result).toEqual(first.body.result)
    expect(second.body.nextQuestion.id).toBe(first.body.nextQuestion.id)
    const stored = store.dump('sessions')[0] as Json
    // 設問 2 件（observe + localize）のみ。回答の再送でターンが増えていない
    expect(stored.turns).toHaveLength(2)
  })

  it('存在しない選択肢は 400', async () => {
    const cookie = await signIn()
    const { id, advanced } = await enterGateB(cookie)
    const res = await call('POST', `/v1/sessions/${id}/answers`, {
      cookie,
      body: { questionId: advanced.body.question.id, selectedOptionId: 'e' },
    })
    expect(res.status).toBe(400)
  })

  it('診断が未完のまま Lv2 に進むと 202 で待たされ、回答は失われない（ADR-006）', async () => {
    const cookie = await signIn()
    // 診断を撃たずに設問へ進む（Lv1 は診断なしで出題できる）
    const id = (await startSession(cookie)).session.id
    const advanced = await call('POST', `/v1/sessions/${id}/advance`, { cookie })
    const question = advanced.body.question

    const pending = await call('POST', `/v1/sessions/${id}/answers`, {
      cookie,
      body: { questionId: question.id, selectedOptionId: correctOptionFor(id, 1) },
    })

    expect(pending.status).toBe(202)
    expect(pending.body.nextQuestion).toBeNull()
    expect(pending.body.pending).toMatchObject({ reason: 'DIAGNOSIS_IN_PROGRESS' })

    // 診断が終わってから同じリクエストを再送すると、続きが返る
    await call('POST', `/v1/sessions/${id}/diagnose`, { cookie })
    const retried = await call('POST', `/v1/sessions/${id}/answers`, {
      cookie,
      body: { questionId: question.id, selectedOptionId: correctOptionFor(id, 1) },
    })
    expect(retried.status).toBe(200)
    expect(retried.body.nextQuestion.stage).toBe('localize')
  })
})

describe('原因宣言と到達判定（FR-09 / Q-15）', () => {
  it('「わかりません」を not_reached にせず、選択肢を提示する', async () => {
    const cookie = await signIn()
    const id = (await startSession(cookie)).session.id
    await call('POST', `/v1/sessions/${id}/diagnose`, { cookie })

    const res = await call('POST', `/v1/sessions/${id}/conclusion`, {
      cookie,
      body: { body: 'わかりません' },
    })

    expect(res.status).toBe(200)
    expect(res.body.conclusion.verdict).toBeNull()
    expect(res.body.conclusion.skipped).toBe(true)
    expect(res.body.session.status).toBe('active')
  })

  it('短すぎる入力は判定に回さない', async () => {
    const cookie = await signIn()
    const id = (await startSession(cookie)).session.id
    await call('POST', `/v1/sessions/${id}/diagnose`, { cookie })

    const res = await call('POST', `/v1/sessions/${id}/conclusion`, {
      cookie,
      body: { body: 'undefined' },
    })
    expect(res.body.conclusion.verdict).toBeNull()
  })

  it('Gate A で到達すると最上位の到達ゲートで完了する（★★★ 自力解決）', async () => {
    const cookie = await signIn()
    const id = (await startSession(cookie)).session.id
    await call('POST', `/v1/sessions/${id}/diagnose`, { cookie })

    const res = await call('POST', `/v1/sessions/${id}/conclusion`, {
      cookie,
      body: { body: 'API の応答前の初回レンダリングで items が undefined になっていた' },
    })

    expect(res.body.conclusion.verdict).toBe('reached')
    expect(res.body.session).toMatchObject({ status: 'completed', reachedGate: 'A' })
    expect(res.body.reportPath).toBe(`/v1/sessions/${id}/report`)
  })

  it('同じ本文の再送は記録済みの判定を返す（冪等）', async () => {
    const cookie = await signIn()
    const id = (await startSession(cookie)).session.id
    await call('POST', `/v1/sessions/${id}/diagnose`, { cookie })
    const body = { body: 'まだ届いていない値を describe せずに読んでいた気がする' }

    const first = await call('POST', `/v1/sessions/${id}/conclusion`, { cookie, body })
    const second = await call('POST', `/v1/sessions/${id}/conclusion`, { cookie, body })
    expect(second.body.conclusion).toEqual(first.body.conclusion)
  })

  it('原因宣言もマスキングを通す（Judge に送られるため / FR-11）', async () => {
    const cookie = await signIn()
    const id = (await startSession(cookie)).session.id
    await call('POST', `/v1/sessions/${id}/diagnose`, { cookie })

    await call('POST', `/v1/sessions/${id}/conclusion`, {
      cookie,
      body: { body: '設定した sk-orca-abcdefghijklmnopqrstuvwx が原因かと思った' },
    })

    expect(JSON.stringify(store.dump('sessions'))).not.toContain('sk-orca-')
  })
})

describe('Gate C — 開示（FR-10）', () => {
  it('条件を満たさない開示要求は 409 GATE_NOT_UNLOCKED', async () => {
    const cookie = await signIn()
    const id = (await startSession(cookie)).session.id
    const res = await call('POST', `/v1/sessions/${id}/reveal`, { cookie })

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('GATE_NOT_UNLOCKED')
  })

  it('全段階を通過すると開示でき、振り返りが必須で付く', async () => {
    const cookie = await signIn()
    const id = (await startSession(cookie)).session.id
    await call('POST', `/v1/sessions/${id}/diagnose`, { cookie })
    let res = await call('POST', `/v1/sessions/${id}/advance`, { cookie })

    // 5 段階すべて正解で通過する
    for (let seq = 1; seq <= 5; seq += 1) {
      res = await call('POST', `/v1/sessions/${id}/answers`, {
        cookie,
        body: { questionId: res.body.question?.id ?? res.body.nextQuestion.id, selectedOptionId: correctOptionFor(id, seq) },
      })
    }
    expect(res.body.nextQuestion).toBeNull()
    expect(res.body.actions.canReveal).toBe(true)

    const revealed = await call('POST', `/v1/sessions/${id}/reveal`, { cookie })
    expect(revealed.status).toBe(200)
    expect(revealed.body.reveal.rootCause).toBeTruthy()
    expect(revealed.body.reveal.fixDirection).toBeTruthy()
    expect(revealed.body.retrospection.options.length).toBeGreaterThan(0)
    expect(revealed.body.session).toMatchObject({ gate: 'C', reachedGate: 'C' })

    // 再要求では同じ内容が返る（冪等）
    const again = await call('POST', `/v1/sessions/${id}/reveal`, { cookie })
    expect(again.body.reveal).toEqual(revealed.body.reveal)

    const done = await call('POST', `/v1/sessions/${id}/retrospect`, {
      cookie,
      body: { selectedOptionId: 'c' },
    })
    expect(done.body.session.status).toBe('completed')
  })
})

describe('レポートとスコア（FR-21 / FR-23 / NFR-F1）', () => {
  async function completedSession(cookie: string): Promise<string> {
    const id = (await startSession(cookie)).session.id
    await call('POST', `/v1/sessions/${id}/diagnose`, { cookie })
    await call('POST', `/v1/sessions/${id}/conclusion`, {
      cookie,
      body: { body: 'API 応答前の初回レンダリングで値が undefined だった' },
    })
    return id
  }

  it('未完了のセッションではレポートを出さない', async () => {
    const cookie = await signIn()
    const id = (await startSession(cookie)).session.id
    const res = await call('GET', `/v1/sessions/${id}/report`, { cookie })
    expect(res.status).toBe(409)
  })

  it('スコアと算出根拠を返す（説明できない数値を評価に使わせない）', async () => {
    const cookie = await signIn()
    const id = await completedSession(cookie)

    const res = await call('GET', `/v1/sessions/${id}/report`, { cookie })
    expect(res.status).toBe(200)
    expect(res.body.score.total).toBeGreaterThan(0)
    expect(res.body.score.gateFactor).toBe(1.0) // Gate A 到達
    expect(res.body.scoreExplanation.breakdown).toHaveLength(5)
    expect(res.body.scoreExplanation.formula).toContain('gate_factor')
    // 実務モードは横比較に使わない（NFR-F2）
    expect(res.body.score.comparable).toBe(false)
    expect(res.body.generalizedLesson).toBeTruthy()
  })

  it('2 回目のアクセスは生成せず保存済みを返す（member_stats の二重加算を防ぐ設計）', async () => {
    const cookie = await signIn()
    const id = await completedSession(cookie)

    const first = await call('GET', `/v1/sessions/${id}/report`, { cookie })
    const second = await call('GET', `/v1/sessions/${id}/report`, { cookie })

    expect(second.body.createdAt).toBe(first.body.createdAt)
    expect(store.dump('reports')).toHaveLength(1)
  })

  it('完了後のレポートでのみ答えを返す', async () => {
    const cookie = await signIn()
    const id = await completedSession(cookie)
    const res = await call('GET', `/v1/sessions/${id}/report`, { cookie })
    expect(res.body.revealedAnswer).toBe(MOCK_DIAGNOSIS.rootCause)
  })

  it('コストを返す。MOCK の呼び出しは記録しない（実測が 0 円で埋まらないように）', async () => {
    const cookie = await signIn()
    const id = await completedSession(cookie)

    const res = await call('GET', `/v1/sessions/${id}/cost`, { cookie })
    expect(res.status).toBe(200)
    // このテストは OPS_LOG_ENABLED=false で走っている
    expect(res.body.enabled).toBe(false)
    expect(res.body.note).toContain('OPS_LOG_ENABLED')
  })

  it('他人のセッションのコストは見られない（ops_logs は ownerId を持たない）', async () => {
    const owner = await signIn('cost-owner@example.com')
    const id = await completedSession(owner)
    const other = await signIn('cost-other@example.com')

    const res = await call('GET', `/v1/sessions/${id}/cost`, { cookie: other })
    expect(res.status).toBe(404)
  })

  it('履歴一覧と個人統計を返す（FR-14 / FR-24）', async () => {
    const cookie = await signIn()
    const id = await completedSession(cookie)
    await call('GET', `/v1/sessions/${id}/report`, { cookie })

    const list = await call('GET', '/v1/me/sessions', { cookie })
    expect(list.body.sessions).toHaveLength(1)
    expect(list.body.sessions[0]).toMatchObject({ id, reachedGate: 'A', status: 'completed' })
    expect(list.body.sessions[0].totalScore).toBeGreaterThan(0)

    const stats = await call('GET', '/v1/me/stats', { cookie })
    expect(stats.body.sessionCount).toBe(1)
    expect(stats.body.gateDistribution.A).toBe(1)
    expect(stats.body.selfReachRate).toBe(1)
    expect(stats.body.recentAxes).not.toBeNull()
    // 成長率と time_index は v0.2（セッション数が溜まらないと意味が出ない）
    expect(stats.body.growthRate).toBeUndefined()
  })
})

describe('他人のデータに触れない（security.md §2.2）', () => {
  it('他人のセッション ID を指定しても「見つからない」に着地する', async () => {
    const owner = await signIn('owner@example.com')
    const id = (await startSession(owner)).session.id

    const other = await signIn('other@example.com')
    for (const [method, path] of [
      ['GET', `/v1/sessions/${id}`],
      ['POST', `/v1/sessions/${id}/hints`],
      ['POST', `/v1/sessions/${id}/diagnose`],
      ['DELETE', `/v1/sessions/${id}`],
    ] as const) {
      const res = await call(method, path, { cookie: other })
      expect(res.status, `${method} ${path}`).toBe(404)
      expect(res.body.error.code).toBe('SESSION_NOT_FOUND')
    }
  })

  it('他人の履歴は一覧に出ない', async () => {
    const owner = await signIn('owner2@example.com')
    await startSession(owner)
    const other = await signIn('other2@example.com')

    const list = await call('GET', '/v1/me/sessions', { cookie: other })
    expect(list.body.sessions).toHaveLength(0)
  })
})

describe('答えが Gate C 到達前に漏れない（DoD #2）', () => {
  it('Gate A・B の全レスポンスに内部診断が含まれない', async () => {
    const cookie = await signIn()
    const collected: string[] = []
    const record = (res: { body: Json }) => collected.push(JSON.stringify(res.body))

    const created = await call('POST', '/v1/sessions', {
      cookie,
      body: { errorText: ERROR_TEXT, language: 'typescript' },
    })
    record(created)
    const id = created.body.session.id

    record(await call('POST', `/v1/sessions/${id}/diagnose`, { cookie }))
    record(await call('POST', `/v1/sessions/${id}/hints`, { cookie }))
    record(await call('POST', `/v1/sessions/${id}/hints`, { cookie }))
    record(await call('GET', `/v1/sessions/${id}`, { cookie }))

    let res = await call('POST', `/v1/sessions/${id}/advance`, { cookie })
    record(res)
    for (let seq = 1; seq <= 3; seq += 1) {
      const question = res.body.question ?? res.body.nextQuestion
      if (!question) break
      res = await call('POST', `/v1/sessions/${id}/answers`, {
        cookie,
        body: { questionId: question.id, selectedOptionId: correctOptionFor(id, seq) },
      })
      record(res)
    }
    record(
      await call('POST', `/v1/sessions/${id}/conclusion`, {
        cookie,
        body: { body: 'よく分からないが型の問題ではないかと思う' },
      }),
    )

    const all = collected.join('\n')
    // ★ 答えそのもの
    expect(all).not.toContain(MOCK_DIAGNOSIS.rootCause)
    // ★ 根拠（どこからそう言えるか）も Gate C 到達前には出さない
    for (const evidence of MOCK_DIAGNOSIS.evidence) expect(all).not.toContain(evidence)
    // ★ 正解 ID を持つフィールドが存在しない
    expect(all).not.toContain('correctOptionId')
    expect(all).not.toContain('rationaleIfWrong')
  })
})

describe('異常系で画面が止まらない（F12 / FR-17）', () => {
  it('不正な入力は 400 と原因を返す', async () => {
    const cookie = await signIn()
    const res = await call('POST', '/v1/sessions', { cookie, body: { errorText: '' } })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_INPUT')
    expect(res.body.error.detail).toBeTruthy()
  })

  it('20,000 文字を超える入力は受け付けない（コストの上限でもある）', async () => {
    const cookie = await signIn()
    const res = await call('POST', '/v1/sessions', {
      cookie,
      body: { errorText: 'x'.repeat(20_001) },
    })
    expect(res.status).toBe(400)
  })

  it('事前定義リストにない言語は受け付けない', async () => {
    const cookie = await signIn()
    const res = await call('POST', '/v1/sessions', {
      cookie,
      body: { errorText: ERROR_TEXT, language: 'malbolge' },
    })
    expect(res.status).toBe(400)
  })

  it('演習モードは v0.2 であることを伝える（黙って落とさない）', async () => {
    const cookie = await signIn()
    const res = await call('POST', '/v1/sessions', {
      cookie,
      body: { mode: 'assessment', errorText: ERROR_TEXT },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('v0.2')
  })

  it('データストア障害は 503 として、どの操作が失敗したかが分かる形で返る', async () => {
    const cookie = await signIn()
    store.failNext('putItem')

    const res = await call('POST', '/v1/sessions', { cookie, body: { errorText: ERROR_TEXT } })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('DATASTORE_UNAVAILABLE')
    // 「保存先に接続できません」だけでは切り分けられない（FR-17）
    expect(res.body.error.detail).toMatchObject({ operation: 'sessions.putItem' })
    // 例外メッセージに入力が混ざらない（security.md §2.3）
    expect(JSON.stringify(res.body)).not.toContain('ProductList')
  })

  it('本番設定では外部サービスのメッセージを返さない（security.md §2.3）', async () => {
    const cookie = await signIn()
    // MOCK_MODE / LOG_LEVEL=DEBUG のときだけ message を足す
    process.env['MOCK_MODE'] = 'false'
    process.env['LOG_LEVEL'] = 'INFO'
    store.failNext('putItem')

    const res = await call('POST', '/v1/sessions', { cookie, body: { errorText: ERROR_TEXT } })

    expect(res.body.error.detail.message).toBeUndefined()
    process.env['MOCK_MODE'] = 'true'
    delete process.env['LOG_LEVEL']
  })

  it('ULID でないセッション ID は 404（無駄なデータストアアクセスを消費しない）', async () => {
    const cookie = await signIn()
    const res = await call('GET', '/v1/sessions/not-a-ulid', { cookie })
    expect(res.status).toBe(404)
  })
})

describe('レート制限（NFR-O3 / F04）', () => {
  it('1 時間あたりの上限を超えるとセッションを作れない', async () => {
    process.env['RATE_LIMIT_SESSIONS_PER_HOUR'] = '2'
    const cookie = await signIn('rate@example.com')

    await startSession(cookie)
    await startSession(cookie)
    const third = await call('POST', '/v1/sessions', { cookie, body: { errorText: ERROR_TEXT } })

    expect(third.status).toBe(429)
    expect(third.body.error.code).toBe('RATE_LIMITED')
    delete process.env['RATE_LIMIT_SESSIONS_PER_HOUR']
  })

  /**
   * 画面に「あと約 N 分」を出すための値。**これが無いと「しばらく待って」としか
   * 言えず、待てば済むのか設定を見直すべきなのかを利用者が判断できない。**
   * 同一オリジン配信（ADR-012）なので、ブラウザからヘッダをそのまま読める。
   */
  it('429 には待ち時間が Retry-After で載る', async () => {
    process.env['RATE_LIMIT_SESSIONS_PER_HOUR'] = '1'
    const cookie = await signIn('retry-after@example.com')

    await startSession(cookie)
    const blocked = await call('POST', '/v1/sessions', { cookie, body: { errorText: ERROR_TEXT } })

    expect(blocked.status).toBe(429)
    const retryAfter = Number(blocked.headers.get('retry-after'))
    expect(Number.isFinite(retryAfter)).toBe(true)
    expect(retryAfter).toBeGreaterThan(0)
    // 窓は 1 時間。直前に作ったばかりなので、ほぼ 1 時間が残っている
    expect(retryAfter).toBeLessThanOrEqual(3600)
    delete process.env['RATE_LIMIT_SESSIONS_PER_HOUR']
  })

  /**
   * MOCK_MODE が消すのは LLM だけ（ADR-014）。レート制限は
   * データストア上の実データで判定するため、モックでも同じように効く。
   * このテスト自体が MOCK_MODE=true で走っていることが、その担保になっている。
   */
  it('MOCK_MODE でもレート制限は効く（消えるのは LLM だけ）', async () => {
    expect(ENV.MOCK_MODE).toBe('true')
    process.env['RATE_LIMIT_SESSIONS_PER_HOUR'] = '1'
    const cookie = await signIn('mock-rate@example.com')

    await startSession(cookie)
    const blocked = await call('POST', '/v1/sessions', { cookie, body: { errorText: ERROR_TEXT } })

    expect(blocked.status).toBe(429)
    delete process.env['RATE_LIMIT_SESSIONS_PER_HOUR']
  })
})

describe('セッション削除（NFR-S7）', () => {
  it('関連アイテムをすべて消す（CASCADE がないため明示的に削除する）', async () => {
    const cookie = await signIn()
    const id = (await startSession(cookie)).session.id
    await call('POST', `/v1/sessions/${id}/diagnose`, { cookie })
    await call('POST', `/v1/sessions/${id}/advance`, { cookie })

    expect(store.dump('secrets').length).toBeGreaterThan(0)

    const res = await call('DELETE', `/v1/sessions/${id}`, { cookie })
    expect(res.status).toBe(200)
    expect(store.dump('sessions')).toHaveLength(0)
    expect(store.dump('secrets')).toHaveLength(0)
  })
})
