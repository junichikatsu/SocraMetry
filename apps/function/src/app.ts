import { Hono } from 'hono'

/** ビルド時に埋め込まれた情報。tsx でのローカル起動時は定義されない */
const buildInfo =
  typeof __BUILD_INFO__ !== 'undefined'
    ? __BUILD_INFO__
    : { version: 'dev', commit: 'local', builtAt: 'local' }

/**
 * アプリ本体のルート定義。
 * HTTP トリガーは 1 パスしか持てないため、Hono で内部ルーティングする（ADR-009）。
 */
function createRoutes() {
  const routes = new Hono()

  /**
   * ヘルスチェック（api-spec.md §GET /v1/health）。
   * 認証不要の唯一のエンドポイント。CI のスモークテストがここを叩く。
   *
   * commit を返すのは、「デプロイしたつもりのコミットが実際に動いているか」を
   * 目視ではなく機械的に確認するため。ZIP の差し替え漏れはこれで気づける。
   */
  routes.get('/v1/health', (c) =>
    c.json({
      status: 'ok',
      version: buildInfo.version,
      commit: buildInfo.commit,
      builtAt: buildInfo.builtAt,
      mockMode: process.env['MOCK_MODE'] === 'true',
    }),
  )

  return routes
}

/**
 * enebular の HTTP トリガーは、トリガーのパス（例 `/socrametry`）を**含めた**
 * パスでハンドラを呼ぶ。一方ローカル起動やテストでは付かない（ADR-009 / 実測）。
 *
 * ルートを 3 通りにマウントして、どちらの経路でも同じルートに届くようにする。
 *
 * | マウント    | 届くパス                                   |
 * |------------|-------------------------------------------|
 * | `/`        | `/v1/health`（ローカル・テスト）            |
 * | `/:base`   | `/socrametry/v1/health`（トリガー経由）      |
 * | `/:base/`  | `/socrametry/`（トリガーのルート URL）       |
 *
 * **トリガーのパスを環境変数で持たない。** 設定した値とトリガーの実設定が
 * ずれると全リクエストが 404 になり、原因が分かりにくい。
 * 先頭セグメントを問わない形にすれば、その設定自体が要らなくなる。
 */
export function createApp() {
  const app = new Hono()

  app.route('/', createRoutes())
  app.route('/:base', createRoutes())
  app.route('/:base/', createRoutes())

  /**
   * 受け取ったパスを返す。トリガーのイベント形式が想定と違ったとき、
   * ログを掘らずにレスポンスだけで原因が分かる（FR-17 / 異常系で止まらない）。
   */
  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: 'Not Found',
          path: c.req.path,
          method: c.req.method,
        },
      },
      404,
    ),
  )

  return app
}

export const app = createApp()
