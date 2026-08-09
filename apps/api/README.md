# apps/api — バックエンド

Hono / Node.js 22+ / TypeScript

> **未実装。** 現在は要件定義フェーズのため、このディレクトリは構成のプレースホルダです。
> 着手は [M2: MVP](../../docs/roadmap.md#m2-mvpコア体験の一気通貫) から。

## 責務

- HTTP エンドポイントの提供（[API 仕様](../../docs/api-spec.md)）
- 匿名 ID Cookie の発行と解決
- レート制限・トークン予算の管理
- `packages/core` / `llm` / `db` を束ねるユースケース層

## 構成

```
src/
├── index.ts              エントリポイント
├── routes/               sessions / answers / hints / reports
├── middleware/           anonymous-id / rate-limit / error-handler
└── services/             session-service（core・llm・db のオーケストレーション）
```

## 絶対に守ること

| # | ルール |
|---|---|
| 1 | `ORCAROUTER_API_KEY` はこのアプリの環境変数にのみ存在する |
| 2 | `diagnoses` テーブル（＝答え）をレスポンスに含めない。`routes/` から直接参照しない |
| 3 | LLM の生成文をユーザーに返す前に、必ず LeakGuard を通す |
| 4 | ユーザー入力は保存前・LLM 送信前にマスキングする（FR-13） |

## 依存

`packages/shared`, `packages/core`, `packages/llm`, `packages/db`
