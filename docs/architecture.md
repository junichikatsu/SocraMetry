# アーキテクチャと技術選定

| 項目 | 内容 |
|---|---|
| ドキュメント版数 | v0.3 |
| 更新日 | 2026-08-09 |
| 主な変更 | **BtoB 化。** テナント分離（ADR-010）、事前集計（ADR-011）、認証（ADR-004 改訂）を追加。キャパシティ試算をエンタープライズ前提に更新 |
| 関連 | [要件定義書](requirements.md) / [評価モデル](evaluation-model.md) / [ソクラテス式エンジン仕様](socratic-engine.md) / [デプロイ](deployment.md) |

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
                            │ Cookie: sm_session (JWT)
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

### ADR-004: 認証を v1 の必須要件とする（BtoB 化に伴う改訂）

**決定**: v1 から認証（OIDC / OAuth）を必須とする。
データストアのメインキーは `ownerId = "<tenantId>:<memberId>"`。

**改訂の経緯**: 当初は「ログインを挟むと入口で落ちる」ことを理由に匿名利用で始める設計だった。
しかし提供形態が **BtoB（組織単位の仕組みとして導入）**に確定し、
**人事評価の根拠として使う**ことが主目的になったため、前提が変わった。

**理由**:
- 評価に使うには**誰のデータかが確定していなければならない**。匿名では成立しない
- 組織・ロール・チームの概念が必要になり、テナント分離（NFR-S5）が必須になった
- 業務コードとエラーログという機微な資産を扱うため、認証は導入企業側の要件でもある

**トレードオフ**: 入口の摩擦が増える。ただし BtoB では**組織が SSO を用意している**ことが多く、
個人利用ほどの障壁にはならない。導入前の体験用に `tenantId = "demo"` の
匿名モードを残す選択肢は保持する（[data-model.md §6](data-model.md#6-テナント分離の強制nfr-s5)）。

---

### ADR-010: テナント分離をキー設計とブランド型で強制する

**決定**: すべてのメインキーの先頭に `tenantId` を含め、
リポジトリ層は生の `string` ではなくブランド型 `OwnerId` / `TenantId` のみを受け取る。
`tenantId` は**認証済みトークンからのみ**取得し、リクエストパラメータからは受け取らない。

**理由**:
- BtoB では**他社のデータが 1 件でも漏れたら事業が終わる**。運用ルールでは守れない
- キーの先頭に `tenantId` があれば、別組織のデータは**メインキーが一致せず、
  クエリしても 0 件しか返らない**。実装ミスがあっても
  「情報漏洩」ではなく「データが見つからない」に着地する
- ブランド型により、`ownerId` を文字列連結で作るコードが**コンパイルを通らない**

**却下案**: アプリケーション層でのフィルタリング。
`WHERE tenant_id = ?` を書き忘れた 1 箇所で破綻するため。
**忘れられる防御は防御ではない。**

---

### ADR-011: ダッシュボードの集計をセッション完了時に事前計算する

**決定**: `member_stats` テーブルを設け、セッション完了時に更新する。
ダッシュボード閲覧時は `query` 1 回で読むだけにする。

**理由**:
- **enebular データストアに集計機能（COUNT / AVG / GROUP BY）がない**
- 閲覧時に集計すると、メンバー 20 名 × セッション 40 件 = **800 アクセス**が
  ダッシュボードを開くたびに発生する。E4（アクセス枠）とレイテンシの両方が破綻する
- 事前計算により **1 アクセス**で済む（[data-model.md A6](data-model.md#なぜこのキーなのか--アクセスパターン対応表)）

**トレードオフ**:
- 集計値は**キャッシュであり真実の源ではない**。並行更新で欠損しうる
- そのため `reports` テーブルから**再構築できる設計**にしておく
- レポート生成（`GET /report`）を冪等にしないと二重加算で**評価データが壊れる**ため、
  ここは特に慎重に実装する

---

### ADR-005: 内部診断と正解を別テーブルに隔離する

**決定**: 原因（`rootCause`）と各設問の正解（`correctOptionId`）を
`sessions` に入れず、**`session_secrets` テーブル**に分離する。
開示（Gate C）は `POST /reveal` と `GET /report` でのみ行う。

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
│   ├── evaluation-model.md       #   ★評価モデル（スコア・公平性・レポート）
│   ├── socratic-engine.md        #   対話エンジン仕様（3 ゲート・プロンプト設計）
│   ├── data-model.md             #   データストアのキー設計・アイテム定義
│   ├── api-spec.md               #   API 仕様
│   ├── deployment.md             #   ZIP デプロイと GitHub Actions
│   └── roadmap.md                #   マイルストーン
│
├── apps/
│   ├── web/                      # ★ フロントエンド (Next.js 15 / Vercel)
│   │   ├── app/
│   │   │   ├── page.tsx                    # ランディング / エラー投稿
│   │   │   ├── sessions/[id]/page.tsx      # 問答画面（3 ゲート）
│   │   │   ├── sessions/[id]/report/       # 振り返りレポート
│   │   │   ├── me/                         # 個人ダッシュボード・履歴
│   │   │   ├── assignments/                # 割り当てられた演習
│   │   │   └── org/                        # ★組織ダッシュボード・問題集・メンバー
│   │   ├── components/
│   │   │   ├── error-input/                # エラー貼り付けフォーム
│   │   │   ├── hint-panel/                 # Gate A: ヒント表示と段階開放
│   │   │   ├── question-card/              # Gate B: 設問 + 選択肢
│   │   │   ├── reveal-panel/               # Gate C: 解説 + 振り返り 1 問
│   │   │   ├── gate-progress/              # A/B/C の現在地
│   │   │   ├── stage-progress/             # Lv1〜Lv5 のプログレス
│   │   │   ├── thinking-mentor/            # 「先輩が考えている」演出 (ADR-007)
│   │   │   ├── score-radar/                # デバッグ脳スコア（5 軸）
│   │   │   ├── growth-chart/               # 成長率の推移
│   │   │   └── org-insight/                # 組織の弱点サマリ
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
│       │   │   ├── hints.ts                # Gate A: ヒント開放
│       │   │   ├── advance.ts              # Gate A → B
│       │   │   ├── answers.ts              # Gate B: 回答受付・次問返却
│       │   │   ├── reveal.ts               # Gate C: 開示 + 振り返り
│       │   │   ├── reports.ts              # レポート・個人統計
│       │   │   ├── problems.ts             # ★問題集の CRUD・実務→問題変換
│       │   │   ├── assignments.ts          # ★演習の割り当てと進捗
│       │   │   └── org.ts                  # ★ダッシュボード・メンバー・評価レポート
│       │   ├── middleware/
│       │   │   ├── auth.ts                 # ★トークン検証・認証コンテキスト構築
│       │   │   ├── authorize.ts            # ★ロール別の閲覧範囲制御 (NFR-S6)
│       │   │   ├── audit-log.ts            # ★監査ログ (NFR-S9)
│       │   │   ├── rate-limit.ts           # レート制限 (NFR-O3)
│       │   │   └── error-handler.ts
│       │   └── services/
│       │       ├── session-service.ts      # core / llm / datastore を束ねる層
│       │       ├── stats-service.ts        # ★member_stats の更新 (ADR-011)
│       │       └── evaluation-service.ts   # ★評価レポートの組み立て
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
│   │       ├── gate-machine.ts             # ★A/B/C のゲート遷移規則
│   │       ├── stage-machine.ts            # Lv1〜Lv5 の遷移規則
│   │       ├── scoring.ts                  # スコア算出（LLM 非依存, NFR-Q4）
│   │       ├── normalization.ts            # ★難易度正規化・成長率・time_index
│   │       ├── hint-policy.ts              # ヒント開放条件
│   │       ├── leak-guard.ts               # 答え漏洩の検出ルール
│   │       ├── masking.ts                  # 秘匿情報マスキング (FR-11)
│   │       ├── anonymize.ts                # ★実務→問題集の匿名化 (FR-35)
│   │       ├── stats-merge.ts              # ★member_stats の再計算（純関数）
│   │       └── session-id.ts               # ULID 生成（サブキーの時系列ソート用）
│   │
│   ├── llm/                      # ★ OrcaRouter クライアントとプロンプト
│   │   └── src/
│   │       ├── orca-client.ts              # OpenAI SDK の baseURL 差し替え
│   │       ├── models.ts                   # 用途別モデル設定 / フォールバック
│   │       ├── diagnoser.ts                # 内部診断
│   │       ├── hinter.ts                   # ★Gate A のヒント生成
│   │       ├── questioner.ts               # Gate B の出題
│   │       ├── judge.ts                    # 回答判定・到達判定
│   │       ├── revealer.ts                 # ★Gate C の解説生成
│   │       ├── reporter.ts                 # 振り返り生成
│   │       └── prompts/                    # プロンプトテンプレート
│   │
│   └── datastore/                # ★ enebular データストアのリポジトリ層
│       └── src/
│           ├── client.ts                   # CloudDataStoreClient のラッパ
│           ├── tables.ts                   # テーブル ID を環境変数から解決
│           ├── owner.ts                    # ★OwnerId / TenantId のブランド型 (ADR-010)
│           ├── session-repo.ts             # sessions
│           ├── secret-repo.ts              # session_secrets（★非公開）
│           ├── report-repo.ts              # reports
│           ├── org-repo.ts                 # ★org_directory
│           ├── stats-repo.ts               # ★member_stats
│           ├── assignment-repo.ts          # ★assignments
│           ├── problem-repo.ts             # ★question_bank
│           └── ops-repo.ts                 # ops_logs
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

BtoB 提供のため**エンタープライズプラン前提**（A-7）。
1 セッション = Gate A のヒント 2 回、Gate B で 12 ターン、レポート 1 回を標準ケースとする。

### 1 セッションあたりの消費

| 資源 | 消費（見積） |
|---|---|
| データストアアクセス | **約 58 回**（うち 4 回は `member_stats` の更新） |
| HTTP リクエスト | 約 18 回 |
| 実行時間 | 約 55 秒（LLM 待ちを含む） |
| 保存データ | 約 35KB |

### プラン別の上限

| 資源 | フリー枠 / 月 | 上限セッション | エンタープライズ枠 / 月 | 上限セッション |
|---|---|---|---|---|
| **データストアアクセス** | 10,000 回 | **約 170** ← ボトルネック | 3,000,000 回 | **約 51,000** |
| HTTP リクエスト | 50,000 回 | 約 2,700 | 3,000,000 回 | 約 166,000 |
| 実行時間 | 24 時間 | 約 1,570 | 1,000 時間 | 約 65,000 |
| 保存データ | 0.1GB | 約 2,800 | 10GB | 約 280,000 |

### 導入規模の目安（エンタープライズ）

| 規模 | 想定セッション / 月 | 判定 |
|---|---|---|
| 20 名 × 週 2 セッション | 約 160 | ✅ 余裕 |
| 100 名 × 週 2 セッション | 約 800 | ✅ 余裕 |
| 500 名 × 週 3 セッション | 約 6,000 | ✅ 余裕 |
| 1,000 名 × 毎日 1 セッション | 約 20,000 | ⚠️ 上限の 40%。要監視 |

**数百名規模までは余裕がある。** 制約が効いてくるのは 1,000 名超の全社導入時。
フリー枠は約 170 セッション / 月のため、**開発と PoC 専用**と考える。

### アクセス回数の内訳

**Gate B の 1 ターンあたり 4 回**

| 操作 | 回数 |
|---|---|
| `sessions` を読む | 1 |
| `session_secrets` を読む（正解の照合） | 1 |
| `sessions` を書く（ターン追記・段階更新） | 1 |
| `session_secrets` を書く（次問の正解を保存） | 1 |

**セッション完了時に 4 回**（ADR-011 の代償）

| 操作 | 回数 |
|---|---|
| `reports` に書く | 1 |
| `member_stats` を読む | 1 |
| `member_stats` を書く | 1 |
| `assignments` の進捗更新（演習モードのみ） | 1 |

> **この 4 回で、組織ダッシュボードが 1 アクセスで開ける。**
> 事前計算しなければ、ダッシュボードを開くたびに数百アクセスが発生する。
> 書き込み時に払うか、読み込み時に払うかの選択であり、
> **ダッシュボードは繰り返し開かれる**ため書き込み時に払う方が安い。

### 削減の余地（必要になったら実施 / 未決 Q-7）

| 案 | 効果 | トレードオフ |
|---|---|---|
| **正解を署名付きトークンでクライアントに預ける** | ターンあたり 4 → 2 回（**半減**） | サーバ鍵で AES-GCM 暗号化する実装が必要。鍵管理を誤ると答えが漏れる |
| 演習モードの `session_secrets` を省略 | 演習セッションで −12 回 | 正解が `question_bank` にあるため実は可能。ただし `question_bank` の読み出しが増える |
| `ops_logs` を実行環境のログ出力に寄せる | セッションあたり −14 回 | ログサイズ枠を消費する。集計はしづらくなる（v1 は既定で無効） |

v1 は**素直な実装**で進め、実測してから最適化を判断する。
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
| `DS_TABLE_ORG_DIRECTORY` | 同上（組織設定・メンバー） |
| `DS_TABLE_MEMBER_STATS` | 同上（事前集計） |
| `DS_TABLE_ASSIGNMENTS` | 同上（演習の割り当て） |
| `DS_TABLE_QUESTION_BANK` | 同上（社内問題集） |
| `DS_TABLE_OPS_LOGS` | 同上 |
| `SESSION_TOKEN_BUDGET` | 1 セッションの LLM トークン上限（既定 80000, NFR-C1） |
| `AUTH_ISSUER` | OIDC の issuer URL |
| `AUTH_CLIENT_ID` / `AUTH_CLIENT_SECRET` | OIDC クライアント資格情報 |
| `SESSION_JWT_SECRET` | セッション Cookie（JWT）の署名鍵 |
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
