/**
 * `@socrametry/shared` — API 契約（公開型 + Zod スキーマ）。
 *
 * **このパッケージに内部診断と正解を定義しない。**
 * `rootCause` / `evidence` / `confidence` / `correctOptionId` は
 * `@socrametry/datastore` の内部型にのみ存在し、データストア上も
 * `session_secrets` テーブルに隔離されている（ADR-005 / api-spec.md §1 ★）。
 */

export * from './types/domain'
export * from './types/public'

export * from './schemas/common'
export * from './schemas/auth'
export * from './schemas/session'
export * from './schemas/answer'
