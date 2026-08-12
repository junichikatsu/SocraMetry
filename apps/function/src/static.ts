import type { Context } from 'hono'
import { Hono } from 'hono'

/**
 * 静的ファイルの配信（ADR-012）。
 *
 * **フロントエンドを別ホスティングに置かず、関数がそのまま返す。**
 * これで CORS 設定・`SameSite=None` の Cookie 問題・デプロイ先 2 系統・
 * API ベース URL の環境変数が、まとめて消える。
 *
 * ファイルの中身は**ビルド時に文字列として埋め込む**（`build.mjs` の define）。
 * Lambda のファイルシステム読み込みが不要になり、ZIP の中身は
 * `index.js` と `package.json` の 2 つだけで済む。
 *
 * > `import indexHtml from './public/index.html'`（ADR-012 のコード例）は
 * > **採らなかった。** 静的ファイルを text ローダで取り込むには拡張子ごとに
 * > `loader` を指定することになり、`app.js` のために `'.js': 'text'` を
 * > 設定すると**バンドル対象の TypeScript / 依存パッケージまで文字列になる。**
 * > 既に `__BUILD_INFO__` で使っている define と同じ仕組みに寄せた。
 */

const ASSETS = ['index.html', 'styles.css', 'app.js'] as const
export type AssetName = (typeof ASSETS)[number]

const CONTENT_TYPES: Record<AssetName, string> = {
  'index.html': 'text/html; charset=utf-8',
  'styles.css': 'text/css; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
}

/** ビルド時に埋め込まれた中身。tsx でのローカル起動時は定義されない */
const embedded: Partial<Record<AssetName, string>> =
  typeof __STATIC_ASSETS__ !== 'undefined' ? __STATIC_ASSETS__ : {}

type AssetLoader = (name: AssetName) => string | null

let loader: AssetLoader | null = null

/**
 * ローカル起動時に、ディスクから読む関数を差し込む（`local.ts` から呼ぶ）。
 *
 * **リクエストごとに読み直す**ことで、HTML / CSS / JS を編集したら
 * リロードだけで反映される。ビルドを挟むと反復が遅くなる。
 * 本番（ZIP）では使わないため、Lambda 側に `node:fs` を持ち込まない。
 */
export function setStaticAssetLoader(fn: AssetLoader | null): void {
  loader = fn
}

function assetBody(name: AssetName): string | null {
  return loader?.(name) ?? embedded[name] ?? null
}

export function createStaticRoutes(): Hono {
  const routes = new Hono()

  /**
   * トリガーのパス直下（`/socrametry`）に来た場合は、**末尾スラッシュ付きへ寄せる。**
   *
   * `/socrametry` のままだと、HTML の `href="styles.css"` が
   * `/styles.css`（＝トリガーの外）に解決されてしまい、
   * プラットフォーム側で 404 になって**スタイルも JS も読めない**。
   * ローカル（`/`）は既に末尾スラッシュなので影響しない。
   */
  routes.get('/', (c) => {
    const path = c.req.path
    if (!path.endsWith('/')) return c.redirect(`${path}/`, 302)
    return sendAsset(c, 'index.html')
  })

  for (const name of ASSETS) {
    routes.get(`/${name}`, (c) => sendAsset(c, name))
  }

  return routes
}

function sendAsset(c: Context, name: AssetName): Response {
  const body = assetBody(name)
  if (body === null) {
    // ビルド漏れを「白い画面」ではなく原因が読める形で返す（FR-17）
    return c.json(
      {
        error: {
          code: 'ASSET_NOT_BUILT',
          message: `静的ファイル ${name} が埋め込まれていません`,
          detail: null,
        },
      },
      500,
    )
  }

  return c.body(body, 200, {
    'content-type': CONTENT_TYPES[name],
    // CDN を挟まない構成なので、キャッシュより「デプロイが即反映される」を取る。
    // デモ中に古い画面が出る方が損失が大きい
    'cache-control': 'no-cache',
  })
}

export { ASSETS }
