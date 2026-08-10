import { DataStoreError } from './client'

/**
 * テーブル ID の解決（architecture.md §7 / deployment.md §3.1）。
 *
 * テーブルは enebular コンソールで作成し、払い出された UUID を
 * `envVars` で渡す。**コード側にテーブル ID を書かない。**
 */

export const TABLE_ENV_KEYS = {
  users: 'DS_TABLE_USERS',
  sessions: 'DS_TABLE_SESSIONS',
  /** ★非公開。内部診断と正解を隔離しているテーブル（ADR-005） */
  secrets: 'DS_TABLE_SECRETS',
  reports: 'DS_TABLE_REPORTS',
  opsLogs: 'DS_TABLE_OPS_LOGS',
} as const

export type TableName = keyof typeof TABLE_ENV_KEYS

/**
 * 未設定は `DataStoreError` にする。
 *
 * 起動を止めない（deployment.md §6）方針のため、設定漏れはここで
 * リクエスト単位のエラーとして表面化させる。`/v1/health` は落ちず、
 * `configOk: false` で設定漏れを報告できる状態を保つ。
 */
export function tableId(name: TableName): string {
  const key = TABLE_ENV_KEYS[name]
  const value = (process.env[key] ?? '').trim()
  if (value === '') throw new DataStoreError(`resolve-table:${name}`, 'unset')
  return value
}
