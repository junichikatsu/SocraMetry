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
