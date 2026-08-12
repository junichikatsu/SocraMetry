/**
 * `@socrametry/llm` — OrcaRouter クライアントとプロンプト。
 *
 * 依存は `@socrametry/shared` のみ。**`core` にも `datastore` にも依存しない**
 * （architecture.md「依存の向き」）。
 *
 * LeakGuard（`@socrametry/core`）の適用と再生成の判断は `apps/function` の
 * サービス層が行う。このパッケージは「生成する」ことだけを担当する。
 */

export * from './models'
export * from './pricing'
export * from './orca-client'
export * from './schemas'
export * from './roles'
export * from './mock'
export * from './fallbacks'
export { STAGE_LABELS } from './prompts'
