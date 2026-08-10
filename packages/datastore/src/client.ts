import { CloudDataStoreClient } from '@uhuru/enebular-sdk'

/**
 * enebular データストアクライアントのラッパ（architecture.md §1）。
 *
 * SDK の `CloudDataStoreClient` を直接持ち回らず、**必要な 4 操作だけの
 * インターフェース**に絞って受け取る。理由は 2 つある。
 *
 * | # | 理由 |
 * |---|---|
 * | 1 | SDK のコンストラクタは `ENEBULAR_DS_JWT` / `ENEBULAR_DS_PROXY_ARN` が無いと **throw する**。実行環境が注入する値なので、モジュール読み込み時ではなく**初回アクセス時**に生成する必要がある |
 * | 2 | テストから差し替えられる。リポジトリ層のテストに実行環境を要求しない |
 *
 * 認証情報は実行環境が自動注入するため、アプリ側でアクセスキーを持たない
 * （`connectDataStore` を有効にすること / architecture.md §7）。
 */

export type DsResult<T> = {
  result?: 'success' | 'fail'
  error?: string
  params?: T
}

/** SDK の `CloudDataStoreClient` から、本アプリが使う操作だけを抜き出した形 */
export type DataStoreClient = {
  getItem(params: { tableId: string; key: unknown }): Promise<DsResult<{ Item: unknown }>>
  putItem(params: { tableId: string; item: unknown }): Promise<DsResult<{ Item: unknown }>>
  query(params: {
    tableId: string
    expression: string
    values: unknown
    limit?: number
    startKey?: string
    order?: boolean
  }): Promise<DsResult<{ Items?: unknown[]; LastEvaluatedKey?: unknown; Count?: number }>>
  deleteItem(params: { tableId: string; key: unknown }): Promise<DsResult<{ Item: unknown }>>
}

/**
 * データストアアクセスの失敗。
 * ルート層でこれを `503 DATASTORE_UNAVAILABLE` に写す（api-spec.md §1）。
 *
 * **メッセージに保存しようとした内容を含めない。** 例外経由でエラーテキストや
 * コード断片がログに乗るのを防ぐ（security.md §2.3）。
 */
export class DataStoreError extends Error {
  constructor(
    readonly operation: string,
    readonly detail?: string,
  ) {
    super(`datastore ${operation} failed`)
    this.name = 'DataStoreError'
  }
}

let injected: DataStoreClient | null = null
let cached: DataStoreClient | null = null

/** テスト・ローカル検証から差し替える。null を渡すと実クライアントに戻る */
export function setDataStoreClient(client: DataStoreClient | null): void {
  injected = client
  cached = null
}

export function getDataStoreClient(): DataStoreClient {
  if (injected) return injected
  if (cached) return cached

  try {
    /**
     * **生成は初回アクセス時まで遅らせる。**
     * コンストラクタは `ENEBULAR_DS_JWT` / `ENEBULAR_DS_PROXY_ARN`（実行環境が注入）が
     * 無いと throw するため、モジュール読み込み時に作ると
     * `/v1/health` すら返らない状態になる（deployment.md §6 の方針と対応）。
     *
     * import 自体は副作用で throw しないので静的 import でよい。
     * `require` を使わないのは、ローカル起動（tsx / ESM）では `require` が存在せず、
     * 「ZIP では動くのにローカルでは落ちる」差が生まれるため。
     */
    cached = new CloudDataStoreClient() as DataStoreClient
    return cached
  } catch (cause) {
    throw new DataStoreError('connect', cause instanceof Error ? cause.name : undefined)
  }
}

/**
 * データストア操作を実行し、失敗を必ず `DataStoreError` に揃える。
 *
 * **SDK の失敗の伝え方は 2 通りある。**
 *
 * | 伝え方 | 例 |
 * |---|---|
 * | `result: 'fail'` を返す | データストア側がエラーを返した場合 |
 * | **例外を投げる** | プロキシ Lambda の呼び出しに失敗した場合（接続不可・認証情報なし） |
 *
 * 後者を取りこぼすと、`503 DATASTORE_UNAVAILABLE` ではなく素の 500 になり、
 * 「画面が止まらず原因が表示される」（FR-17）が成立しない。
 * **両方をここ 1 箇所で揃える。** 各リポジトリで try/catch を書くと必ず抜けが出る。
 *
 * 例外の内容は `detail` に**種別だけ**を残す。メッセージには
 * 保存しようとしたアイテム（＝エラーテキストやコード断片）が乗りうるため
 * （security.md §2.3）。原因の詳細は SDK 自身が実行環境のログへ出している。
 */
export async function run<T>(
  operation: string,
  call: () => Promise<DsResult<T>>,
): Promise<T | undefined> {
  let result: DsResult<T>
  try {
    result = await call()
  } catch (cause) {
    throw new DataStoreError(operation, cause instanceof Error ? cause.name : typeof cause)
  }
  if (result.result === 'fail') throw new DataStoreError(operation, result.error)
  return result.params
}
