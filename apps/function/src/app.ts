import { Hono } from 'hono'
import { checkConfig, demoMaxStages, opsLogEnabled } from './config'
import { resolveTotalStages } from '@socrametry/core'
import { maxTokensFor, usdJpyRate } from '@socrametry/llm'
import { requireAuth, type AppEnv } from './middleware/auth'
import { toErrorResponse } from './middleware/error-handler'
import { authRoutes } from './routes/auth'
import { gateRoutes } from './routes/gates'
import { reportRoutes } from './routes/reports'
import { sessionRoutes } from './routes/sessions'
import { createStaticRoutes } from './static'

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
      /**
       * **実際に効いている出力上限**（F04）。
       *
       * 環境変数とコードの既定値のどちらが効いているかは、外から見えないと
       * 切り分けられない。実際に「環境変数を消したのに古い値が効いたまま」で
       * LLM 呼び出しを 2 回無駄にした。
       *
       * 出すのは上限値だけで、モデル ID も鍵も出さない。
       * 秘匿情報ではないが、認証不要のエンドポイントなので最小限にとどめる。
       */
      limits: {
        /**
         * Gate B で出題する段階数（`DEMO_MAX_STAGES`）。
         * これが 3 だと 5 軸のうち 2 つが「出題対象外」になる。
         * 設定が効いているかを LLM を呼ばずに確認できるようにしておく
         */
        stages: resolveTotalStages(demoMaxStages()),
        diagnoser: maxTokensFor('diagnoser'),
        hinter: maxTokensFor('hinter'),
        questioner: maxTokensFor('questioner'),
        judge: maxTokensFor('judge'),
        revealer: maxTokensFor('revealer'),
        reporter: maxTokensFor('reporter'),
        /**
         * 円換算に使っているレート（`USD_JPY_RATE`）。
         *
         * **コストログの円が何を基準にしているかは、外から見えないと分からない。**
         * 実際に、実行環境が 165 なのに設計書とコードの既定が 150 のまま
         * 混在し、レビューで指摘されるまで気づかなかった。
         * 為替レートは秘匿情報ではない。
         */
        usdJpyRate: usdJpyRate(),
        /**
         * `ops_logs` への記録が有効か（`OPS_LOG_ENABLED`）。
         *
         * **無効だと、課金されているのにコストの記録が残らない。**
         * しかも `GET /cost` は「呼び出し 0 件」を返すため、
         * MOCK モードのセッションと見分けがつかない。
         * 実際にこれで 4 セッション分の計測を取り逃した。
         *
         * v0.1 は実測コスト表（F11）のため**有効が既定**である
         * （data-model.md §7）。
         */
        opsLog: opsLogEnabled(),
      },
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

  // フロントエンドを同一オリジンで配信する（ADR-012）。
  // API より後に置く。`/` と `/app.js` しか持たないため衝突はしないが、
  // 静的ファイルが API を隠す可能性を構造的に作らない
  routes.route('/', createStaticRoutes())

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
