import { getDataStoreClient, run, runGet } from './client'
import { tableId } from './tables'
import type { UserItem } from './types'

/**
 * `users` テーブル（data-model.md §3.9 / FR-31a）。
 *
 * キー: `email`（メイン） / `kind`（サブ, `"account"` 固定）
 *
 * **アクセスパターンは 1 つだけ。** ログイン時に `getItem` するのみで、
 * メールアドレスがそのままメインキーなので二次インデックスを必要としない。
 */

const KIND = 'account' as const

export async function getUserByEmail(email: string): Promise<UserItem | null> {
  const params = await runGet('users.getItem', () =>
    getDataStoreClient().getItem({ tableId: tableId('users'), key: { email, kind: KIND } }),
  )
  return (params?.Item as UserItem | undefined) ?? null
}

export async function putUser(item: UserItem): Promise<void> {
  await run('users.putItem', () =>
    getDataStoreClient().putItem({ tableId: tableId('users'), item }),
  )
}
