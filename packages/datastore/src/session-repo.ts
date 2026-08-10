import { getDataStoreClient, unwrap } from './client'
import type { OwnerId } from './owner'
import { tableId } from './tables'
import type { SessionItem } from './types'

/**
 * `sessions` テーブル（data-model.md §3.1）。
 *
 * キー: `ownerId`（メイン） / `sessionId`（サブ, ULID）
 *
 * **1 セッション = 1 アイテム**（D1）。ターンごとにアイテムを分けると
 * アクセス回数が線形に増え、E4（月次アクセス上限）に当たる。
 */

/**
 * enebular データストアの `order` は **true が降順**（SDK のドキュメント準拠）。
 *
 * data-model.md A2 の例は `order: false` で「新しい順」と書かれているが、
 * SDK の定義（`false` = ascending / `true` = descending）と矛盾するため、
 * **実装は SDK に合わせる。** ULID は生成時刻順に並ぶので、降順 = 新しい順になる。
 */
const ORDER_DESC = true

export async function getSession(
  owner: OwnerId,
  sessionId: string,
): Promise<SessionItem | null> {
  const result = await getDataStoreClient().getItem({
    tableId: tableId('sessions'),
    // ★ メインキーに ownerId を含めるため、他人の sessionId では引けない
    key: { ownerId: owner, sessionId },
  })
  const item = unwrap('sessions.getItem', result)?.Item
  return (item as SessionItem | undefined) ?? null
}

export async function putSession(item: SessionItem): Promise<void> {
  await getDataStoreClient()
    .putItem({ tableId: tableId('sessions'), item })
    .then((r) => unwrap('sessions.putItem', r))
}

export type SessionPage = {
  sessions: SessionItem[]
  nextStartKey: string | null
}

/**
 * 自分のセッション履歴を新しい順に一覧する（A2 / FR-14）。
 * ページングはデータストアの `startKey` をそのまま透過させる（api-spec.md §3.9）。
 */
export async function listSessions(
  owner: OwnerId,
  options: { limit?: number; startKey?: string } = {},
): Promise<SessionPage> {
  const result = await getDataStoreClient().query({
    tableId: tableId('sessions'),
    expression: '#ownerId = :ownerId',
    values: { ownerId: owner },
    limit: options.limit ?? 20,
    ...(options.startKey === undefined ? {} : { startKey: options.startKey }),
    order: ORDER_DESC,
  })
  const params = unwrap('sessions.query', result)
  const lastKey = params?.LastEvaluatedKey
  return {
    sessions: (params?.Items ?? []) as SessionItem[],
    nextStartKey: lastKey === undefined || lastKey === null ? null : String(lastKey),
  }
}

export async function deleteSession(owner: OwnerId, sessionId: string): Promise<void> {
  await getDataStoreClient()
    .deleteItem({ tableId: tableId('sessions'), key: { ownerId: owner, sessionId } })
    .then((r) => unwrap('sessions.deleteItem', r))
}
