import { serve } from '@hono/node-server'
import { app } from './app'

/**
 * ローカル起動（Lambda なし）。デプロイ前の動作確認に使う（NFR-Q3）。
 *   pnpm --filter @socrametry/function dev
 */
const port = Number(process.env['PORT'] ?? 8787)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`SocraMetry function listening on http://localhost:${info.port}`)
})
