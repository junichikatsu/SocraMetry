import { afterEach, describe, expect, it } from 'vitest'
import { app } from './app'
import { ASSETS, setStaticAssetLoader, type AssetName } from './static'

/**
 * 静的ファイルの同一オリジン配信（ADR-012）。
 *
 * ビルド時の define がテストでは定義されないため、
 * `local.ts` と同じ差し込み口でダミーを入れて経路だけを検証する。
 */

const FAKE: Record<AssetName, string> = {
  'index.html': '<!doctype html><title>SocraMetry</title>',
  'styles.css': 'body { margin: 0 }',
  'app.js': 'console.log("ok")',
}

afterEach(() => {
  setStaticAssetLoader(null)
})

describe('GET /', () => {
  it('HTML を返す', async () => {
    setStaticAssetLoader((name) => FAKE[name])
    const res = await app.request('/')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    await expect(res.text()).resolves.toContain('SocraMetry')
  })

  it('デプロイが即反映されるようキャッシュさせない（デモ中に古い画面を出さない）', async () => {
    setStaticAssetLoader((name) => FAKE[name])
    const res = await app.request('/')

    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  it('ビルドに埋め込まれていなければ、白い画面ではなく原因を返す', async () => {
    const res = await app.request('/')

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'ASSET_NOT_BUILT' } })
  })

  /**
   * `cache-control: no-cache` が効くのは HTML だけだった。実行環境の前段が
   * `.css` / `.js` に `max-age=14400` を上書きするため、**ヘッダでは止められない。**
   * URL を変えるしかないので、HTML 側に版を差し込んでいる。
   */
  it('CSS と JS の URL に版が入る（前段のキャッシュを跨ぐ唯一の手段）', async () => {
    setStaticAssetLoader(() => '<link href="styles.css?v=__ASSET_VERSION__"><script src="app.js?v=__ASSET_VERSION__">')
    const html = await (await app.request('/')).text()

    // 置換され、目印が残っていないこと
    expect(html).not.toContain('__ASSET_VERSION__')
    const versions = [...html.matchAll(/\?v=([^"']+)/g)].map((m) => m[1])
    expect(versions).toHaveLength(2)
    expect(versions[0]).toBeTruthy()
    // CSS と JS で同じ版になる（片方だけ古い、が起きない）
    expect(versions[0]).toBe(versions[1])
  })

  it('版を差し込むのは HTML だけ（CSS / JS の中身は書き換えない）', async () => {
    setStaticAssetLoader(() => 'content: "__ASSET_VERSION__"')
    const css = await (await app.request('/styles.css')).text()

    expect(css).toContain('__ASSET_VERSION__')
  })
})

describe('各アセット', () => {
  it('正しい Content-Type で返す', async () => {
    setStaticAssetLoader((name) => FAKE[name])

    const expected: Record<AssetName, string> = {
      'index.html': 'text/html',
      'styles.css': 'text/css',
      'app.js': 'text/javascript',
    }
    for (const name of ASSETS) {
      const res = await app.request(`/${name}`)
      expect(res.status, name).toBe(200)
      expect(res.headers.get('content-type'), name).toContain(expected[name])
    }
  })
})

describe('HTTP トリガーのパス配下（ADR-009 / ADR-012）', () => {
  it('末尾スラッシュ付きなら HTML を返す', async () => {
    setStaticAssetLoader((name) => FAKE[name])
    const res = await app.request('/socrametry/')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  /**
   * 末尾スラッシュがないと、HTML の `href="styles.css"` が
   * トリガーの外（`/styles.css`）に解決されてスタイルも JS も読めなくなる。
   */
  it('末尾スラッシュなしはスラッシュ付きへリダイレクトする', async () => {
    setStaticAssetLoader((name) => FAKE[name])
    const res = await app.request('/socrametry')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/socrametry/')
  })

  it('トリガーのパス配下でもアセットが届く', async () => {
    setStaticAssetLoader((name) => FAKE[name])

    for (const name of ASSETS) {
      const res = await app.request(`/socrametry/${name}`)
      expect(res.status, name).toBe(200)
    }
  })
})

describe('API を隠さない', () => {
  it('静的配信を足しても /v1/health は届く', async () => {
    setStaticAssetLoader((name) => FAKE[name])
    const res = await app.request('/v1/health')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ status: 'ok' })
  })

  it('認証が要る API は 401 のまま（静的ファイルとして扱われない）', async () => {
    setStaticAssetLoader((name) => FAKE[name])
    const res = await app.request('/v1/me')

    expect(res.status).toBe(401)
  })
})
