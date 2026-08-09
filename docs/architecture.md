# アーキテクチャと技術選定

| 項目 | 内容 |
|---|---|
| ドキュメント版数 | v0.2 |
| 更新日 | 2026-08-09 |
| 主な変更 | バックエンドを **enebular クラウド実行環境（ZIP デプロイ）+ enebular データストア** に変更 |
| 関連 | [要件定義書](requirements.md) / [ソクラテス式エンジン仕様](socratic-engine.md) / [デプロイ](deployment.md) |

---

## 1. 全体構成

```
┌──────────────────────────────────────────────────────────────┐
│  ブラウザ                                                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  apps/web — Next.js 15 (App Router) / Vercel            │  │
│  │  ・エラー投稿フォーム  ・質問カード / 選択肢 UI            │  │
│  │  ・段階プログレス      ・スコアレーダーチャート             │  │
│  └────────────────────────────────────────────────────────┘  │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTPS / JSON（バッファ応答・ストリーミング不可）
                            │ Cookie: sm_anon
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  enebular クラウド実行環境（ZIP / Node.js 22.x / AWS Lambda）  │
│  HTTP トリガー（パスは enebular インスタンス内で一意）           │
│                                                               │
│   index.js  ─ exports.handler = async (event) => {...}        │
│      │  ※ esbuild で単一 CommonJS ファイルにバンドル            │
│      ▼                                                        │
│  ┌─ Hono ルーター（aws-lambda アダプタ）────────────────────┐  │
│  │  POST /sessions   POST /sessions/:id/diagnose            │  │
│  │  POST /sessions/:id/answers   /hints  /conclusion        │  │
│  │  GET  /sessions/:id/report    /me/sessions  /me/stats    │  │
│  └────────────────────────────┬─────────────────────────────┘ │
│                               ▼                               │
│  ┌─ packages/core（純粋なドメインロジック / 外部依存なし）───┐  │
│  │  段階遷移ステートマシン ・ スコアリング ・ LeakGuard        │  │
│  │  秘匿情報マスキング                                        │  │
│  └────────────────────────────┬─────────────────────────────┘ │
│              ┌────────────────┴────────────────┐              │
│              ▼                                 ▼              │
│  ┌─ packages/llm ──────────┐   ┌─ packages/datastore ──────┐  │
│  │ Diagnoser / Questioner  │   │ @uhuru/enebular-sdk ラッパ │  │
│  │ Judge / Reporter        │   │ CloudDataStoreClient      │  │
│  └───────────┬─────────────┘   └────────────┬──────────────┘  │
└──────────────┼──────────────────────────────┼─────────────────┘
               │ OpenAI 互換 API               │ 実行環境が自動で認証情報を注入
               ▼                              ▼
┌──────────────────────────┐   ┌───────────────────────────────┐
│  OrcaRouter（必須）        │   │  enebular データストア          │
│  api.orcarouter.ai/v1     │   │  JSON アイテム / メインキー +   │
│  ├ openai/*               │   │  サブキー（DynamoDB 型 KV）     │
│  ├ anthropic/*            │   │  sessions / session_secrets /  │
│  └ google/*               │   │  reports / ops_logs            │
└──────────────────────────┘   └───────────────────────────────┘
```

### 重要な境界線

1. **フロントエンドは LLM を直接叩かない。** `ORCAROUTER_API_KEY` はクラウド実行環境の環境変数にのみ存在する。
2. **内部診断（＝答え）は API レスポンスの外に出ない。** データストアの別テーブル `session_secrets` に隔離し、
   `packages/shared` の公開型にフィールドを定義しない。*型レベルで漏洩を防ぐ*。
3. **ドメインロジックは LLM にもデータストアにも依存しない。** `packages/core` は純関数で、単体テスト可能。

---

## 2. enebular 採用にともなう 4 つの制約

バックエンドを enebular に載せることで、以下は**設計の前提が変わる**。
本ドキュメント全体はこの 4 点を織り込んで書かれている。

| # | 制約 | 出典 | 設計への影響 |
|---|---|---|---|
| **E1** | クラウド実行環境（ZIP）は AWS Lambda ベースで、ハンドラは `{ statusCode, headers, body }` を **return する**。レスポンスは**バッファ応答**であり、ストリーミングできない | [ZIP デプロイ](https://docs.enebular.com/ja/GetStarted/ZIPFileDeployment.html) | **SSE（旧 FR-15）を廃止**。体感速度は別手段で確保（→ ADR-006 / ADR-007） |
| **E2** | データストアは **メインキー + サブキー**の JSON アイテムストア。サブキーは数値か文字列のみ。JOIN・リレーション・二次インデックスなし | [データストア](https://docs.enebular.com/ja/datastore/overview) | リレーショナル設計を破棄し、**アクセスパターン起点のキー設計**へ（→ [data-model.md](data-model.md)） |
| **E3** | ZIP は**ルート直下**に `index.js` / `package.json` を置く。`"type": "module"` は不可（CommonJS 必須）。250MB 以下 | 同上 | pnpm モノレポの symlink がそのままでは載らない → **esbuild で単一 CJS にバンドル**（→ ADR-008） |
| **E4** | データストアのアクセス数は**フリー 10,000 回 / 月、エンタープライズ 3,000,000 回 / 月**。アイテムは約 350KB まで | [データストア](https://docs.enebular.com/ja/datastore/overview) | アクセス回数がキャパシティのボトルネックになる（→ §6）。**1 セッション = 少数アイテム**に集約する設計が必須 |

---

## 3. 技術選定

| レイヤ | 採用技術 | 選定理由 |
|---|---|---|
| 言語 | TypeScript（全レイヤ） | FE/BE で Zod スキーマを共有し、API 契約を 1 箇所で定義できる |
| フロントエンド | Next.js 15 (App Router) / Vercel | UI の反復速度、将来の OGP / SEO |
| スタイル | Tailwind CSS | |
| **実行基盤** | **enebular クラウド実行環境（ZIP / Node.js 22.x）** | 必須要件 |
| ルーター | Hono + `hono/aws-lambda` | Lambda ハンドラに 1 行でアダプトでき、パスが 1 本の HTTP トリガーでも内部ルーティングできる |
| バンドル | esbuild（`--platform=node --format=cjs --bundle`） | E3 の CommonJS / ルート直下要件を満たしつつ、ワークスペース依存を解決し ZIP を小さくする |
| **データストア** | **enebular データストア**（`@uhuru/enebular-sdk`） | 必須要件 |
| LLM ゲートウェイ | **OrcaRouter**（OpenAI 互換） | 必須要件。公式 `openai` SDK をそのまま利用 |
| バリデーション | Zod | `packages/shared` に置き FE/BE 双方から参照 |
| モノレポ | pnpm workspaces + Turborepo | 型共有とビルドキャッシュ |
| テスト | Vitest | `packages/core` の純関数と LeakGuard 回帰テスト |
| CI / CD | GitHub Actions + `@uhuru/enebular-cli` | ZIP のビルドとデプロイを自動化（→ [deployment.md](deployment.md)） |

---

## 4. ADR（アーキテクチャ決定記録）

### ADR-001: フロントエンドとバックエンドを分離する

**決定**: `apps/web`（Vercel）と `apps/function`（enebular）を分ける。

**理由**:
- `ORCAROUTER_API_KEY` と内部診断（＝答え）を**物理的にフロントの外**に置くことが、この製品では機能要件そのもの（P1: 答えは言わない）
- 実行基盤が enebular である以上、そもそも分離は必然
- 将来の IDE 拡張 / CLI（v3）は同じ HTTP トリガーを叩く

**トレードオフ**: デプロイ先が 2 系統になり、CORS を明示設定する必要がある。

---

### ADR-002: バックエンドを TypeScript にする（Python を採らない）

**決定**: TypeScript。ZIP には esbuild でバンドルした CommonJS を格納する。

**理由**:
- enebular の ZIP は Node.js 22.x と Python の両方をサポートするが、
  FE と Zod スキーマを共有できる価値が大きい（API 契約のずれが構造的に発生しない）
- OrcaRouter が OpenAI 互換であり、Python 固有の LLM ライブラリを必要としない
- `@uhuru/enebular-sdk` が TypeScript で型定義付き

---

### ADR-003: LLM を用途別に 3 つの役割へ分離する

**決定**: 単一の巨大プロンプトではなく **Diagnoser / Questioner / Judge** に分ける。
Questioner には結論（`rootCause`）を渡さず、着目点（`focusHints`）だけを渡す。

**理由**: 単一プロンプトで「原因を特定しつつ絶対に言わない」を両立させると答えが漏れる。
役割分離により、漏洩を確率ではなく設計で防ぐ。詳細は [socratic-engine.md](socratic-engine.md)。

---

### ADR-004: 認証なしで始め、後から載せられるデータ設計にする

**決定**: v1 は Cookie の匿名 ID (`sm_anon`) のみ。データストアの `sessions` テーブルの
**メインキーを `ownerId`** とし、v1 では `anon#<uuid>`、v2 では `user#<userId>` を入れる。

**理由**:
- 「実務で今困っているエラーを投げる」体験は、ログインを挟むと入口で落ちる
- 一方で履歴とスコア推移にはデータストアが要る（→ 認証なし・データストアあり）
- メインキーを最初から `ownerId` という**抽象化した名前**にしておくことで、
  認証追加時にキー設計を変えずに済む

**移行**: ログイン成功時、`anon#<uuid>` の全アイテムを読み出し、
`ownerId = user#<userId>` で put し直す（データストアにキー変更操作はないため、
**read → put → delete の 3 手**になる）。詳細は [data-model.md](data-model.md#6-認証追加時の移行v2)。

---

### ADR-005: 内部診断と正解を別テーブルに隔離する

**決定**: 原因（`rootCause`）と各設問の正解（`correctOptionId`）を
`sessions` に入れず、**`session_secrets` テーブル**に分離する。

**理由**:
- データストアの `getItem` は**アイテム全体を返す**ため、リレーショナル DB の
  「カラムを選んで SELECT」に相当する防御がない。**テーブルごと分ける以外に隔離手段がない**
- セッション本体を返す実装ミス 1 つで製品価値が消える
- `packages/shared` の公開型に `rootCause` / `correctOptionId` を定義しないことで、
  コンパイル時にも防ぐ

**制約の受け入れ**: 1 ターンあたり `sessions` と `session_secrets` の 2 テーブルを読むため、
データストアのアクセス回数が増える（E4）。これは §6 で許容範囲と判断した。

---

### ADR-006: SSE を廃止し、「診断の先行実行」で体感速度を確保する

**決定**: ストリーミング（旧 FR-15）を廃止。代わりに次の 2 段構えにする。

1. **`POST /sessions` は診断を待たない。** Lv1（観察）の質問は
   「エラーメッセージをどう読むか」であり、**内部診断がなくても生成できる**。
   投稿から数秒で最初の質問を返す
2. **クライアントは最初の質問を表示した直後に `POST /sessions/:id/diagnose` を撃つ。**
   ユーザーが Lv1 の選択肢を読んで考えている 20〜60 秒の間に、
   重い診断がバックグラウンド（＝別リクエスト）で完了する

```
時刻 ─────────────────────────────────────────────────▶
  0s   POST /sessions ──▶ Lv1 質問を返す（診断なしで生成可）
  2s   [画面に質問が出る]
  2s   POST /sessions/:id/diagnose ──┐（クライアントが即座に発火）
                                     │ 重い診断が走る
 12s                                 ┘ session_secrets に保存
 30s   ユーザーが Lv1 に回答 ──▶ 診断は既に完了している
```

**理由**:
- E1 により Lambda はレスポンスをバッファする。SSE は原理的に使えない
- Lambda はレスポンス返却後に処理を継続できない（＝サーバ側での非同期実行ができない）ため、
  **「別リクエストとして撃たせる」のが唯一のバックグラウンド実行手段**
- ユーザーは Lv1 を読んで考えている。この時間は元々アイドルであり、そこに診断を隠せる

**回答が診断より先に到着した場合**: `POST /answers` は `session_secrets` に診断がなければ
`202 Accepted` と `retryAfterMs` を返し、クライアントが再試行する。

**代替案（却下）**: クライアントが診断完了をポーリングする。HTTP リクエスト数と
データストアアクセスを無駄に消費するため却下。

---

### ADR-007: 「先輩が考えている」演出でレイテンシを体験に変える

**決定**: ローディングを進捗バーではなく、**メンターが考えている表現**にする
（「ふむ…ログを見せてもらっています」「なるほど、では一つ聞かせてください」）。

**理由**: SSE が使えない以上、待ち時間は必ず発生する。
本製品のメタファーは「熟練の先輩エンジニア」であり、
**先輩が数秒黙って考えるのはむしろ自然**である。技術的制約を世界観に吸収させる。

---

### ADR-008: esbuild で単一 CommonJS ファイルにバンドルして ZIP 化する

**決定**: `apps/function` を esbuild で `dist/index.js`（CJS）にバンドルし、
`dist/index.js` と最小の `package.json` だけを ZIP のルートに入れる。

```bash
esbuild src/index.ts --bundle --platform=node --target=node22 \
  --format=cjs --outfile=dist/index.js
```

**理由**:
- E3 により ZIP はルート直下に `index.js` が必要で、CommonJS でなければならない
- pnpm のモノレポは `node_modules` が symlink 構造のため、
  `zip -r ... node_modules/` では**ワークスペース依存が壊れる**。バンドルすれば無関係になる
- ZIP サイズが数 MB に収まり、250MB 制限とデプロイ時間の両方で有利
- ZIP 内 `package.json` に `"type": "module"` を書かない運用を、
  ビルドスクリプトで機械的に保証できる

**注意**: ネイティブモジュールを使う依存が出てきた場合は `--external` で除外し、
その分だけ `node_modules` を同梱する。v1 の依存（`openai`, `@uhuru/enebular-sdk`, `hono`, `zod`）は
すべて純 JS のためバンドル可能。

---

### ADR-009: Hono を Lambda ハンドラのルーターとして使う

**決定**: HTTP トリガーは 1 パスしか持てないため、`hono/aws-lambda` の `handle()` で
Hono アプリを Lambda ハンドラに変換し、**内部でパスルーティング**する。

```ts
// apps/function/src/index.ts
import { handle } from 'hono/aws-lambda'
import { app } from './app'
export const handler = handle(app)
```

**理由**: ルーティング・バリデーション・エラーハンドリングを自前で書かずに済み、
ローカル開発では同じ `app` を `@hono/node-server` で起動できる（Lambda なしでテスト可能）。

**要検証（M1）**: enebular の HTTP トリガーが渡す `event` の形式（API Gateway v1 / v2 /
Lambda Function URL のいずれか）を実測で確認する。形式が非標準の場合は、
`event` を正規化する薄いアダプタを自前で書いて Hono に渡す。

---

## 5. フォルダ構成

```
SocraMetry/
├── README.md
├── LICENSE
├── .gitignore
├── .env.example                  # 必要な環境変数の一覧（値は入れない）
├── package.json                  # pnpm workspace ルート
├── pnpm-workspace.yaml
├── turbo.json
│
├── docs/                         # ★ 要件定義・設計ドキュメント
│   ├── requirements.md           #   要件定義書
│   ├── architecture.md           #   本書：構成・技術選定・ADR
│   ├── socratic-engine.md        #   対話エンジン仕様（プロンプト設計）
│   ├── data-model.md             #   データストアのキー設計・アイテム定義
│   ├── api-spec.md               #   API 仕様
│   ├── deployment.md             #   ZIP デプロイと GitHub Actions
│   └── roadmap.md                #   マイルストーン
│
├── apps/
│   ├── web/                      # ★ フロントエンド (Next.js 15 / Vercel)
│   │   ├── app/
│   │   │   ├── page.tsx                    # ランディング / エラー投稿
│   │   │   ├── sessions/[id]/page.tsx      # 問答画面（コア体験）
│   │   │   ├── sessions/[id]/report/       # 振り返りレポート
│   │   │   └── history/                    # セッション履歴・スコア推移
│   │   ├── components/
│   │   │   ├── error-input/                # エラー貼り付けフォーム
│   │   │   ├── question-card/              # 質問 + 選択肢
│   │   │   ├── stage-progress/             # Lv1〜Lv5 のプログレス
│   │   │   ├── thinking-mentor/            # 「先輩が考えている」演出 (ADR-007)
│   │   │   ├── hint-button/                # ヒント段階開放
│   │   │   └── score-radar/                # デバッグ脳スコア（5 軸）
│   │   ├── lib/
│   │   │   ├── api-client.ts               # HTTP トリガーへの型付きクライアント
│   │   │   └── diagnose-trigger.ts         # ADR-006 の先行診断キック
│   │   └── ...
│   │
│   └── function/                 # ★ enebular クラウド実行環境 (ZIP)
│       ├── src/
│       │   ├── index.ts                    # exports.handler（Hono アダプタ）
│       │   ├── app.ts                      # Hono アプリ本体
│       │   ├── local.ts                    # ローカル起動 (@hono/node-server)
│       │   ├── routes/
│       │   │   ├── sessions.ts             # 作成 / 取得 / 削除
│       │   │   ├── diagnose.ts             # 先行診断 (ADR-006)
│       │   │   ├── answers.ts              # 回答受付・次問返却
│       │   │   ├── hints.ts                # ヒント開放
│       │   │   └── reports.ts              # レポート・統計
│       │   ├── middleware/
│       │   │   ├── anonymous-id.ts         # 匿名 ID Cookie の発行 / 解決
│       │   │   ├── rate-limit.ts           # レート制限 (NFR-O3)
│       │   │   └── error-handler.ts
│       │   └── services/
│       │       └── session-service.ts      # core / llm / datastore を束ねる層
│       ├── build.mjs                       # esbuild バンドル + ZIP 生成 (ADR-008)
│       ├── zip-package.json                # ZIP に同梱する最小 package.json
│       └── package.json
│
├── packages/
│   ├── shared/                   # ★ FE/BE 共有の型と Zod スキーマ（＝API 契約）
│   │   └── src/
│   │       ├── schemas/                    # Zod スキーマ
│   │       └── types/                      # 公開型（診断・正解は存在しない）
│   │
│   ├── core/                     # ★ ドメインロジック（外部依存なし・純関数）
│   │   └── src/
│   │       ├── stage-machine.ts            # Lv1〜Lv5 の遷移規則
│   │       ├── scoring.ts                  # デバッグ脳スコア算出
│   │       ├── hint-policy.ts              # ヒント開放条件
│   │       ├── leak-guard.ts               # 答え漏洩の検出ルール
│   │       ├── masking.ts                  # 秘匿情報マスキング (FR-13)
│   │       └── session-id.ts               # ULID 生成（サブキーの時系列ソート用）
│   │
│   ├── llm/                      # ★ OrcaRouter クライアントとプロンプト
│   │   └── src/
│   │       ├── orca-client.ts              # OpenAI SDK の baseURL 差し替え
│   │       ├── models.ts                   # 用途別モデル設定 / フォールバック
│   │       ├── diagnoser.ts                # 内部診断
│   │       ├── questioner.ts               # 出題
│   │       ├── judge.ts                    # 回答判定・到達判定
│   │       ├── reporter.ts                 # 振り返り生成
│   │       └── prompts/                    # プロンプトテンプレート
│   │
│   └── datastore/                # ★ enebular データストアのリポジトリ層
│       └── src/
│           ├── client.ts                   # CloudDataStoreClient のラッパ
│           ├── tables.ts                   # テーブル ID を環境変数から解決
│           ├── session-repo.ts             # sessions テーブル
│           ├── secret-repo.ts              # session_secrets（★非公開）
│           ├── report-repo.ts              # reports テーブル
│           └── ops-repo.ts                 # ops_logs テーブル
│
└── .github/
    └── workflows/
        ├── ci.yml                # typecheck / lint / test
        └── deploy-function.yml   # ZIP ビルド → enebular デプロイ
```

### 依存の向き

```
apps/web       ──▶ packages/shared
apps/function  ──▶ packages/shared, core, llm, datastore
packages/llm       ──▶ packages/shared           （core / datastore に依存しない）
packages/core      ──▶ packages/shared           （llm / datastore に依存しない = テスト容易）
packages/datastore ──▶ packages/shared
```

`packages/core` が他のどのパッケージにも依存しないことが重要。
段階遷移・スコアリング・LeakGuard は LLM とデータストアなしでテストできる（NFR-Q2）。

---

## 6. キャパシティ試算

enebular の利用制限のうち、**どれが最初に効いてくるか**を見積もる。
1 セッション = Lv1〜Lv5 で計 12 ターン、ヒント 2 回、レポート 1 回を標準ケースとする。

| 資源 | 1 セッションあたりの消費（見積） | フリー枠 / 月 | 上限セッション数 / 月 | エンタープライズ枠 / 月 | 上限セッション数 / 月 |
|---|---|---|---|---|---|
| **データストアアクセス** | **約 54 回** | 10,000 回 | **約 185** ← ボトルネック | 3,000,000 回 | 約 55,000 |
| HTTP リクエスト | 約 16 回 | 50,000 回 | 約 3,100 | 3,000,000 回 | 約 187,000 |
| 実行時間 | 約 55 秒（LLM 待ちを含む） | 24 時間 | 約 1,570 | 1,000 時間 | 約 65,000 |
| 保存データ | 約 35KB | 0.1GB | 約 2,800 | 10GB | 約 280,000 |

**結論: フリープランではデータストアのアクセス回数が最初に枯れる（約 185 セッション / 月）。**

### アクセス回数の内訳（1 ターンあたり 4 回）

| 操作 | 回数 |
|---|---|
| `sessions` を読む | 1 |
| `session_secrets` を読む（正解の照合） | 1 |
| `sessions` を書く（ターン追記・段階更新） | 1 |
| `session_secrets` を書く（次問の正解を保存） | 1 |

### 削減の余地（必要になったら実施 / 未決 Q-7）

| 案 | 効果 | トレードオフ |
|---|---|---|
| **正解を署名付きトークンでクライアントに預ける** | ターンあたり 4 → 2 回（**半減**） | サーバ鍵で AES-GCM 暗号化する実装が必要。鍵管理を誤ると答えが漏れる |
| レポートを `sessions` アイテムに同梱する | セッションあたり −2 回 | `/me/stats` が全セッションアイテムの読み出しになり、逆に増える場合がある |
| `ops_logs` を実行環境のログ出力に寄せる | セッションあたり −12 回 | ログサイズ枠（フリー 0.1GB）を消費する。集計はしづらくなる |

v1 は**素直な 4 回**で実装し、フリー枠での検証中にアクセス数を実測してから最適化を判断する。
先に最適化すると、答えの取り扱いという最も壊してはいけない部分を、
計測なしで複雑にすることになるため。

---

## 7. 環境変数

### クラウド実行環境（`envVars` として設定）

| 変数 | 用途 |
|---|---|
| `ORCAROUTER_API_KEY` | OrcaRouter の API キー（`sk-orca-...`）。**FE には絶対に置かない** |
| `ORCAROUTER_BASE_URL` | 既定 `https://api.orcarouter.ai/v1` |
| `MODEL_DIAGNOSER` | 内部診断に使うモデル ID（高性能） |
| `MODEL_QUESTIONER` | 出題に使うモデル ID（高速・安価） |
| `MODEL_JUDGE` | 判定に使うモデル ID（高速・安価） |
| `MODEL_FALLBACK` | 上記が失敗したときの退避先 (NFR-O1) |
| `DS_TABLE_SESSIONS` | データストアのテーブル ID（UUID） |
| `DS_TABLE_SECRETS` | 同上（★非公開テーブル） |
| `DS_TABLE_REPORTS` | 同上 |
| `DS_TABLE_OPS_LOGS` | 同上 |
| `SESSION_TOKEN_BUDGET` | 1 セッションの LLM トークン上限（既定 80000, NFR-C1） |
| `COOKIE_SECRET` | 匿名 ID Cookie の署名鍵 |
| `ALLOWED_ORIGIN` | CORS 許可オリジン（Vercel の URL） |
| `LOG_LEVEL` | `@uhuru/enebular-sdk` のログレベル |

> データストアへの認証情報は**実行環境が自動的に注入**するため、
> アプリ側でアクセスキーを持つ必要はない（`connectDataStore` を有効にすること）。

### フロントエンド（Vercel）

| 変数 | 用途 |
|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | enebular HTTP トリガーの URL |

### GitHub Actions Secrets

| 変数 | 用途 |
|---|---|
| `ENEBULAR_ACCESS_KEY` | enebular CLI の認証 |
| `ENEBULAR_SECRET_KEY` | 同上 |

詳細は [deployment.md](deployment.md)。

---

## 8. デプロイ構成

| コンポーネント | デプロイ先 | 方法 |
|---|---|---|
| `apps/web` | Vercel | GitHub 連携による自動デプロイ |
| `apps/function` | enebular クラウド実行環境 | GitHub Actions → `@uhuru/enebular-cli` → ZIP |
| データストア | enebular データストア | コンソールでテーブルを作成し、テーブル ID を `envVars` に設定 |

環境は **development / production の 2 プロジェクト**を用意し、
`main` ブランチへの push で development、タグ push で production にデプロイする。
詳細は [deployment.md](deployment.md)。
