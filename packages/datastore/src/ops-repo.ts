import { getDataStoreClient, unwrap } from './client'
import { tableId } from './tables'
import type { OpsLogItem } from './types'

/**
 * `ops_logs` テーブル（data-model.md §3.8 / NFR-O2 / F11）。
 *
 * キー: `sessionId`（メイン） / `ts`（サブ, **数値** epoch ms）
 *
 * **サブキーが数値であるのはこのテーブルだけ。**
 * 文字列で作ると時系列の範囲クエリ（A5）が辞書順になり、桁が変わった時点で順序が壊れる。
 *
 * 書き込み可否（`OPS_LOG_ENABLED`）の判断は呼び出し側が持つ。
 * このリポジトリは「書く」ことだけを担当する。
 */

const ORDER_ASC = false

export async function putOpsLog(item: OpsLogItem): Promise<void> {
  await getDataStoreClient()
    .putItem({ tableId: tableId('opsLogs'), item })
    .then((r) => unwrap('opsLogs.putItem', r))
}

/** あるセッションの運用ログを時系列で取得する（A5）。実測コスト表の集計に使う */
export async function listOpsLogs(sessionId: string, limit = 100): Promise<OpsLogItem[]> {
  const result = await getDataStoreClient().query({
    tableId: tableId('opsLogs'),
    expression: '#sessionId = :sessionId',
    values: { sessionId },
    limit,
    order: ORDER_ASC,
  })
  return (unwrap('opsLogs.query', result)?.Items ?? []) as OpsLogItem[]
}

/**
 * セッション削除時の後始末（data-model.md §7）。
 * 件数分のアクセスを消費するため、`OPS_LOG_ENABLED=false` ならスキップする
 * （判断は呼び出し側）。
 */
export async function deleteOpsLogs(sessionId: string): Promise<void> {
  const logs = await listOpsLogs(sessionId, 1000)
  const client = getDataStoreClient()
  const table = tableId('opsLogs')
  for (const log of logs) {
    await client
      .deleteItem({ tableId: table, key: { sessionId, ts: log.ts } })
      .then((r) => unwrap('opsLogs.deleteItem', r))
  }
}
