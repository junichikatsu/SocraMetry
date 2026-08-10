import { Hono } from 'hono'
import { checkConfig } from './config'
import { requireAuth, type AppEnv } from './middleware/auth'
import { toErrorResponse } from './middleware/error-handler'
import { authRoutes } from './routes/auth'
import { gateRoutes } from './routes/gates'
import { reportRoutes } from './routes/reports'
import { sessionRoutes } from './routes/sessions'

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
  const routes = new Hono<AppEnv>()

  /**
   * ヘルスチェック（api-spec.md §GET /v1/health）。
   * 認証不要の唯一のエンドポイント。CI のスモークテストがここを叩く。
   *
   * commit を返すのは、「デプロイしたつもりのコミットが実際に動いているか」を
   * 目視ではなく機械的に確認するため。ZIP の差し替え漏れはこれで気づける。
   *
   * configOk は環境変数の設定漏れの有無（config.ts）。CI のスモークテストが
   * これを見て落ちるため、設定漏れがデプロイのたびに自動で検出される。
   * **不足しているキー名はここに出さない。** このエンドポイントは認証不要のため、
   * 名前は起動時のログにだけ出す。
   */
  routes.get('/v1/health', (c) => {
    const configIssues = checkConfig()

    return c.json({
      status: 'ok',
      version: buildInfo.version,
      commit: buildInfo.commit,
      builtAt: buildInfo.builtAt,
      mockMode: process.env['MOCK_MODE'] === 'true',
      configOk: configIssues.length === 0,
      configMissing: configIssues.length,
    })
  })

  /**
   * **認証の適用をここ 1 箇所にまとめる。**
   * 各ルートファイルで `requireAuth` を書く方式にすると、
   * ルートを追加したときに書き忘れる。忘れられる防御は防御ではない。
   *
   * `/v1/health` と `/v1/auth/*` だけが認証不要（api-spec.md §1）。
   */
  for (const path of ['/v1/sessions', '/v1/sessions/*', '/v1/me', '/v1/me/*']) {
    routes.use(path, requireAuth)
  }

  routes.route('/', authRoutes)
  routes.route('/', sessionRoutes)
  routes.route('/', gateRoutes)
  routes.route('/', reportRoutes)

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
  const app = new Hono<AppEnv>()

  app.route('/', createRoutes())
  app.route('/:base', createRoutes())
  app.route('/:base/', createRoutes())

  /**
   * 例外を JSON のエラーレスポンスに変換する（F12 / FR-17）。
   *
   * **ここを通らない経路を作らない。** 各ルートで try/catch を書くと変換漏れが起き、
   * 500 が素で出て「画面が止まらず原因が表示される」を満たせなくなる。
   */
  app.onError((err, c) => toErrorResponse(err, c))

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
