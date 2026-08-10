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

describe('未定義のパス', () => {
  it('404 を JSON で返す（HTML のエラーページを返さない）', async () => {
    const res = await app.request('/v1/does-not-exist')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
  })
})
