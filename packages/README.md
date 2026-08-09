# packages/ — 共有パッケージ

> **未実装。** 現在は要件定義フェーズのため、各ディレクトリは構成のプレースホルダです。

| パッケージ | 責務 | 依存 |
|---|---|---|
| `shared` | FE/BE 共有の Zod スキーマと公開型（＝API 契約） | なし |
| `core` | ドメインロジック。ゲート遷移 / 段階遷移 / スコアリング / 正規化 / LeakGuard / マスキング / 匿名化 / ULID | `shared` |
| `llm` | OrcaRouter クライアントと Diagnoser / Hinter / Questioner / Judge / Revealer / Reporter | `shared` |
| `datastore` | enebular データストア（`@uhuru/enebular-sdk`）のリポジトリ層 | `shared` |

## 設計上の要点

### `core` は LLM にもデータストアにも依存しない

段階遷移とスコアリングは**純関数**として実装し、外部依存なしで単体テストできるようにする（NFR-Q2）。
LeakGuard も同様で、「漏れているか」の判定に LLM を使わない
（判定自体が確率的になってしまうため）。

### `shared` の公開型に答えを定義しない

```ts
// ❌ こう書かない
type Question = { id: string; body: string; options: Option[]; correctOptionId: string }

// ✅ 公開型に正解は存在しない
export type QuestionPublic = { id: string; stage: Stage; body: string; options: Option[] }
```

正解（`correctOptionId`）と原因（`rootCause`）は `packages/datastore` の内部型にのみ存在し、
データストア上も `session_secrets` テーブルに隔離されている
（[ADR-005](../docs/architecture.md#adr-005-内部診断と正解を別テーブルに隔離する)）。

### `datastore` はテーブルごとにリポジトリを分け、キーはブランド型で守る

enebular データストアの `getItem` は**アイテム全体を返す**ため、
リレーショナル DB のようなカラム単位の防御ができない。
テーブル分離が唯一の隔離手段であり、それをコード側でも徹底する。

```
datastore/src/
├── client.ts           CloudDataStoreClient のラッパ
├── tables.ts           テーブル ID を環境変数から解決
├── owner.ts            ★OwnerId / TenantId のブランド型
├── session-repo.ts     sessions
├── secret-repo.ts      session_secrets  ★ここだけが答えに触れてよい
├── report-repo.ts      reports
├── org-repo.ts         org_directory
├── stats-repo.ts       member_stats
├── assignment-repo.ts  assignments
├── problem-repo.ts     question_bank
└── ops-repo.ts         ops_logs
```

`apps/function/src/routes/` から `secret-repo` を直接 import することは lint ルールで禁止する
（経由してよいのは `services/` のみ）。

### テナント分離は型で強制する（ADR-010）

BtoB では**他社のデータが 1 件でも漏れたら事業が終わる**。
`WHERE tenant_id = ?` の書き忘れで破綻する設計にはしない。

```ts
/** 認証済みコンテキストからのみ生成できる。生の文字列からは作れない */
export type OwnerId = string & { readonly __brand: 'OwnerId' }

export function ownerIdOf(ctx: AuthContext, memberId: string): OwnerId {
  return `${ctx.tenantId}:${memberId}` as OwnerId
}

// リポジトリは OwnerId しか受け取らない → 文字列連結で作ったキーは型エラー
export function getSession(owner: OwnerId, sessionId: string): Promise<SessionItem | null>
```

`tenantId` がメインキーの先頭にあるため、別組織のデータは**キーが一致せず 0 件しか返らない**。
実装ミスがあっても「情報漏洩」ではなく「データが見つからない」に着地する。

### `core` のスコアリングは LLM を使わない（NFR-Q4）

スコアは人事評価に使われる。**同じセッションデータからは常に同じ値が出なければならない。**
`scoring.ts` / `normalization.ts` / `stats-merge.ts` はすべて純関数とし、
LLM もデータストアも呼ばない。

### `core` の ULID がキー設計を支えている

`sessionId` に ULID を使うことで、**文字列としての辞書順 = 生成時刻順**になる。
データストアはサブキーを 1 つしか持てないため、
「サブキー = `sessionId`」だけで ID 引きと時系列ソートの両方が成立する
（[data-model.md](../docs/data-model.md#2-テーブル一覧4-テーブル)）。
