import { getDataStoreClient, unwrap } from './client'
import type { OwnerId } from './owner'
import { tableId } from './tables'
import type { ReportItem } from './types'

/**
 * `reports` テーブル（data-model.md §3.3）。
 *
 * キー: `ownerId`（メイン） / `sessionId`（サブ, ULID）
 *
 * `sessions` と**同じキー構成**にしてあるため、個人ダッシュボード（FR-24）が
 * 1 回の `query` で全レポートを集計できる（A4）。
 * v0.1 は `member_stats`（ADR-011 / v0.2）を持たないため、この 1 クエリが集計元になる。
 */

const ORDER_DESC = true

export async function getReport(owner: OwnerId, sessionId: string): Promise<ReportItem | null> {
  const result = await getDataStoreClient().getItem({
    tableId: tableId('reports'),
    key: { ownerId: owner, sessionId },
  })
  const item = unwrap('reports.getItem', result)?.Item
  return (item as ReportItem | undefined) ?? null
}

export async function putReport(item: ReportItem): Promise<void> {
  await getDataStoreClient()
    .putItem({ tableId: tableId('reports'), item })
    .then((r) => unwrap('reports.putItem', r))
}

/** 個人ダッシュボードの集計元（A4）。既定 100 件は data-model.md の想定に合わせている */
export async function listReports(owner: OwnerId, limit = 100): Promise<ReportItem[]> {
  const result = await getDataStoreClient().query({
    tableId: tableId('reports'),
    expression: '#ownerId = :ownerId',
    values: { ownerId: owner },
    limit,
    order: ORDER_DESC,
  })
  return (unwrap('reports.query', result)?.Items ?? []) as ReportItem[]
}

export async function deleteReport(owner: OwnerId, sessionId: string): Promise<void> {
  await getDataStoreClient()
    .deleteItem({ tableId: tableId('reports'), key: { ownerId: owner, sessionId } })
    .then((r) => unwrap('reports.deleteItem', r))
}
