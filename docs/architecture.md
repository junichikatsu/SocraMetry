# アーキテクチャと技術選定

| 項目 | 内容 |
|---|---|
| ドキュメント版数 | v0.1 |
| 作成日 | 2026-08-09 |
| 関連 | [要件定義書](requirements.md) / [ソクラテス式エンジン仕様](socratic-engine.md) |

---

## 1. 全体構成

```
┌──────────────────────────────────────────────────────────────┐
│  ブラウザ                                                      │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  apps/web — Next.js 15 (App Router)                     │  │
│  │  ・エラー投稿フォーム                                     │  │
│  │  ・質問カード / 選択肢 UI                                 │  │
│  │  ・スコアレーダーチャート                                 │  │
│  └────────────────────────────────────────────────────────┘  │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTPS (JSON + SSE)
                            │ Cookie: anonymous_id
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  apps/api — Hono (Node.js 22+)                                │
│                                                               │
│  ┌─ routes ────────────────────────────────────────────────┐ │
│  │  POST /v1/sessions        POST /v1/sessions/:id/answers  │ │
│  │  POST /v1/sessions/:id/hints   GET /v1/sessions/:id/...  │ │
│  └────────────────────────────┬────────────────────────────┘ │
│                               ▼                               │
│  ┌─ packages/core (純粋なドメインロジック / LLM 非依存) ─────┐ │
│  │  段階遷移ステートマシン ・ スコアリング ・ 漏洩ガード判定  │ │
│  └────────────────────────────┬────────────────────────────┘ │
│                               ▼                               │
│  ┌─ packages/llm ──────────────────────────────────────────┐ │
│  │  Diagnoser（内部診断） / Questioner（出題） / Judge（判定）│ │
│  └────────────────────────────┬────────────────────────────┘ │
│                               ▼                               │
│  ┌─ packages/db (Prisma) ──────────────────────────────────┐ │
│  └─────────────────────────────────────────────────────────┘ │
└───────────┬───────────────────────────────┬──────────────────┘
            │ OpenAI 互換 API                │
            ▼                               ▼
┌───────────────────────────┐   ┌──────────────────────────────┐
│  OrcaRouter (必須)         │   │  PostgreSQL                   │
│  api.orcarouter.ai/v1      │   │  sessions / questions /       │
│  ├ openai/*                │   │  answers / diagnoses(非公開) /│
│  ├ anthropic/*             │   │  reports                      │
│  └ google/*                │   └──────────────────────────────┘
└───────────────────────────┘
```

### 重要な境界線

1. **フロントエンドは LLM を直接叩かない。** OrcaRouter の API キーは `apps/api` の環境変数にのみ存在する。
2. **内部診断（＝答え）は API レスポンスの外に出ない。** `diagnoses` テーブルは公開 API から参照されず、
   フロントエンドに渡る型（`packages/shared`）にそもそもフィールドが存在しない。
   *型レベルで漏洩を防ぐ*のがこの分離の主目的。
3. **ドメインロジックは LLM に依存しない。** 段階遷移・スコアリングは `packages/core` の純関数で、LLM なしで単体テストできる。

---

## 2. 技術選定

| レイヤ | 採用技術 | 選定理由 |
|---|---|---|
| 言語 | TypeScript（全レイヤ） | FE/BE で型を共有し、API 契約を Zod スキーマ 1 箇所で定義できる |
| フロントエンド | Next.js 15 (App Router) | SSE の扱いやすさ、Vercel への即デプロイ、将来の OGP / SEO 対応 |
| スタイル | Tailwind CSS | 学習アプリとして UI の反復が多いため、スタイルの試行速度を優先 |
| バックエンド | Hono (Node.js 22+) | 軽量・型安全・SSE ネイティブ対応。Node / Workers 双方にデプロイ可能で移行の自由度が高い |
| バリデーション | Zod | `packages/shared` に置き、FE/BE 双方から同一スキーマを参照 |
| LLM ゲートウェイ | **OrcaRouter** | 必須要件。OpenAI 互換のため公式 `openai` SDK をそのまま利用可 |
| DB | PostgreSQL | JSONB で LLM の構造化出力を保持しつつ、リレーショナルな集計（スコア推移）も行う |
| ORM | Prisma | スキーマ駆動・型生成・マイグレーション管理 |
| モノレポ | pnpm workspaces + Turborepo | 型共有とビルドキャッシュ |
| テスト | Vitest | `packages/core` の純関数と漏洩ガードの回帰テスト |
| CI | GitHub Actions | typecheck / lint / test |

---

## 3. ADR（アーキテクチャ決定記録）

### ADR-001: フロントエンドとバックエンドを分離する

**決定**: Next.js の Route Handlers に BFF を寄せる単体構成ではなく、`apps/web` と `apps/api` を分ける。

**理由**:
- OrcaRouter の API キーと**内部診断（＝答え）を物理的にフロントの外**に置くことが、この製品では機能要件そのもの（P1: 答えは言わない）。境界を曖昧にしたくない
- 将来の IDE 拡張 / CLI（v3）は同じ API を叩く。Web 専用の BFF に依存させたくない
- ユーザーの意図した構成（フロントエンド + バックエンド + OrcaRouter）に一致する

**トレードオフ**: デプロイ先が 2 系統になり、CORS と認証情報の受け渡しを自前で管理する必要がある。
ただし v1 は Cookie ベースの匿名 ID のみなので複雑度は低い。

**却下案**: Next.js モノリス（Route Handlers を BFF にする）。1 デプロイで済み最速だが、
上記 3 点を満たさないため却下。

---

### ADR-002: バックエンドを TypeScript (Hono) にする（Python を採らない）

**決定**: バックエンドは TypeScript / Hono。

**理由**:
- OrcaRouter が OpenAI 互換であり、Python 固有の LLM エコシステム（LangChain 等）を必要としない
- 本製品の難所は「ライブラリの機能」ではなく**プロンプト設計と状態遷移**であり、言語による優劣がない
- FE/BE で Zod スキーマを共有できる価値が大きい（API 契約のずれが構造的に発生しない）
- 既存の OrcaRouter 疎通実装が TypeScript であり、そのまま `packages/llm` に流用できる

**却下案**: FastAPI (Python)。ML ライブラリの必要が生じた場合に再検討する。

---

### ADR-003: LLM を用途別に 3 つの役割へ分離する

**決定**: 単一の巨大プロンプトではなく、**Diagnoser / Questioner / Judge** の 3 役に分ける。

**理由**:
- 単一プロンプトで「原因を特定しつつ、それを絶対に言わない」を両立させると、答えが漏れる
- **Questioner に診断結果の "結論" を渡さず、"どこを見るべきか" だけを渡す**構造にすることで、
  漏洩を確率ではなく設計で防げる
- 役割ごとに最適なモデル・コストを選べる（診断は高性能、出題は高速）

詳細は [socratic-engine.md](socratic-engine.md) を参照。

---

### ADR-004: 認証なしで始め、後から載せられるデータモデルにする

**決定**: v1 は Cookie の匿名 ID のみ。`sessions.user_id` は nullable で最初から用意する。

**理由**:
- 「実務で今困っているエラーを投げる」という体験は、ログインを挟むと入口で落ちる
- 一方で履歴とスコア推移は DB がないと成立しない（→ 認証なし・DB あり）
- 将来 GitHub OAuth を追加した際、匿名 ID に紐づく既存セッションを一括で `user_id` に付け替えられる

**移行手順（v2 で実施）**: ログイン成功時、Cookie の `anonymous_id` を持つ全セッションの
`user_id` を新規ユーザーに UPDATE し、`anonymous_id` は監査用に残す。

---

### ADR-005: 内部診断を独立テーブルに隔離する

**決定**: 原因の答えを `sessions` に持たせず、`diagnoses` テーブルに分離する。

**理由**:
- `SELECT * FROM sessions` を返す実装ミス 1 つで製品価値が消える。**うっかり漏れない構造**にする
- `packages/shared` の公開型に診断フィールドを定義しないことで、コンパイル時に漏洩を防ぐ
- 公開 API のシリアライザは `packages/shared` の型のみを通す

---

## 4. フォルダ構成

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
│   ├── data-model.md             #   ER 図・テーブル定義
│   ├── api-spec.md               #   API 仕様
│   └── roadmap.md                #   マイルストーン
│
├── apps/
│   ├── web/                      # ★ フロントエンド (Next.js 15)
│   │   ├── app/
│   │   │   ├── page.tsx                    # ランディング / エラー投稿
│   │   │   ├── sessions/[id]/page.tsx      # 問答画面（コア体験）
│   │   │   ├── sessions/[id]/report/       # 振り返りレポート
│   │   │   └── history/                    # セッション履歴・スコア推移
│   │   ├── components/
│   │   │   ├── error-input/                # エラー貼り付けフォーム
│   │   │   ├── question-card/              # 質問 + 選択肢
│   │   │   ├── stage-progress/             # Lv1〜Lv5 のプログレス
│   │   │   ├── hint-button/                # ヒント段階開放
│   │   │   └── score-radar/                # デバッグ脳スコア（5 軸）
│   │   ├── lib/
│   │   │   ├── api-client.ts               # apps/api への型付きクライアント
│   │   │   └── sse.ts                      # SSE 受信ユーティリティ
│   │   └── ...
│   │
│   └── api/                      # ★ バックエンド (Hono)
│       ├── src/
│       │   ├── index.ts                    # エントリポイント
│       │   ├── routes/
│       │   │   ├── sessions.ts             # 作成 / 取得
│       │   │   ├── answers.ts              # 回答受付・次問返却
│       │   │   ├── hints.ts                # ヒント開放
│       │   │   └── reports.ts              # レポート・統計
│       │   ├── middleware/
│       │   │   ├── anonymous-id.ts         # 匿名 ID Cookie の発行 / 解決
│       │   │   ├── rate-limit.ts           # IP レート制限 (NFR-O3)
│       │   │   └── error-handler.ts
│       │   └── services/
│       │       └── session-service.ts      # core / llm / db を束ねるユースケース層
│       └── ...
│
├── packages/
│   ├── shared/                   # ★ FE/BE 共有の型と Zod スキーマ（＝API 契約）
│   │   └── src/
│   │       ├── schemas/                    # Zod スキーマ
│   │       └── types/                      # 公開型（診断フィールドは存在しない）
│   │
│   ├── core/                     # ★ ドメインロジック（LLM 非依存・純関数）
│   │   └── src/
│   │       ├── stage-machine.ts            # Lv1〜Lv5 の遷移規則
│   │       ├── scoring.ts                  # デバッグ脳スコア算出
│   │       ├── hint-policy.ts              # ヒント開放条件
│   │       ├── leak-guard.ts               # 答え漏洩の検出ルール
│   │       └── masking.ts                  # 秘匿情報マスキング (FR-13)
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
│   └── db/                       # ★ Prisma
│       ├── prisma/schema.prisma
│       └── src/index.ts
│
└── .github/
    └── workflows/ci.yml          # typecheck / lint / test
```

### 依存の向き

```
apps/web  ──▶ packages/shared
apps/api  ──▶ packages/shared, core, llm, db
packages/llm ──▶ packages/shared        （core には依存しない）
packages/core ──▶ packages/shared        （llm / db に依存しない = テスト容易）
packages/db  ──▶ packages/shared
```

`packages/core` が他のどのパッケージにも依存しないことが重要。
段階遷移とスコアリングは LLM と DB なしでテストできる（NFR-Q2）。

---

## 5. 環境変数

| 変数 | 配置 | 用途 |
|---|---|---|
| `ORCAROUTER_API_KEY` | apps/api | OrcaRouter の API キー（`sk-orca-...`）。**FE には絶対に置かない** |
| `ORCAROUTER_BASE_URL` | apps/api | 既定 `https://api.orcarouter.ai/v1` |
| `MODEL_DIAGNOSER` | apps/api | 内部診断に使うモデル ID（高性能） |
| `MODEL_QUESTIONER` | apps/api | 出題に使うモデル ID（高速・安価） |
| `MODEL_JUDGE` | apps/api | 判定に使うモデル ID（高速・安価） |
| `MODEL_FALLBACK` | apps/api | 上記が失敗したときの退避先 (NFR-O1) |
| `DATABASE_URL` | apps/api | PostgreSQL 接続文字列 |
| `SESSION_TOKEN_BUDGET` | apps/api | 1 セッションのトークン上限（既定 80000, NFR-C1） |
| `NEXT_PUBLIC_API_BASE_URL` | apps/web | apps/api のベース URL |

具体的なモデル ID は未決（[requirements.md Q-1](requirements.md#9-未決事項)）。
`GET /v1/models` でカタログを取得して確定させる。

---

## 6. デプロイ構成（想定）

| コンポーネント | 想定デプロイ先 |
|---|---|
| apps/web | Vercel |
| apps/api | Cloud Run / Railway / Fly.io のいずれか |
| PostgreSQL | Neon または Supabase（未決 Q-2） |

Hono を採用しているため、`apps/api` は Node ランタイムのまま
Cloud Run にも Workers にも載せられる。v1 は Node ランタイムで進める。
