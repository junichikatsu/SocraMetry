# packages/ — 共有パッケージ

> **未実装。** 現在は要件定義フェーズのため、各ディレクトリは構成のプレースホルダです。

| パッケージ | 責務 | 依存 |
|---|---|---|
| `shared` | FE/BE 共有の Zod スキーマと公開型（＝API 契約） | なし |
| `core` | ドメインロジック。段階遷移 / スコアリング / LeakGuard / マスキング | `shared` |
| `llm` | OrcaRouter クライアントと Diagnoser / Questioner / Judge / Reporter | `shared` |
| `db` | Prisma スキーマとクライアント | `shared` |

## 設計上の要点

### `core` は LLM にも DB にも依存しない

段階遷移とスコアリングは**純関数**として実装し、LLM なしで単体テストできるようにする（NFR-Q2）。
LeakGuard も同様で、「漏れているか」の判定に LLM を使わない
（判定自体が確率的になってしまうため）。

### `shared` の公開型に答えを定義しない

```ts
// ❌ こう書かない
type Question = { id: string; body: string; options: Option[]; correctOptionId: string }

// ✅ 公開型に正解は存在しない
export type QuestionPublic = { id: string; stage: Stage; body: string; options: Option[] }
```

正解 (`correctOptionId`) と原因 (`rootCause`) は `packages/db` の内部型にのみ存在する。
これにより、API の実装ミスによる答えの漏洩がコンパイル時に防がれる
（[ADR-005](../docs/architecture.md#adr-005-内部診断を独立テーブルに隔離する)）。
