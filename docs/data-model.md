# データモデル（enebular データストア）

| 項目 | 内容 |
|---|---|
| ドキュメント版数 | v0.2 |
| 更新日 | 2026-08-09 |
| 主な変更 | PostgreSQL / Prisma を廃止し、**enebular データストア**のキー設計に全面書き換え |
| 参照 | [データストア概要](https://docs.enebular.com/ja/datastore/overview) / [@uhuru/enebular-sdk](https://www.npmjs.com/package/@uhuru/enebular-sdk) |

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
| テーブル数上限 **10（フリー） / 100（エンタープライズ）** | テーブルを増やさない。v1 は **4 テーブル**に収める |
| アクセス回数が課金・制限対象（フリー 10,000 回 / 月） | **読み書きの回数そのものが設計指標**（[architecture.md §6](architecture.md#6-キャパシティ試算)） |

### 3 つの設計原則

| # | 原則 | 理由 |
|---|---|---|
| **D1** | **1 セッション = 1 アイテム**に集約する | ターンごとにアイテムを分けるとアクセス回数が線形に増える（E4）。350KB に収まる限り 1 アイテムが最も安い |
| **D2** | **答えだけは別テーブルに隔離する** | `getItem` はアイテム全体を返す。カラム単位の防御がないため、テーブル分離が唯一の隔離手段（[ADR-005](architecture.md#adr-005-内部診断と正解を別テーブルに隔離する)） |
| **D3** | メインキーは `ownerId` という**抽象名**にする | v1 は `anon#<uuid>`、v2 は `user#<id>`。認証追加時にキー設計を変えずに済む（[ADR-004](architecture.md#adr-004-認証なしで始め後から載せられるデータ設計にする)） |

---

## 2. テーブル一覧（4 テーブル）

| # | テーブル | メインキー | サブキー | 用途 | 公開 |
|---|---|---|---|---|---|
| 1 | `sessions` | `ownerId` (string) | `sessionId` (string / ULID) | セッション本体 + 全ターン | ○ |
| 2 | `session_secrets` | `sessionId` (string) | `kind` (string) | **内部診断と正解** | **✗ 非公開** |
| 3 | `reports` | `ownerId` (string) | `sessionId` (string / ULID) | 振り返りレポート + スコア | ○ |
| 4 | `ops_logs` | `sessionId` (string) | `ts` (number / epoch ms) | LLM 呼び出しログ (NFR-O2) | ✗ 運用用 |

テーブル ID（UUID）は enebular コンソールでテーブルを作成して払い出し、
環境変数 `DS_TABLE_SESSIONS` などで実行環境に渡す（[architecture.md §7](architecture.md#7-環境変数)）。

### なぜこのキーなのか — アクセスパターン対応表

| # | 必要な操作 | 実現方法 | アクセス回数 |
|---|---|---|---|
| A1 | セッションを ID で取得 | `getItem(sessions, { ownerId, sessionId })` | 1 |
| A2 | 自分のセッション履歴を新しい順に一覧 | `query(sessions, "#ownerId = :ownerId", order: false, limit: 20)` | 1 |
| A3 | セッションの答えを取得 | `getItem(session_secrets, { sessionId, kind: "diagnosis" })` | 1 |
| A4 | 自分の全レポートを集計（スコア推移） | `query(reports, "#ownerId = :ownerId", limit: 100)` | 1 |
| A5 | あるセッションの運用ログを時系列で取得 | `query(ops_logs, "#sessionId = :sessionId", order: true)` | 1 |

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
  "ownerId": "anon#7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "sessionId": "01J8XK4M2N0000000000000001",

  // ── 入力（すべてマスキング済み）──
  "errorText": "TypeError: Cannot read properties of undefined (reading 'map')\n    at ProductList ...",
  "codeSnippet": "const ProductList = ({ items }) => items.map(...)",
  "language": "typescript",
  "framework": "nextjs",
  "recentChange": "APIのレスポンス形式を変えた",

  // ── 進行状態 ──
  "status": "active",              // active | completed | abandoned | revealed
  "currentStage": "localize",      // observe | localize | hypothesize | verify | fix
  "hintLevel": 1,                  // 0〜3
  "diagnosisStatus": "ready",      // pending | ready | failed  ← ADR-006 の同期用
  "scored": true,                  // 「答えを見る」使用時 false
  "tokenUsed": 24310,              // NFR-C1 の上限判定
  "startedAt": 1786000000000,
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

  // ── ヒント開放履歴 ──
  "hints": [
    { "stage": "localize", "level": 1, "body": "エラーメッセージの後半に…", "auto": false, "at": 1786000030000 }
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
  "ownerId": "anon#7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "sessionId": "01J8XK4M2N0000000000000001",

  "summary": "TypeError: Cannot read properties of undefined",
  "language": "typescript",
  "status": "completed",
  "reachedStage": "fix",

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
    "total": 81
  },
  "scored": true,
  "createdAt": 1786000300000
}
```

> `revealedAnswer` は**セッション完了後にのみ**返す唯一の答えフィールド。
> `sessions` ではなく `reports` に置くことで、進行中のセッション取得では
> そもそも読み出されない構造にしている。

---

### 3.4 `ops_logs` — LLM 呼び出しログ（NFR-O2）

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
**v1 では既定で無効**とし、環境変数 `OPS_LOG_ENABLED=true` のときだけ書く。
通常は実行環境の標準ログ（`console.log` の構造化 JSON）に出力する。

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

## 5. 秘匿情報マスキング（FR-13 / NFR-S2）

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

## 6. 認証追加時の移行（v2）

データストアには**キーの変更操作がない**ため、`ownerId` の付け替えは
read → put → delete の 3 手になる。

```ts
// ログイン成功時：匿名 ID のデータを新しい user ID に移す
const oldOwner = `anon#${cookieAnonId}`
const newOwner = `user#${userId}`

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
- アイテム数 × 2 回のアクセスを消費する。セッション 20 件なら約 80 アクセス
- `session_secrets` と `ops_logs` は `sessionId` がメインキーなので**移行不要**
- 途中で失敗しても再実行できるよう、put → delete の順にする（重複は起きるが欠損しない）
- `migratedFrom` を残して監査可能にする

---

## 7. データ保持ポリシー

| 対象 | 保持期間 |
|---|---|
| `sessions` / `reports` | 無期限（ユーザーによる削除まで） |
| `session_secrets` (`diagnosis`) | セッション完了から 90 日で `rootCause` を空にする（レポート生成後は不要） |
| `session_secrets` (`answerkeys`) | セッション完了時に削除（再出題はないため） |
| `ops_logs` | 90 日 |

ユーザーが履歴画面からセッションを削除した場合（NFR-S5）、
**CASCADE がないため関連アイテムを明示的に削除する**。

```
DELETE sessions        { ownerId, sessionId }
DELETE reports         { ownerId, sessionId }
DELETE session_secrets { sessionId, kind: "diagnosis" }
DELETE session_secrets { sessionId, kind: "answerkeys" }
DELETE ops_logs        { sessionId, ts } × N   （query して全件削除）
```

`ops_logs` の削除は件数分のアクセスを消費するため、
`OPS_LOG_ENABLED=false`（既定）であればスキップする。
