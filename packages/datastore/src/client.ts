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

/** 失敗の伝わり方。**値を含まないのでレスポンスに出してよい** */
export type DataStoreFailureKind =
  /** SDK が例外を投げた（接続不可・認証情報なし） */
  | 'threw'
  /** SDK が `result: 'fail'` を返した（データストア側のエラー） */
  | 'failed'
  /** テーブル ID の環境変数が未設定 */
  | 'unset'

/**
 * データストアアクセスの失敗。
 * ルート層でこれを `503 DATASTORE_UNAVAILABLE` に写す（api-spec.md §1）。
 *
 * **公開してよい情報と、してはいけない情報を型で分けている。**
 * `operation` / `kind` / `errorName` は値を含まない識別子なのでレスポンスに出す。
 * FR-17（画面が止まらず原因が表示される）を満たすには、
 * 「保存先に接続できません」だけでは切り分けられないため。
 *
 * 一方 `rawMessage` は**どこにも出さない。** SDK のエラーメッセージには
 * 送信したアイテム（＝エラーテキストやコード断片、メールアドレス）が
 * 含まれうる（security.md §2.3）。
 */
export class DataStoreError extends Error {
  constructor(
    readonly operation: string,
    readonly kind: DataStoreFailureKind,
    /** 例外クラス名など、値を含まない識別子のみ */
    readonly errorName?: string,
    /** ★ログにもレスポンスにも出さない */
    readonly rawMessage?: string,
  ) {
    super(`datastore ${operation} failed`)
    this.name = 'DataStoreError'
  }

  /** レスポンスに載せてよい形 */
  toPublicDetail(): Record<string, string> {
    return {
      operation: this.operation,
      kind: this.kind,
      ...(this.errorName === undefined ? {} : { errorName: this.errorName }),
    }
  }

  /**
   * 「アイテムが存在しない」ことを表すか。
   *
   * **データストアは `getItem` でアイテムが無いときエラー（`"Not found"`）を返す。**
   * 本製品では「無い」は正常系である（初回サインアップ時のアカウント確認、
   * まだ診断が保存されていないセッション、レポート未生成の判定）。
   * これを 503 にすると、**サインアップが原理的に成立しない。**
   *
   * 文字列一致に頼るのは本来避けたいが、プロキシはエラーを文字列でしか返さない。
   * 誤ってテーブル不在をここで吸収しても、**書き込み側が必ず失敗するため
   * 設定ミスは隠れない**（読みは空、書きは 503 として表面化する）。
   */
  isNotFound(): boolean {
    return this.kind === 'failed' && /not\s*found/i.test(this.rawMessage ?? '')
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
    // 典型例: connectDataStore が無効で ENEBULAR_DS_JWT が注入されていない
    throw new DataStoreError(
      'connect',
      'threw',
      cause instanceof Error ? cause.name : typeof cause,
      cause instanceof Error ? cause.message : undefined,
    )
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
    throw classify(operation, cause)
  }
  // 到達しない想定（SDK は throw する）が、契約として両方を扱う
  if (result.result === 'fail') {
    throw new DataStoreError(operation, 'failed', undefined, result.error)
  }
  return result.params
}

/**
 * 投げられた値を分類する。
 *
 * **SDK は `throw result.error` でデータストア側のエラーを「文字列のまま」投げる**
 * （`CloudDataStoreClient.executeOperation`）。`Error` ではないため、
 * `cause.message` だけを見ていると**原因の記述をまるごと捨てることになる。**
 * デプロイ環境の 503 が切り分けられなかったのはこれが理由だった。
 *
 * | 投げられた値 | 意味 | kind |
 * |---|---|---|
 * | 文字列 | データストア操作がエラーを返した（テーブル不在・キー不正など） | `failed` |
 * | `Error` | プロキシ Lambda に到達できない（接続不可・認証情報なし） | `threw` |
 */
function classify(operation: string, cause: unknown): DataStoreError {
  if (typeof cause === 'string') {
    return new DataStoreError(operation, 'failed', undefined, cause)
  }
  if (cause instanceof Error) {
    return new DataStoreError(operation, 'threw', cause.name, cause.message)
  }
  return new DataStoreError(operation, 'threw', typeof cause, safeStringify(cause))
}

/**
 * 単一アイテムの取得。**「無い」をエラーにしない。**
 *
 * `run` と分けているのは、この扱いを `getItem` にだけ適用したいため。
 * `putItem` / `query` / `deleteItem` の "not found" は設定ミスの可能性があり、
 * 黙って空扱いにすると原因が隠れる。
 */
export async function runGet<T>(
  operation: string,
  call: () => Promise<DsResult<T>>,
): Promise<T | undefined> {
  try {
    return await run(operation, call)
  } catch (cause) {
    if (cause instanceof DataStoreError && cause.isNotFound()) return undefined
    throw cause
  }
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}
