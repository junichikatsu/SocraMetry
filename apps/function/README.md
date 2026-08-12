# apps/function — バックエンド（enebular クラウド実行環境）

Node.js 22.x / TypeScript / Hono / ZIP デプロイ

> **v0.1 のバックエンド API は実装済みです**（3 ゲート・簡易認証・スコア・履歴）。
> フロントエンド（`apps/web`）は未実装で、静的ファイルの同一オリジン配信（ADR-012）も未接続です。
> v0.2 の組織機能（問題集・割り当て・組織ダッシュボード・ロール管理）は入っていません。

## 責務

- HTTP トリガー配下のルーティングとエンドポイント提供（[API 仕様](../../docs/api-spec.md)）
- 簡易認証（メール + パスワード + 招待コード）とセッション Cookie
- レート制限・トークン予算の管理
- `packages/core` / `llm` / `datastore` を束ねるユースケース層
- **v0.2**: テナント分離とロール別の閲覧範囲制御（NFR-S5 / NFR-S6）、CORS

## 構成

```
src/
├── index.ts              exports.handler（hono/aws-lambda の handle()）
├── app.ts                Hono アプリ本体 + 認証の適用範囲
├── local.ts              ローカル起動（@hono/node-server）— Lambda なしで開発
├── config.ts             環境変数の検査（deployment.md §6）とアプリ設定
├── routes/
│   ├── auth.ts           サインアップ / ログイン / /v1/me
│   ├── sessions.ts       セッションの作成・取得・削除
│   ├── gates.ts          diagnose / hints / advance / answers /
│   │                     conclusion / reveal / retrospect
│   └── reports.ts        レポート・履歴・個人統計
├── middleware/
│   ├── auth.ts           JWT 検証と認証コンテキスト
│   ├── validate.ts       Zod による入力検証（F05）
│   ├── rate-limit.ts     セッション作成の回数制限（NFR-O3）
│   ├── cost-log.ts       1 リクエスト単価のログ（F11）
│   └── error-handler.ts  異常系の統一処理（F12 / FR-17）
├── services/
│   ├── session-service.ts  3 ゲートの進行
│   ├── report-service.ts   レポート生成とスコア・個人統計
│   ├── guarded-llm.ts      LeakGuard 適用・再生成・テンプレート退避
│   ├── auth-service.ts     scrypt によるパスワード検証
│   └── presenters.ts       アイテム → 公開型の変換
└── test-support/           テスト用のデータストア代替（本番には入らない）

build.mjs                 esbuild バンドル + ZIP 生成
zip-package.json          ZIP に同梱する最小 package.json
```

## エンドポイント（v0.1）

| メソッド | パス | 認証 | 説明 |
|---|---|---|---|
| GET | `/v1/health` | — | ヘルスチェック + 設定漏れの検査 |
| POST | `/v1/auth/signup` | — | 招待コード必須 |
| POST | `/v1/auth/login` / `/logout` | — | JWT Cookie の発行・破棄 |
| GET | `/v1/me` | ✅ | 自分のプロフィール |
| POST | `/v1/sessions` | ✅ | セッション開始。**Gate A のヒントを返す。診断は待たない** |
| GET / DELETE | `/v1/sessions/:id` | ✅ | 状態取得（復帰用） / 削除（NFR-S7） |
| POST | `/v1/sessions/:id/diagnose` | ✅ | 先行診断（ADR-006） |
| POST | `/v1/sessions/:id/hints` | ✅ | **Gate A**: ヒントを 1 段階開放 |
| POST | `/v1/sessions/:id/advance` | ✅ | **Gate A → B**（不可逆） |
| POST | `/v1/sessions/:id/answers` | ✅ | **Gate B**: 回答と次問 |
| POST | `/v1/sessions/:id/conclusion` | ✅ | 原因宣言と到達判定 |
| POST | `/v1/sessions/:id/reveal` | ✅ | **Gate C**: 解説 + 振り返り |
| POST | `/v1/sessions/:id/retrospect` | ✅ | 振り返りの回答（完了） |
| GET | `/v1/sessions/:id/report` | ✅ | レポートとスコア（初回のみ生成） |
| GET | `/v1/me/sessions` / `/v1/me/stats` | ✅ | 履歴一覧 / 個人ダッシュボード |

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
| 7 | **`tenantId` は認証済みトークンからのみ取得する。** リクエストパラメータから受け取らない（NFR-S5 / v0.2） |
| 8 | データストアのキーは `OwnerId` / `TenantId` のブランド型でのみ組み立てる（ADR-010） |
| 9 | **`GET /report` は冪等にする。** ここで `member_stats` を更新するため、二重実行すると評価データが壊れる |

### ローカルでの動作確認について

**データストアだけは代替がない。** `@uhuru/enebular-sdk` の `CloudDataStoreClient` は
実行環境が注入する `ENEBULAR_DS_JWT` / `ENEBULAR_DS_PROXY_ARN` を要求するため、
ローカルで API を通しで叩くには enebular のデータストアに接続できる状態が必要になる。

`MOCK_MODE=true` が消すのは **LLM 呼び出しだけ**である（ADR-014）。
接続情報がない状態で API を叩くと `503 DATASTORE_UNAVAILABLE` が返る
（起動と `/v1/health` は落ちない）。

**そのため MOCK モードでの導線確認は自動テストで行う。**
`src/api.test.ts` が同じインターフェースの代替に差し替えて 3 ゲートを通しで検証している。

```bash
pnpm --filter @socrametry/function test    # MOCK モードで全導線（LLM 課金ゼロ）
```

## コマンド

リポジトリのルートで `pnpm install` した後、

```bash
pnpm --filter @socrametry/function dev         # local.ts を起動（Lambda なしで動作確認）
pnpm --filter @socrametry/function build:zip   # esbuild → socrametry-function.zip
pnpm --filter @socrametry/function test
```

ルートからは `pnpm dev` / `pnpm build:zip` / `pnpm test` / `pnpm typecheck` / `pnpm lint` でも実行できる。

### 動作確認

```bash
pnpm dev
curl http://localhost:8787/v1/health
# {"status":"ok","version":"0.1.0","commit":"local","builtAt":"local","mockMode":false}
```

環境変数は**リポジトリのルートの `.env`** から読む（`--env-file-if-exists`）。
`.env.example` をルートにコピーして使う。存在しなければ何も読まずに起動する。

`commit` にはビルド時のコミット SHA が埋め込まれる（ローカル起動時は `local`）。
**デプロイ後にこの値を見れば、意図したコミットが実際に動いているかを機械的に確認できる。**
CI のスモークテストが叩くのもこのエンドポイント。

## 依存

`packages/shared`, `packages/core`, `packages/llm`, `packages/datastore`

## 関連ドキュメント

- [アーキテクチャ](../../docs/architecture.md)
- [API 仕様](../../docs/api-spec.md)
- [データモデル](../../docs/data-model.md)
- [デプロイ](../../docs/deployment.md)
