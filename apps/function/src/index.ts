import { handle } from 'hono/aws-lambda'
import { app } from './app'
import { logConfigIssues } from './config'

// コールドスタート時に 1 回だけ、設定漏れをログへ出す（キー名はここにしか出ない）
logConfigIssues()

/**
 * enebular クラウド実行環境のエントリポイント。
 * ハンドラ指定は index.handler（ZIP デプロイの要件 / deployment.md §2.1）。
 *
 * esbuild が CommonJS へ変換するため、この ESM の export が
 * バンドル後は module.exports.handler として公開される。
 */
export const handler = handle(app)
