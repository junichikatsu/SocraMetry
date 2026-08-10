import { getDataStoreClient, unwrap } from './client'
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
  const result = await getDataStoreClient().getItem({
    tableId: tableId('users'),
    key: { email, kind: KIND },
  })
  const item = unwrap('users.getItem', result)?.Item
  return (item as UserItem | undefined) ?? null
}

export async function putUser(item: UserItem): Promise<void> {
  await getDataStoreClient()
    .putItem({ tableId: tableId('users'), item })
    .then((r) => unwrap('users.putItem', r))
}
