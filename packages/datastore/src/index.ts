/**
 * `@socrametry/datastore` — enebular データストアのリポジトリ層。
 *
 * テーブルごとにファイルを分けている。`getItem` が**アイテム全体を返す**ため、
 * リレーショナル DB のようなカラム単位の防御ができず、
 * **テーブル分離が唯一の隔離手段**だからである（ADR-005）。
 *
 * `secret-repo` だけが答え（`rootCause` / `correctOptionId`）に触れてよい。
 */

export * from './client'
export * from './owner'
export * from './tables'
export * from './types'

export * as userRepo from './user-repo'
export * as sessionRepo from './session-repo'
export * as secretRepo from './secret-repo'
export * as reportRepo from './report-repo'
export * as opsRepo from './ops-repo'
