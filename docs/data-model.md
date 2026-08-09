# データモデル

| 項目 | 内容 |
|---|---|
| ドキュメント版数 | v0.1 |
| 作成日 | 2026-08-09 |
| DBMS | PostgreSQL / Prisma |

---

## 1. ER 概要

```
  users (v2 で追加)
    │ 1
    │
    │ 0..*                 1        0..1
  sessions ──────────────────────▶ diagnoses   ★非公開（API に出さない）
    │ 1                                
    ├───────▶ 0..* questions ──────▶ 0..* answers
    │                    │
    │                    └─────────▶ 0..* hints
    │ 1
    └───────▶ 0..1 reports ────────▶ 0..* scores
```

**設計の要点**: `diagnoses`（＝答え）を `sessions` から独立させ、
公開 API のシリアライザが物理的に触れないようにする（[ADR-005](architecture.md#adr-005-内部診断を独立テーブルに隔離する)）。

---

## 2. テーブル定義

### 2.1 `users` — ユーザー（v2 で有効化）

v1 では**テーブルだけ作り、行は作らない**。`sessions.user_id` は常に NULL。

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | uuid | PK | |
| `provider` | text | | `github` 等 |
| `provider_user_id` | text | UNIQUE(provider, provider_user_id) | |
| `display_name` | text | | |
| `created_at` | timestamptz | NOT NULL | |

### 2.2 `sessions` — 学習セッション

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | uuid | PK | |
| `user_id` | uuid | FK users, **NULL 可** | v1 は常に NULL（[ADR-004](architecture.md#adr-004-認証なしで始め後から載せられるデータモデルにする)） |
| `anonymous_id` | text | NOT NULL, INDEX | Cookie に発行する匿名 ID |
| `error_text` | text | NOT NULL | **マスキング済み**のエラー本文 |
| `code_snippet` | text | NULL 可 | マスキング済み |
| `language` | text | NULL 可 | 例 `typescript` |
| `framework` | text | NULL 可 | 例 `nextjs` |
| `recent_change` | text | NULL 可 | 「直前にした変更」 |
| `current_stage` | text | NOT NULL | `observe` \| `localize` \| `hypothesize` \| `verify` \| `fix` |
| `hint_level` | smallint | NOT NULL, DEFAULT 0 | 0〜3 |
| `status` | text | NOT NULL | `active` \| `completed` \| `abandoned` \| `revealed` |
| `scored` | boolean | NOT NULL, DEFAULT true | 「答えを見る」使用時 false |
| `token_used` | integer | NOT NULL, DEFAULT 0 | セッション累計（NFR-C1 の上限判定） |
| `started_at` | timestamptz | NOT NULL | |
| `completed_at` | timestamptz | NULL 可 | |

インデックス: `(anonymous_id, started_at DESC)` — 履歴一覧用。

### 2.3 `diagnoses` — 内部診断 ★非公開

**このテーブルの内容は公開 API のレスポンスに一切含めない。**

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | uuid | PK | |
| `session_id` | uuid | FK sessions, UNIQUE | 1 セッション 1 診断 |
| `root_cause` | text | NOT NULL | **答え**。Judge の到達判定にのみ使用 |
| `evidence` | jsonb | | 根拠の配列 |
| `confidence` | real | NOT NULL | 0.0〜1.0 |
| `focus_hints` | jsonb | NOT NULL | 段階ごとの着目点。Questioner に渡す唯一の情報 |
| `distractor_themes` | jsonb | | 誤答選択肢の素材 |
| `difficulty` | text | | `easy` \| `medium` \| `hard` |
| `model_used` | text | | 監査用 |
| `created_at` | timestamptz | NOT NULL | |

> 実装上のガード: `packages/shared` の公開型に `root_cause` を**定義しない**。
> `diagnoses` を読むのは `packages/llm` の judge / reporter のみとし、
> `apps/api/routes` から直接参照することを lint ルールで禁止する。

### 2.4 `questions` — 出題

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | uuid | PK | |
| `session_id` | uuid | FK sessions, INDEX | |
| `stage` | text | NOT NULL | |
| `seq_in_stage` | smallint | NOT NULL | 同段階内の連番（1〜3） |
| `body` | text | NOT NULL | 質問文 |
| `options` | jsonb | NOT NULL | `[{ id, label }]` |
| `correct_option_id` | text | NOT NULL | **レスポンスに含めない** |
| `rationale_if_correct` | text | | |
| `rationale_if_wrong` | jsonb | | option_id → 誘導文 |
| `hint_level_at_creation` | smallint | NOT NULL | 生成時のヒントレベル |
| `leak_guard_retries` | smallint | NOT NULL, DEFAULT 0 | 漏洩ガードによる再生成回数（品質監視用） |
| `created_at` | timestamptz | NOT NULL | |

### 2.5 `answers` — 回答

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | uuid | PK | |
| `question_id` | uuid | FK questions, INDEX | |
| `selected_option_id` | text | NOT NULL | |
| `is_correct` | boolean | NOT NULL | |
| `feedback` | text | | ユーザーに返した文 |
| `elapsed_ms` | integer | | 出題から回答までの時間 |
| `answered_at` | timestamptz | NOT NULL | |

### 2.6 `hints` — ヒント開放履歴

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | uuid | PK | |
| `session_id` | uuid | FK sessions, INDEX | |
| `stage` | text | NOT NULL | |
| `level` | smallint | NOT NULL | 1〜3 |
| `body` | text | NOT NULL | |
| `auto` | boolean | NOT NULL, DEFAULT false | 3 回不正解による自動開放か |
| `created_at` | timestamptz | NOT NULL | |

### 2.7 `conclusions` — 原因宣言

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | uuid | PK | |
| `session_id` | uuid | FK sessions, INDEX | |
| `body` | text | NOT NULL | ユーザーが書いた原因 |
| `verdict` | text | NOT NULL | `reached` \| `partial` \| `not_reached` |
| `feedback` | text | | |
| `created_at` | timestamptz | NOT NULL | |

同一セッションで複数回宣言しうるため 1..* とする。

### 2.8 `reports` — 振り返りレポート

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | uuid | PK | |
| `session_id` | uuid | FK sessions, UNIQUE | |
| `stumbling_point` | text | | つまずいた段階と理由 |
| `generalized_lesson` | text | NOT NULL | **転用可能な学び**（本製品の実質的成果物） |
| `next_time_steps` | jsonb | | 次回の確認 3 ステップ |
| `revealed_answer` | text | | 完了後に開示してよい原因説明 |
| `created_at` | timestamptz | NOT NULL | |

### 2.9 `scores` — デバッグ脳スコア

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | uuid | PK | |
| `session_id` | uuid | FK sessions, UNIQUE | |
| `observe` | smallint | NOT NULL | 0〜100 |
| `localize` | smallint | NOT NULL | |
| `hypothesize` | smallint | NOT NULL | |
| `verify` | smallint | NOT NULL | |
| `fix` | smallint | NOT NULL | |
| `total` | smallint | NOT NULL | 加重平均 |
| `created_at` | timestamptz | NOT NULL | |

### 2.10 `llm_calls` — LLM 呼び出しログ（NFR-O2）

| カラム | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | uuid | PK | |
| `session_id` | uuid | FK sessions, INDEX, NULL 可 | |
| `role` | text | NOT NULL | `diagnoser` \| `questioner` \| `judge` \| `reporter` |
| `model` | text | NOT NULL | |
| `prompt_tokens` | integer | | |
| `completion_tokens` | integer | | |
| `latency_ms` | integer | | |
| `orca_headers` | jsonb | | `X-Orca-*` のルーティング情報 |
| `error` | text | NULL 可 | |
| `created_at` | timestamptz | NOT NULL | |

---

## 3. 秘匿情報マスキング（FR-13 / NFR-S2）

エラーログには認証情報が混入しやすい。**DB に保存する前・LLM に送る前**にマスクする。

| 対象 | 検出方法 | 置換後 |
|---|---|---|
| API キー類 | `sk-`, `ghp_`, `AKIA`, `AIza` 等のプレフィックス + 長さ | `[REDACTED_KEY]` |
| Bearer トークン | `Authorization: Bearer ...` | `[REDACTED_TOKEN]` |
| 接続文字列 | `postgres://user:pass@...` の資格情報部 | `[REDACTED_CREDENTIALS]` |
| メールアドレス | 正規表現 | `[REDACTED_EMAIL]` |
| ローカル絶対パス | `C:\Users\<name>\...` / `/home/<name>/...` のユーザー名部 | `<user>` |
| JWT | `eyJ` で始まる 3 セグメント | `[REDACTED_JWT]` |

実装は `packages/core/src/masking.ts`。**LLM を使わない決定的な正規表現**で行う
（LLM に送る前に処理する必要があるため、LLM は使えない）。

---

## 4. 認証追加時の移行（v2）

```sql
-- ログイン成功時、その匿名 ID のセッションを新ユーザーに引き継ぐ
UPDATE sessions
   SET user_id = :new_user_id
 WHERE anonymous_id = :cookie_anonymous_id
   AND user_id IS NULL;
```

`anonymous_id` は削除せず監査用に残す。
これにより、ログイン前に貯めた履歴とスコア推移がそのまま引き継がれる。

---

## 5. データ保持ポリシー

| 対象 | 保持期間 |
|---|---|
| `sessions` / `questions` / `answers` / `reports` / `scores` | 無期限（ユーザーによる削除まで） |
| `diagnoses` | セッション完了から 90 日で `root_cause` を NULL 化（レポート生成後は不要） |
| `llm_calls` | 90 日 |

ユーザーが履歴画面からセッションを削除した場合、関連行を **CASCADE 削除**する（NFR-S5）。
