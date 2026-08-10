import { Hono } from 'hono'

/**
 * HTTP トリガーは 1 パスしか持てないため、Hono で内部ルーティングする（ADR-009）。
 * ここに置いた app を index.ts が Lambda ハンドラへ、local.ts が Node サーバへ渡す。
 * 同じ app を使うことで、ローカルでの確認と本番の経路が一致する。
 */
export const app = new Hono()

/** ビルド時に埋め込まれた情報。tsx でのローカル起動時は定義されない */
const buildInfo =
  typeof __BUILD_INFO__ !== 'undefined'
    ? __BUILD_INFO__
    : { version: 'dev', commit: 'local', builtAt: 'local' }

/**
 * ヘルスチェック（api-spec.md §GET /v1/health）。
 * 認証不要の唯一のエンドポイント。CI のスモークテストがここを叩く。
 *
 * commit を返すのは、「デプロイしたつもりのコミットが実際に動いているか」を
 * 目視ではなく機械的に確認するため。ZIP の差し替え漏れはこれで気づける。
 */
app.get('/v1/health', (c) =>
  c.json({
    status: 'ok',
    version: buildInfo.version,
    commit: buildInfo.commit,
    builtAt: buildInfo.builtAt,
    mockMode: process.env['MOCK_MODE'] === 'true',
  }),
)

app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Not Found' } }, 404))
