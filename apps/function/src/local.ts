import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { app } from './app'
import { logConfigIssues } from './config'
import { setStaticAssetLoader } from './static'

logConfigIssues()

/**
 * ローカルでは静的ファイルを**リクエストごとにディスクから読む**（ADR-012）。
 *
 * HTML / CSS を編集したら、ビルドせずにリロードだけで反映される。
 * この読み込みは `local.ts` にだけ置く。ZIP のエントリポイントは `index.ts` なので、
 * **Lambda 側のバンドルに `node:fs` が入らない。**
 *
 * `app.js` だけは生成物（ADR-013）なので、`pnpm dev:web` の監視ビルドを
 * 併走させる。読めない場合はここで WARN を出し、起動自体は止めない。
 */
setStaticAssetLoader((name) => {
  const path = fileURLToPath(new URL(`../../web/public/${name}`, import.meta.url))
  try {
    return readFileSync(path, 'utf8')
  } catch {
    console.warn(`静的ファイルが読めません: ${path}`)
    return null
  }
})

/**
 * ローカル起動（Lambda なし）。デプロイ前の動作確認に使う（NFR-Q3）。
 *   pnpm --filter @socrametry/function dev
 */
const port = Number(process.env['PORT'] ?? 8787)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`SocraMetry function listening on http://localhost:${info.port}`)
})
