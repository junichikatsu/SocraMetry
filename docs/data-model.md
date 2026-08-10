# データモデル（enebular データストア）

| 項目 | 内容 |
|---|---|
| ドキュメント版数 | v0.4 |
| 更新日 | 2026-08-10 |
| 主な変更 | `users` テーブル（v0.1 の簡易ログイン）を正式に定義し、全テーブルのサブキー型を明記（計 9 テーブル） |
| 参照 | [データストア概要](https://docs.enebular.com/ja/datastore/overview) / [@uhuru/enebular-sdk](https://www.npmjs.com/package/@uhuru/enebular-sdk) |

> ⚠️ **v0.1 の実装対象は 5 テーブル**（`users` / `sessions` / `session_secrets` / `reports` / `ops_logs`）。
> `org_directory` / `member_stats` / `assignments` / `question_bank` と
> テナント分離（§6）は **v0.2 以降**（F16 Won't）。
> `ownerId` は v0.1 では `usr_<id>`、v0.2 で `<tenantId>:<memberId>` に拡張する。
> 詳細は [scope-v0.1.md §4.4](scope-v0.1.md#44-データストアのテーブルを-5-つに絞る)。

---

## 1. データストアの性質と、そこから来る設計方針

enebular データストアは **JSON アイテムを格納するキーバリューストア**である。
リレーショナル DB ではないため、前版（v0.1）の正規化されたテーブル設計はそのまま使えない。

| 性質 | 設計への帰結 |
|---|---|
| **メインキー（必須）+ サブキー（任意）** の 2 段キー。組み合わせがテーブル内で一意 | DynamoDB のパーティションキー / ソートキーと同じ考え方で設計する |
| サブキーは**数値か文字列のみ** | 時系列ソートは「ULID を文字列サブキーにする」か「epoch ms を数値サブキーにする」 |
| 検索は**メインキー完全一致 + サブキー条件** | **二次インデックスがない**。メインキーで引けないアクセスパターンは作れない |
| JOIN / リレーションなし | 一緒に読むデータは**同じアイテムに入れる**（非正規化が原則） |
| 1 アイテム約 **350KB** まで | セッション 1 件をまるごと 1 アイテムにできる（見積 35KB） |
| テーブル数上限 **10（フリー） / 100（エンタープライズ）** | **v0.1 は 5 テーブル**（フリー / トライアル枠に収める / A-8）。v0.2 で 9 テーブルとなりエンタープライズプラン前提（A-10） |
| アクセス回数が課金・制限対象 | **読み書きの回数そのものが設計指標**（[architecture.md §6](architecture.md#6-キャパシティ試算)） |
| **集計クエリ（COUNT / AVG / GROUP BY）がない** | 組織ダッシュボードのために**集計を事前計算して専用テーブルに置く**（D4） |

### 4 つの設計原則

| # | 原則 | 理由 |
|---|---|---|
| **D1** | **1 セッション = 1 アイテム**に集約する | ターンごとにアイテムを分けるとアクセス回数が線形に増える（E4）。350KB に収まる限り 1 アイテムが最も安い |
| **D2** | **答えだけは別テーブルに隔離する** | `getItem` はアイテム全体を返す。カラム単位の防御がないため、テーブル分離が唯一の隔離手段（[ADR-005](architecture.md#adr-005-内部診断と正解を別テーブルに隔離する)） |
| **D3** | メインキーは `ownerId` という**抽象名**にし、**組織 ID を必ず含める** | テナント分離をキー設計で強制する（NFR-S5）。「他組織のデータを取ってくるクエリが書けない」状態にする |
| **D4** | **集計はセッション完了時に事前計算する** | KV ストアに集計機能がない。ダッシュボード表示時に全件走査すると、アクセス枠とレイテンシの両方が破綻する（NFR-C6 / NFR-P4） |

### `ownerId` の構成（D3）

```
ownerId = "<tenantId>:<memberId>"

  例（組織）  "org_ac31f2:usr_9d0e11"
  例（デモ）  "demo:anon_7c9e6679"
```

- **`tenantId` が先頭にあることが重要。** 組織をまたいだデータは、
  メインキーが一致しないため**そもそも取得できない**
- `packages/datastore` は `ownerId` を文字列で受け取らず、
  必ず `{ tenantId, memberId }` から組み立てる関数を通す。
  リクエストの `tenantId` は認証済みトークンからのみ取得し、パラメータからは受け取らない

---

## 2. テーブル一覧（9 テーブル）

| # | テーブル | メインキー | サブキー | サブキー型 | 用途 | 版 | 公開 |
|---|---|---|---|---|---|---|---|
| 1 | `users` | `email` | `kind`（`"account"` 固定） | 文字列 | 簡易ログインのアカウント | v0.1 | ✗ 非公開 |
| 2 | `sessions` | `ownerId` | `sessionId` (ULID) | 文字列 | セッション本体 + 全ターン | v0.1 | ○ |
| 3 | `session_secrets` | `sessionId` | `kind` | 文字列 | **内部診断と正解** | v0.1 | **✗ 非公開** |
| 4 | `reports` | `ownerId` | `sessionId` (ULID) | 文字列 | 振り返りレポート + スコア | v0.1 | ○ |
| 5 | `ops_logs` | `sessionId` | `ts` | **数値** (epoch ms) | LLM 呼び出しログ (NFR-O2) | v0.1 | ✗ 運用用 |
| 6 | **`org_directory`** | `tenantId` | `"meta"` \| `"member#<memberId>"` | 文字列 | 組織設定・メンバー・ロール | v0.2 | ○ |
| 7 | **`member_stats`** | `tenantId` | `memberId` | 文字列 | **事前計算した集計**（ダッシュボード用） | v0.2 | ○ |
| 8 | **`assignments`** | `ownerId` | `assignmentId` (ULID) | 文字列 | 演習問題の割り当てと進捗 | v0.2 | ○ |
| 9 | **`question_bank`** | `tenantId` | `problemId` (ULID) | 文字列 | 社内問題集 | v0.2 | ○ |

テーブル ID（UUID）は enebular コンソールで作成して払い出し、
環境変数 `DS_TABLE_SESSIONS` などで実行環境に渡す（[architecture.md §7](architecture.md#7-環境変数)）。
作成手順は [deployment.md §3.1](deployment.md#31-作成するテーブル5-つ)。

> **`ops_logs` のサブキーだけが数値型。** ほかはすべて文字列。
> `ts` を文字列で作ると A5 の時系列クエリが辞書順になり、桁が変わった時点で順序が壊れる。

### なぜこのキーなのか — アクセスパターン対応表

| # | 必要な操作 | 実現方法 | アクセス回数 |
|---|---|---|---|
| A0 | ログイン時にアカウントを引く | `getItem(users, { email, kind: "account" })` | 1 |
| A1 | セッションを ID で取得 | `getItem(sessions, { ownerId, sessionId })` | 1 |
| A2 | 自分のセッション履歴を新しい順に一覧 | `query(sessions, "#ownerId = :ownerId", order: false, limit: 20)` | 1 |
| A3 | セッションの答えを取得 | `getItem(session_secrets, { sessionId, kind: "diagnosis" })` | 1 |
| A4 | 自分の全レポートを集計（個人ダッシュボード） | `query(reports, "#ownerId = :ownerId", limit: 100)` | 1 |
| A5 | あるセッションの運用ログを時系列で取得 | `query(ops_logs, "#sessionId = :sessionId", order: true)` | 1 |
| **A6** | **組織の全メンバーの集計を取得（組織ダッシュボード）** | `query(member_stats, "#tenantId = :tenantId")` | **1** ← D4 の効果 |
| **A7** | 組織のメンバー一覧とロール | `query(org_directory, "#tenantId = :tenantId and begins_with(#sk, :member)")` | 1 |
| **A8** | 自分に割り当てられた演習の一覧 | `query(assignments, "#ownerId = :ownerId", order: false)` | 1 |
| **A9** | 社内問題集の一覧 | `query(question_bank, "#tenantId = :tenantId", limit: 100)` | 1 |

> **A6 が D4 の本質。** 事前計算しなければ、
> 「組織の全メンバーの全レポートを読んで平均を出す」＝メンバー 20 名 × セッション 40 件 = 800 アクセス
> がダッシュボードを開くたびに発生する。事前計算により **1 アクセス**で済む。

**`sessionId` に ULID を使う理由**: ULID は先頭 10 文字が生成時刻のミリ秒を表す
Crockford Base32 であり、**文字列としての辞書順 = 生成時刻順**になる。
サブキーを `sessionId` にするだけで A2 の「新しい順」が成立し、
別途 `startedAt` を持たせて 2 つ目のキーを消費する必要がない。
実装は `packages/core/src/session-id.ts`。

---

## 3. アイテム定義

### 3.1 `sessions` — セッション本体

**キー**: `ownerId`（メイン） / `sessionId`（サブ, ULID）

```jsonc
{
  // ── キー ──
  "ownerId": "org_ac31f2:usr_9d0e11",
  "sessionId": "01J8XK4M2N0000000000000001",

  // ── モードと出自 ──
  "mode": "live",                  // live（実務） | assessment（演習）
  "problemId": null,               // 演習モードのとき question_bank の problemId
  "assignmentId": null,            // 演習モードのとき assignments の ID
  "difficulty": "medium",          // easy | medium | hard（スコア正規化に使う）

  // ── 入力（すべてマスキング済み）──
  "errorText": "TypeError: Cannot read properties of undefined (reading 'map')\n    at ProductList ...",
  "codeSnippet": "const ProductList = ({ items }) => items.map(...)",
  "language": "typescript",
  "framework": "nextjs",
  "recentChange": "APIのレスポンス形式を変えた",

  // ── 進行状態 ──
  "status": "active",              // active | completed | abandoned
  "gate": "B",                     // A | B | C  ← 現在のゲート
  "reachedGate": null,             // 解決したゲート。評価の主軸（未解決なら null）
  "currentStage": "localize",      // observe | localize | hypothesize | verify | fix
  "hintLevel": 1,                  // Gate A のヒント開放レベル 0〜3
  "diagnosisStatus": "ready",      // pending | ready | failed  ← ADR-006 の同期用
  "tokenUsed": 24310,              // NFR-C1 の上限判定
  "startedAt": 1786000000000,
  "gateEnteredAt": { "A": 1786000000000, "B": 1786000300000, "C": null },
  "completedAt": null,

  // ── ターン（質問・回答・宣言をまとめて保持: D1）──
  "turns": [
    {
      "seq": 1,
      "kind": "question",          // question | conclusion
      "stage": "observe",
      "seqInStage": 1,
      "body": "このエラーメッセージは、何が undefined だったと言っていますか？",
      "options": [
        { "id": "a", "label": "map という名前の変数" },
        { "id": "b", "label": "map を呼び出そうとした対象のオブジェクト" }
      ],
      "hintLevelAtCreation": 0,
      "leakGuardRetries": 0,
      "askedAt": 1786000002000,

      // 回答後に同じ要素へ追記する
      "selectedOptionId": "b",
      "isCorrect": true,
      "feedback": "その通りです。呼び出し対象を特定できましたね。",
      "elapsedMs": 12400,
      "answeredAt": 1786000014400
    }
  ],

  // ── ヒント開放履歴（Gate A / B 共通）──
  "hints": [
    { "gate": "A", "level": 1, "body": "エラーメッセージの後半に…", "auto": false, "at": 1786000030000 }
  ]
}
```

> **`turns` に正解が入っていない**ことが最重要。`correctOptionId` と
> 不正解時の誘導文は `session_secrets` にしかない。
> このアイテムをそのまま JSON で返しても、答えは漏れない。

**サイズ見積**: `errorText` 20KB + ターン 12 件 × 約 1KB ≒ **35KB**（上限 350KB に対して十分な余裕）。

**サイズ超過時の扱い**: `errorText` は 20,000 文字で切り詰める（FR-01）。
それでも 350KB に近づいた場合は、古いターンの `options` の `label` を削って
`selectedOptionId` と `isCorrect` だけ残す（レポート生成に必要なのは正誤と試行回数のみ）。

---

### 3.2 `session_secrets` — 内部診断と正解 ★非公開

**キー**: `sessionId`（メイン） / `kind`（サブ, 文字列）

このテーブルの内容は**公開 API のレスポンスに一切含めない**。
`packages/datastore/src/secret-repo.ts` からのみアクセスし、
`apps/function/src/routes/` からの直接参照は lint ルールで禁止する。

#### `kind: "diagnosis"`

```jsonc
{
  "sessionId": "01J8XK4M2N0000000000000001",
  "kind": "diagnosis",

  "rootCause": "props で渡される items が API 応答の遅延により初回レンダリング時 undefined になっている",
  "confidence": 0.82,
  "evidence": ["スタックトレース 3 行目が ProductList.tsx:24", "map の呼び出し元がガードされていない"],

  // ↓ Questioner に渡してよい唯一の情報
  "focusHints": [
    { "stage": "observe",     "lookAt": "エラーメッセージの『reading map』の直前部分" },
    { "stage": "localize",    "lookAt": "スタックトレース最上位のアプリケーションコード行" },
    { "stage": "hypothesize", "lookAt": "map を呼んでいる変数がどこから来るか" },
    { "stage": "verify",      "lookAt": "その変数の初回レンダリング時点の値" },
    { "stage": "fix",         "lookAt": "非同期データが未到着の間の表示" }
  ],
  "distractorThemes": ["構文エラーの可能性", "ライブラリのバージョン不整合", "型定義の欠落"],
  "difficulty": "medium",
  "modelUsed": "anthropic/claude-sonnet-4.6",
  "createdAt": 1786000012000
}
```

#### `kind: "answerkeys"`

全ターンの正解を 1 アイテムにまとめて持つ（D1: アクセス回数削減のため）。

```jsonc
{
  "sessionId": "01J8XK4M2N0000000000000001",
  "kind": "answerkeys",
  "keys": {
    "1": {
      "correctOptionId": "b",
      "rationaleIfCorrect": "どのオブジェクトに対する操作かを特定できている",
      "rationaleIfWrong": {
        "a": "メッセージの語順をもう一度追ってみてください",
        "c": "括弧の中と外、どちらの話をしているでしょうか"
      }
    },
    "2": { "correctOptionId": "d", "rationaleIfCorrect": "...", "rationaleIfWrong": { } }
  },
  "updatedAt": 1786000014000
}
```

> **`kind` をサブキーにした理由**: 1 セッションに対して診断と正解表という
> 2 種類の秘匿データがあり、片方だけを読みたい場面がある
> （回答判定では `answerkeys` のみ、到達判定では `diagnosis` のみで足りる）。
> テーブルを分けるとテーブル数上限（フリー 10）を圧迫するため、`kind` で分けた。

---

### 3.3 `reports` — 振り返りレポート + スコア

**キー**: `ownerId`（メイン） / `sessionId`（サブ, ULID）

`sessions` と同じキー構成にすることで、`/me/stats` が
**1 回の `query` で全レポートを集計できる**（A4）。

```jsonc
{
  "ownerId": "org_ac31f2:usr_9d0e11",
  "sessionId": "01J8XK4M2N0000000000000001",

  "summary": "TypeError: Cannot read properties of undefined",
  "language": "typescript",
  "status": "completed",
  "mode": "live",                     // live | assessment（横比較の可否を分ける）
  "problemId": null,                  // 演習モードのみ
  "reachedGate": "B",                 // A | B | C ← 評価の主軸
  "reachedStage": "fix",
  "difficulty": "medium",

  "path": [
    { "stage": "observe",     "attempts": 1, "hintLevel": 0, "elapsedMs": 12400 },
    { "stage": "localize",    "attempts": 2, "hintLevel": 1, "elapsedMs": 48000 }
  ],
  "stumblingPoint": "切り分けの段階で、変更点の洗い出しに時間がかかりました。",
  "generalizedLesson": "『X of undefined』は常に『X を持っているはずの入れ物が空だった』ことを意味します。",
  "nextTimeSteps": [
    "エラーメッセージから、失敗した操作とその対象を特定する",
    "スタックトレース最上位のアプリケーションコード行を開く",
    "その値が非同期で来るなら、到着前の状態を必ず確認する"
  ],
  "revealedAnswer": "props の items が API 応答前の初回レンダリングで undefined だったため。",

  "score": {
    "observe": 100, "localize": 60, "hypothesize": 85, "verify": 85, "fix": 85,
    "total": 81,
    "gateFactor": 0.90,               // A=1.00 / B=0.90 / C=0.75
    "difficultyFactor": 1.0,          // easy=0.9 / medium=1.0 / hard=1.15
    "timeIndex": null                 // 演習モードのみ算出（中央値比）
  },
  "comparable": false,                // 横比較に使ってよいか（mode==="assessment" のときのみ true）
  "createdAt": 1786000300000
}
```

> **`comparable` を明示的に持つ理由**: 「実務モードのスコアで順位付けしない」（NFR-F2）は
> 運用ルールではなく**データ構造で守る**。ランキングと組織比較のクエリは
> `comparable === true` のレポートしか読まない。
> ルールを人の注意力に任せると、いつか必ず破られる。

> `score` に**算出の内訳（`gateFactor` / `difficultyFactor`）を保存している**のは、
> 利用者に算出根拠を提示するため（NFR-F1）。
> 「なぜこの点数なのか」を後から再現・説明できる状態にしておく。

> `revealedAnswer` は**セッション完了後にのみ**返す唯一の答えフィールド。
> `sessions` ではなく `reports` に置くことで、進行中のセッション取得では
> そもそも読み出されない構造にしている。

---

### 3.4 `org_directory` — 組織設定とメンバー

**キー**: `tenantId`（メイン） / `sk`（サブ, 文字列）

組織メタデータとメンバー一覧を 1 テーブルにまとめる（テーブル数の節約）。
サブキーの接頭辞で種別を分け、`begins_with` で絞り込む。

#### `sk: "meta"` — 組織設定（FR-40）

```jsonc
{
  "tenantId": "org_ac31f2",
  "sk": "meta",
  "name": "株式会社サンプル 開発本部",
  "plan": "enterprise",

  // 評価まわりの運用ポリシー（evaluation-model.md §6 / §8）
  "settings": {
    "rankingEnabled": false,          // 既定 無効
    "rankingScope": "team",           // team | org
    "rankingOptIn": true,             // 任意参加
    "evaluationReportEnabled": true,
    "dataRetentionDays": 730
  },
  "createdAt": 1786000000000
}
```

#### `sk: "member#<memberId>"` — メンバー（FR-32 / FR-33）

```jsonc
{
  "tenantId": "org_ac31f2",
  "sk": "member#usr_9d0e11",
  "memberId": "usr_9d0e11",
  "displayName": "佐藤",
  "email": "sato@example.com",
  "role": "member",                   // member | lead | admin
  "teamId": "team_backend",
  "status": "active",                 // active | suspended
  "authSubject": "github|1234567",    // OIDC / OAuth の sub
  "joinedAt": 1786000000000
}
```

> **ロールは必ずサーバ側でこのアイテムから引く。** クライアントから送られた
> ロールを信用しない（NFR-S6）。

---

### 3.5 `member_stats` — 事前計算した集計 ★D4 の要

**キー**: `tenantId`（メイン） / `memberId`（サブ, 文字列）

**セッション完了時に更新**し、ダッシュボード閲覧時は読むだけにする。
これがないと組織ダッシュボードが成立しない（A6 参照）。

```jsonc
{
  "tenantId": "org_ac31f2",
  "memberId": "usr_9d0e11",
  "displayName": "佐藤",
  "teamId": "team_backend",

  // ── 累計（取り組み量）──
  "sessionCount": 38,
  "sessionCountLive": 30,
  "sessionCountAssessment": 8,
  "totalElapsedMs": 33120000,
  "lastSessionAt": 1786500000000,

  // ── 到達ゲート分布（自力解決率の素）──
  "gateCounts": { "A": 9, "B": 19, "C": 10, "unresolved": 0 },

  // ── 5 軸（直近 5 件の平均。評価の現在地）──
  "recentAxes":  { "observe": 88, "localize": 71, "hypothesize": 76, "verify": 58, "fix": 72 },
  // ── 5 軸（その 1 つ前の 5 件の平均。成長率の分母）──
  "previousAxes": { "observe": 80, "localize": 50, "hypothesize": 68, "verify": 56, "fix": 64 },
  "growthRate": 12,                   // recent 平均 − previous 平均

  // ── 正答率と速度 ──
  "correctRate": 0.72,                // Gate B の設問正答率（累計）
  "timeIndexAvg": 1.08,               // 演習問題の中央値比。1.0 が中央値

  // ── 移動平均の履歴（推移グラフ用。直近 20 件だけ保持）──
  "trend": [
    { "sessionId": "01J8W...", "mode": "assessment", "total": 62, "gate": "B", "at": 1785000000000 },
    { "sessionId": "01J8X...", "mode": "live",       "total": 70, "gate": "A", "at": 1785600000000 }
  ],

  "updatedAt": 1786500000000
}
```

**更新タイミングと手順**（セッション完了時、アクセス 2 回）:

```
1. getItem(member_stats, { tenantId, memberId })      … 1 回
2. 新しいセッションの結果をマージして再計算（純関数）
3. putItem(member_stats, 更新済みアイテム)             … 1 回
```

> **`trend` を直近 20 件で打ち切る理由**: アイテムサイズ 350KB の上限があるため。
> 20 件で約 3KB。それ以上の長期推移が必要になったら、
> 期間別サマリ（月次集計）を別のサブキーで持つ方式に拡張する。

> **並行更新の競合**: 同一メンバーが 2 セッションを同時完了すると、
> 片方の更新が失われうる。`sessionCount` の欠損は許容し、
> **正確性が必要なときは `reports` テーブルから再構築できる**ようにしておく
> （`member_stats` はあくまでキャッシュであり、真実の源ではない）。

---

### 3.6 `assignments` — 演習問題の割り当て（FR-36 / FR-37）

**キー**: `ownerId`（メイン） / `assignmentId`（サブ, ULID）

```jsonc
{
  "ownerId": "org_ac31f2:usr_9d0e11",
  "assignmentId": "01J8XM5P3Q0000000000000001",

  "problemIds": ["01J8A...", "01J8B...", "01J8C..."],
  "title": "新人研修 第1回 — エラーの読み方",
  "assignedBy": "usr_lead001",
  "assignedAt": 1786000000000,
  "dueAt": 1786600000000,

  "status": "in_progress",            // not_started | in_progress | completed | overdue
  "progress": {
    "01J8A...": { "sessionId": "01J8XK...", "reachedGate": "A", "total": 92, "completedAt": 1786100000000 },
    "01J8B...": { "sessionId": "01J8XL...", "reachedGate": "B", "total": 71, "completedAt": 1786200000000 },
    "01J8C...": null
  }
}
```

割り当て時は対象メンバーの人数分アイテムを作る（`ownerId` が異なるため）。
チーム 10 名への割り当て = 10 アクセス。

---

### 3.7 `question_bank` — 社内問題集（FR-34 / FR-35）

**キー**: `tenantId`（メイン） / `problemId`（サブ, ULID）

```jsonc
{
  "tenantId": "org_ac31f2",
  "problemId": "01J8A7R2K50000000000000001",

  "title": "非同期データ到着前のレンダリング",
  "errorText": "TypeError: Cannot read properties of undefined (reading 'map')\n    at ProductList ...",
  "codeSnippet": "const ProductList = ({ items }) => items.map(...)",
  "language": "typescript",
  "framework": "nextjs",
  "recentChange": "APIのレスポンス形式を変えた",

  "difficulty": "medium",             // easy | medium | hard（FR-25）
  "category": "async",
  "targetLevel": "junior",
  "tags": ["react", "undefined", "非同期"],

  // 出題側が用意した内部診断。演習では Diagnoser を呼ばず、これを使う
  "diagnosis": {
    "rootCause": "...",
    "focusHints": [ /* ... */ ],
    "distractorThemes": [ /* ... */ ]
  },

  // 実務セッションから生成した場合の出自（FR-35）
  "sourceSessionId": "01J8XK4M2N0000000000000001",
  "anonymized": true,

  // 実績（難易度の自動算出に使う / 未決 Q-10）
  "stats": { "attempts": 24, "gateA": 5, "gateB": 14, "gateC": 5, "medianElapsedMs": 480000 },

  "createdBy": "usr_lead001",
  "createdAt": 1786000000000,
  "status": "published"               // draft | published | archived
}
```

> **演習モードで `diagnosis` を事前に持つ利点**が 2 つある。
> 1つは **LLM 呼び出しが 1 回減る**こと（コストとレイテンシ）。
> もう1つは、**全員が同じ診断・同じ着眼点で出題される**ため、
> 評価の条件が厳密に揃うこと（NFR-F2 の担保）。

> **匿名化（`anonymized`）は必須。** 実務セッションを問題集にする際、
> 社名・顧客名・内部パス・固有の識別子を除去する。
> 自動化の精度は未検証のため、v1 は**登録者による目視確認を必須**とする（未決 Q-13）。

---

### 3.8 `ops_logs` — LLM 呼び出しログ（NFR-O2）

**キー**: `sessionId`（メイン） / `ts`（サブ, epoch ms 数値）

```jsonc
{
  "sessionId": "01J8XK4M2N0000000000000001",
  "ts": 1786000012345,
  "role": "diagnoser",            // diagnoser | questioner | judge | reporter
  "model": "anthropic/claude-sonnet-4.6",
  "promptTokens": 4210,
  "completionTokens": 680,
  "latencyMs": 9800,
  "orcaHeaders": { "x-orca-provider": "anthropic", "x-orca-route": "primary" },
  "leakGuardHit": false,
  "error": null
}
```

**書き込み方針**: データストアのアクセス枠を消費するため、
環境変数 `OPS_LOG_ENABLED=true` のときだけ書き、無効時は実行環境の標準ログ
（`console.log` の構造化 JSON）に出力する。

| 版 | 既定値 | 理由 |
|---|---|---|
| **v0.1** | **`true`（有効）** | 実測コスト表（F11）を成果物とするため、集計できる形で残す必要がある。検証中はセッション数が少なく、アクセス枠への影響が問題にならない |
| v0.2 以降 | `false`（無効） | セッションあたり約 14 アクセスを消費する。運用規模ではログ出力に寄せる |

---

### 3.9 `users` — 簡易ログインのアカウント（v0.1）

**キー**: `email`（メイン） / `kind`（サブ, 文字列。値は `"account"` 固定）

v0.1 の簡易認証（メール + パスワード / [security.md §5](security.md#5-認証v01-の簡易実装)）で使う。
**v0.2 で SSO（OIDC / OAuth）に移行する際は `org_directory` の
`member#<memberId>` アイテムに統合され、このテーブルは役目を終える。**

```jsonc
{
  "email": "sato@example.com",
  "kind": "account",

  "userId": "usr_9d0e11",            // ownerId の実体。v0.1 は "usr_<id>" がそのまま ownerId
  "displayName": "佐藤",
  "passwordHash": "…",               // node:crypto の scrypt（ソルトはユーザーごと）
  "passwordSalt": "…",
  "status": "active",                // active | suspended
  "createdAt": 1786000000000,
  "lastLoginAt": 1786500000000
}
```

**アクセスパターンは 1 つだけ**: ログイン時に `getItem(users, { email, kind: "account" })`。
メールアドレスがそのままメインキーであり、二次インデックスを必要としない。

> **サブキーが 1 値しかないのに持たせている理由**: enebular データストアのキーは
> 「メインキー + サブキー」の組で一意になる。将来 1 アカウントに複数の付帯情報
> （API トークン、通知設定など）を持たせたくなったとき、
> **`kind` を増やすだけで済む形**にしておく。`session_secrets` と同じ設計。

> **`userId` を別に持ち、メールをキーにしない**のは、
> `sessions` / `reports` のメインキー `ownerId` にメールアドレスを載せないため。
> メール変更でキーが変わると、過去のセッションが引けなくなる。

---

## 4. 排他制御と冪等性

**データストアにトランザクションはない。** Lambda は同一セッションに対して
リクエストが並行到達しうる（例: ユーザーの二重タップ、ADR-006 の診断リクエストと回答の競合）。
以下で対処する。

| 問題 | 対策 |
|---|---|
| 回答の二重送信でターンが重複する | クライアントは `questionId`（= `sessionId#seq`）を送る。サーバは `turns[seq]` に既に `answeredAt` があれば**同じ結果を返して終了**（冪等） |
| 診断リクエストの二重発火 | `sessions.diagnosisStatus` が `pending` 以外なら即 `200` を返して何もしない |
| 回答が診断より先に到着 | `diagnosisStatus !== "ready"` なら `202 Accepted` + `retryAfterMs` を返す（[ADR-006](architecture.md#adr-006-sse-を廃止し診断の先行実行で体感速度を確保する)） |
| 2 つの書き込みが `sessions` を上書きし合う | セッションは**単一ユーザーの逐次操作**が前提であり、実害のある競合はほぼ起きない。`turns` への追記は「読んだ配列に append して put」とし、`seq` の重複は上記の冪等判定で吸収する |

> **完全な排他は諦める設計にしている。** 楽観ロック用のバージョン列を持たせても、
> compare-and-swap がストア側にない以上は原子的に守れない。
> 代わりに、競合が起きても**壊れず、同じ結果になる**ように操作を冪等に設計する。

---

## 5. 秘匿情報マスキング（FR-11 / NFR-S2）

エラーログには認証情報が混入しやすい。**データストアに保存する前・LLM に送る前**にマスクする。

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

## 6. テナント分離の強制（NFR-S5）

**「他組織のデータを取ってくるクエリが書けない」状態をコードで作る。**
運用ルールや注意喚起ではなく、型と関数シグネチャで守る。

```ts
// packages/datastore/src/owner.ts

/** 認証済みコンテキストからのみ生成できる。生の文字列からは作れない */
export type OwnerId = string & { readonly __brand: 'OwnerId' }

export function ownerIdOf(ctx: AuthContext, memberId: string): OwnerId {
  return `${ctx.tenantId}:${memberId}` as OwnerId
}

// リポジトリは OwnerId 型しか受け取らない
export function getSession(owner: OwnerId, sessionId: string): Promise<SessionItem | null>
```

| # | ルール |
|---|---|
| 1 | `tenantId` は**認証済みトークンからのみ**取得する。リクエストのパラメータ・ボディ・ヘッダから受け取らない |
| 2 | リポジトリ層の関数は `OwnerId` / `TenantId` のブランド型のみを受け取る。生の `string` を渡せない |
| 3 | `member` ロールは自分の `memberId` 以外を指定できない。`lead` はチーム所属を確認、`admin` は組織内のみ（NFR-S6） |
| 4 | 他組織参照を試みるリクエストは `403` を返し、**監査ログに記録**する（NFR-S9） |

> **キー設計とアクセス制御が一致していることが重要。**
> `ownerId` の先頭に `tenantId` があるため、
> 別組織のデータはメインキーが一致せず、**クエリしても 0 件しか返らない**。
> 実装ミスがあっても、情報漏洩ではなく「データが見つからない」に着地する。

### 体験デモから組織への移行

導入前の体験用に `tenantId = "demo"` の匿名利用を残す場合、
契約後に組織テナントへ移す必要がある。
データストアには**キーの変更操作がない**ため、read → put → delete の 3 手になる。

```ts
const oldOwner = ownerIdOf({ tenantId: 'demo' }, `anon_${cookieAnonId}`)
const newOwner = ownerIdOf({ tenantId: orgId }, memberId)

for (const table of [TABLE_SESSIONS, TABLE_REPORTS]) {
  const items = await ds.query({ tableId: table, expression: '#ownerId = :ownerId',
                                 values: { ownerId: oldOwner }, limit: 1000 })
  for (const item of items) {
    await ds.putItem({ tableId: table, item: { ...item, ownerId: newOwner, migratedFrom: oldOwner } })
    await ds.deleteItem({ tableId: table, key: { ownerId: oldOwner, sessionId: item.sessionId } })
  }
}
```

**注意点**:
- アイテム数 × 2 回のアクセスを消費する
- `session_secrets` と `ops_logs` は `sessionId` がメインキーなので**移行不要**
- 途中で失敗しても再実行できるよう put → delete の順にする（重複は起きるが欠損しない）
- 移行したセッションは `comparable: false` のままとし、**評価データには算入しない**
  （デモ時の成績を評価に持ち込まない）

---

## 7. データ保持ポリシー

| 対象 | 保持期間 |
|---|---|
| `users` | 退会または v0.2 の SSO 移行まで（移行後は `org_directory` に統合して削除） |
| `sessions` / `reports` | 組織設定 `dataRetentionDays`（既定 730 日）または利用者による削除まで |
| `session_secrets` (`diagnosis`) | セッション完了から 90 日で `rootCause` を空にする（レポート生成後は不要） |
| `session_secrets` (`answerkeys`) | セッション完了時に削除（再出題はないため） |
| `member_stats` | メンバー無効化から 1 年（退職者の評価履歴の参照期間） |
| `question_bank` | 無期限（組織の資産） |
| `ops_logs` | 90 日 |

### 削除の実行（NFR-S7）

**CASCADE がないため、関連アイテムを明示的に削除する。**

**セッション 1 件の削除**

```
DELETE sessions        { ownerId, sessionId }
DELETE reports         { ownerId, sessionId }
DELETE session_secrets { sessionId, kind: "diagnosis" }
DELETE session_secrets { sessionId, kind: "answerkeys" }
DELETE ops_logs        { sessionId, ts } × N   （query して全件削除）
```

`ops_logs` の削除は件数分のアクセスを消費するため、
`OPS_LOG_ENABLED=false` であればスキップする（v0.1 は `true` のため実行される）。

**セッション削除時は `member_stats` の再計算が必要。**
`member_stats` はキャッシュなので、削除後に `reports` から再構築する。

**メンバー退職時**

```
UPDATE org_directory { tenantId, sk: "member#<id>" }  → status: "suspended"
（セッションとレポートは組織の資産として残す。1 年後に member_stats を削除）
```

**組織解約時**

全テーブルから `tenantId` に紐づくアイテムを削除する。
`sessions` / `reports` / `assignments` は `ownerId` がメインキーのため、
**先に `org_directory` からメンバー一覧を取得**し、メンバーごとに `query` → `delete` する。

```
1. query(org_directory, tenantId)                    → メンバー一覧
2. 各メンバーについて query(sessions|reports|assignments, ownerId) → delete
3. query(question_bank, tenantId) → delete
4. query(member_stats, tenantId) → delete
5. org_directory の全アイテムを delete
```

> 件数によっては大量のアクセスを消費するため、**解約処理はバッチとして
> 分割実行できる設計**にする（1 回のリクエストで完了させようとしない）。
