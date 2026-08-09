# packages/ — 共有パッケージ

> **未実装。** 現在は要件定義フェーズのため、各ディレクトリは構成のプレースホルダです。

| パッケージ | 責務 | 依存 |
|---|---|---|
| `shared` | FE/BE 共有の Zod スキーマと公開型（＝API 契約） | なし |
| `core` | ドメインロジック。段階遷移 / スコアリング / LeakGuard / マスキング / ULID | `shared` |
| `llm` | OrcaRouter クライアントと Diagnoser / Questioner / Judge / Reporter | `shared` |
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

### `datastore` はテーブルごとにリポジトリを分ける

enebular データストアの `getItem` は**アイテム全体を返す**ため、
リレーショナル DB のようなカラム単位の防御ができない。
テーブル分離が唯一の隔離手段であり、それをコード側でも徹底する。

```
datastore/src/
├── client.ts        CloudDataStoreClient のラッパ
├── tables.ts        テーブル ID を環境変数から解決
├── session-repo.ts  sessions
├── secret-repo.ts   session_secrets  ★ここだけが答えに触れてよい
├── report-repo.ts   reports
└── ops-repo.ts      ops_logs
```

`apps/function/src/routes/` から `secret-repo` を直接 import することは lint ルールで禁止する
（経由してよいのは `services/session-service.ts` のみ）。

### `core` の ULID がキー設計を支えている

`sessionId` に ULID を使うことで、**文字列としての辞書順 = 生成時刻順**になる。
データストアはサブキーを 1 つしか持てないため、
「サブキー = `sessionId`」だけで ID 引きと時系列ソートの両方が成立する
（[data-model.md](../docs/data-model.md#2-テーブル一覧4-テーブル)）。
