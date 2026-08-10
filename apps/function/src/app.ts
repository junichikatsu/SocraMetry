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
 * パスでハンドラを呼ぶ。一方ローカル起動やテストでは付かない。
 *
 * どちらでも動くように、ルートを「素のパス」と「トリガーパス配下」の
 * 両方にマウントする。環境ごとに URL の組み立てを変えずに済む。
 *
 * @param triggerPath 例 `/socrametry`。空なら素のパスにのみマウントする
 */
export function createApp(triggerPath = process.env['HTTP_TRIGGER_PATH'] ?? '') {
  const normalized = triggerPath.trim().replace(/\/+$/, '')
  const app = new Hono()

  app.route('/', createRoutes())
  if (normalized) app.route(normalized, createRoutes())

  /**
   * 受け取ったパスを返す。トリガーの実際のイベント形式が想定と違ったとき、
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
          triggerPath: normalized || null,
        },
      },
      404,
    ),
  )

  return app
}

export const app = createApp()
