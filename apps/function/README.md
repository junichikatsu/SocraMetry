# apps/function — バックエンド（enebular クラウド実行環境）

Node.js 22.x / TypeScript / Hono / ZIP デプロイ

> **未実装。** 現在は要件定義フェーズのため、このディレクトリは構成のプレースホルダです。
> 着手は [M2: MVP](../../docs/roadmap.md#m2-mvpコア体験の一気通貫--cd) から。

## 責務

- HTTP トリガー配下のルーティングとエンドポイント提供（[API 仕様](../../docs/api-spec.md)）
- 認証（OIDC / OAuth）とセッション Cookie、CORS
- **テナント分離とロール別の閲覧範囲制御**（NFR-S5 / NFR-S6）
- レート制限・トークン予算の管理
- `packages/core` / `llm` / `datastore` を束ねるユースケース層

## 構成

```
src/
├── index.ts              exports.handler（hono/aws-lambda の handle()）
├── app.ts                Hono アプリ本体
├── local.ts              ローカル起動（@hono/node-server）— Lambda なしで開発
├── routes/               sessions / diagnose / hints / advance / answers /
│                         reveal / reports / problems / assignments / org
├── middleware/           auth / authorize / audit-log / rate-limit / error-handler
└── services/             session-service / stats-service / evaluation-service

build.mjs                 esbuild バンドル + ZIP 生成
zip-package.json          ZIP に同梱する最小 package.json
```

## enebular の要件（守らないと動かない）

| # | 要件 |
|---|---|
| 1 | ZIP の**ルート直下**に `index.js` と `package.json` を置く |
| 2 | ハンドラは `index.handler`。**CommonJS**（`exports.handler`） |
| 3 | `package.json` に `"type": "module"` を**書かない** |
| 4 | 戻り値は `{ statusCode, headers, body }`。**ストリーミング不可** |
| 5 | ZIP は 250MB 以下 |

pnpm の `node_modules` は symlink 構造でそのままでは載らないため、
**esbuild で単一 CommonJS ファイルにバンドル**する
（[ADR-008](../../docs/architecture.md#adr-008-esbuild-で単一-commonjs-ファイルにバンドルして-zip-化する)）。
1〜5 は CI の `Verify ZIP layout` ステップで機械的に検証する。

## 絶対に守ること

| # | ルール |
|---|---|
| 1 | `ORCAROUTER_API_KEY` はクラウド実行環境の `envVars` にのみ存在する |
| 2 | `session_secrets`（＝答えと正解）を **Gate C 到達前**のレスポンスに含めない。`routes/` から直接参照しない |
| 3 | Gate A・B の生成文をユーザーに返す前に、必ず LeakGuard を通す |
| 4 | ユーザー入力は保存前・LLM 送信前にマスキングする（FR-11） |
| 5 | 状態を変えるエンドポイントは冪等にする（FR-14）。データストアにトランザクションはない |
| 6 | 1 リクエストで LLM を 2 回以上直列に呼ばない（NFR-C5 / タイムアウト対策） |
| 7 | **`tenantId` は認証済みトークンからのみ取得する。** リクエストパラメータから受け取らない（NFR-S5） |
| 8 | データストアのキーは `OwnerId` / `TenantId` のブランド型でのみ組み立てる（ADR-010） |
| 9 | **`GET /report` は冪等にする。** ここで `member_stats` を更新するため、二重実行すると評価データが壊れる |

## コマンド（予定）

```bash
pnpm dev            # local.ts を起動（Lambda なしで動作確認）
pnpm build:zip      # esbuild → socrametry-function.zip
pnpm test
```

## 依存

`packages/shared`, `packages/core`, `packages/llm`, `packages/datastore`

## 関連ドキュメント

- [アーキテクチャ](../../docs/architecture.md)
- [API 仕様](../../docs/api-spec.md)
- [データモデル](../../docs/data-model.md)
- [デプロイ](../../docs/deployment.md)
