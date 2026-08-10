import { describe, expect, it } from 'vitest'
import { app } from './app'

describe('GET /v1/health', () => {
  it('200 と status: ok を返す', async () => {
    const res = await app.request('/v1/health')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ status: 'ok' })
  })

  it('MOCK_MODE の状態を返す（本番で true のまま公開していないか確認できる）', async () => {
    process.env['MOCK_MODE'] = 'true'
    const res = await app.request('/v1/health')

    await expect(res.json()).resolves.toMatchObject({ mockMode: true })
    delete process.env['MOCK_MODE']
  })
})

// CI のスモークテストがこの configOk を見て落ちる。
// 設定漏れがデプロイのたびに自動で検出される仕組み。
// 環境変数とコードの既定値のどちらが効いているかは、外から見えないと切り分けられない。
// 実際に「環境変数を消したのに古い値が効いたまま」で LLM 呼び出しを無駄にした。
describe('GET /v1/health の出力上限', () => {
  it('実際に効いている max_tokens を返す', async () => {
    const res = await app.request('/v1/health')
    const body = (await res.json()) as { limits: Record<string, number> }

    expect(body.limits.diagnoser).toBe(1600)
    expect(body.limits.questioner).toBe(900)
  })

  it('環境変数で上書きされていればその値が出る', async () => {
    process.env['MAX_TOKENS_DIAGNOSER'] = '800'
    const res = await app.request('/v1/health')
    const body = (await res.json()) as { limits: Record<string, number> }

    expect(body.limits.diagnoser).toBe(800)
    delete process.env['MAX_TOKENS_DIAGNOSER']
  })
})

describe('GET /v1/health の設定チェック', () => {
  const REQUIRED = {
    MOCK_MODE: 'true',
    OPS_LOG_ENABLED: 'false',
    DS_TABLE_USERS: 'u',
    DS_TABLE_SESSIONS: 's',
    DS_TABLE_SECRETS: 'x',
    DS_TABLE_REPORTS: 'r',
    SESSION_JWT_SECRET: 'secret',
    INVITE_CODE: 'code',
  }
  const setEnv = (v: Record<string, string | undefined>) => {
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) delete process.env[k]
      else process.env[k] = val
    }
  }
  const clear = () => setEnv(Object.fromEntries(Object.keys(REQUIRED).map((k) => [k, undefined])))

  it('設定が揃っていれば configOk: true', async () => {
    setEnv(REQUIRED)
    const res = await app.request('/v1/health')

    await expect(res.json()).resolves.toMatchObject({ configOk: true, configMissing: 0 })
    clear()
  })

  it('不足があれば configOk: false と件数を返す', async () => {
    setEnv({ ...REQUIRED, DS_TABLE_SECRETS: undefined, INVITE_CODE: undefined })
    const res = await app.request('/v1/health')

    await expect(res.json()).resolves.toMatchObject({ configOk: false, configMissing: 2 })
    clear()
  })

  it('不足しているキー名を公開しない（認証不要のエンドポイントのため）', async () => {
    setEnv({ ...REQUIRED, DS_TABLE_SECRETS: undefined })
    const body = await (await app.request('/v1/health')).text()

    expect(body).not.toContain('DS_TABLE_SECRETS')
    clear()
  })
})

// enebular の HTTP トリガーはトリガーパスを含めたパスでハンドラを呼ぶ（実測）。
// ローカル・テストでは付かないため、両方で同じルートに届く必要がある。
describe('HTTP トリガーのパス配下', () => {
  it('トリガーパスを含むパスで届く', async () => {
    const res = await app.request('/socrametry/v1/health')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ status: 'ok' })
  })

  it('トリガーパス名に依存しない（環境変数での設定を不要にしている）', async () => {
    const res = await app.request('/any-other-trigger-name/v1/health')

    expect(res.status).toBe(200)
  })
})

describe('未定義のパス', () => {
  it('404 を JSON で返す（HTML のエラーページを返さない）', async () => {
    const res = await app.request('/v1/does-not-exist')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('受け取ったパスを返す（トリガーの形式が想定と違うときの手掛かり）', async () => {
    const res = await app.request('/socrametry/v1/nope')

    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'NOT_FOUND', path: '/socrametry/v1/nope' },
    })
  })

  it('セグメントを 2 つ以上前置したパスは通さない', async () => {
    const res = await app.request('/a/b/v1/health')

    expect(res.status).toBe(404)
  })
})
