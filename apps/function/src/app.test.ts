import { describe, expect, it } from 'vitest'
import { app, createApp } from './app'

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

// enebular の HTTP トリガーはトリガーパスを含めたパスでハンドラを呼ぶ。
// ローカル・テストでは付かないため、両方で同じルートに届く必要がある。
describe('HTTP トリガーのパス配下', () => {
  const withTrigger = createApp('/socrametry')

  it('トリガーパスを含むパスで届く', async () => {
    const res = await withTrigger.request('/socrametry/v1/health')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ status: 'ok' })
  })

  it('トリガーパスを含まないパスでも届く', async () => {
    const res = await withTrigger.request('/v1/health')

    expect(res.status).toBe(200)
  })

  it('末尾スラッシュ付きの設定でも同じ結果になる', async () => {
    const res = await createApp('/socrametry/').request('/socrametry/v1/health')

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
    const res = await createApp('/socrametry').request('/stage/v1/health')

    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'NOT_FOUND', path: '/stage/v1/health', triggerPath: '/socrametry' },
    })
  })
})
