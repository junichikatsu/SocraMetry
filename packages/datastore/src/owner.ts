import type { AuthContext } from '@socrametry/shared'

/**
 * `ownerId` のブランド型（ADR-010 / data-model.md §6）。
 *
 * リポジトリ層は生の `string` を受け取らない。
 * **`ownerId` を文字列連結で作るコードがコンパイルを通らない**状態にしておく。
 *
 * ```
 * v0.1  ownerId = "usr_9d0e11"
 * v0.2  ownerId = "<tenantId>:<memberId>"
 * ```
 *
 * v0.1 はテナントを持たないが、**キー名と生成関数を今のうちに用意しておく**ことで、
 * v0.2 でテナントを入れるときにテーブル定義とクエリの形を変えずに済む
 * （scope-v0.1.md §4.4）。今この命名にするコストはゼロ。
 */
export type OwnerId = string & { readonly __brand: 'OwnerId' }

/**
 * 認証済みコンテキストからのみ `OwnerId` を作る。
 *
 * **リクエストのパス・クエリ・ボディから受け取らない**（api-spec.md §1 鉄則 1）。
 * 他人の `sessionId` を渡されても、メインキーが一致しないため 0 件しか返らない。
 * アクセス制御の書き忘れが「情報漏洩」ではなく「見つからない」に着地する。
 */
export function ownerIdOf(ctx: AuthContext): OwnerId {
  return ctx.userId as OwnerId
}
