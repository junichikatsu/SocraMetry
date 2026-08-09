# API 仕様

| 項目 | 内容 |
|---|---|
| ドキュメント版数 | v0.1 |
| 作成日 | 2026-08-09 |
| ベース URL | `https://api.socrametry.example/v1`（開発時 `http://localhost:8787/v1`） |

---

## 1. 共通仕様

### 認証 / セッション識別

v1 は認証なし。初回アクセス時に `anonymous_id` を Cookie で発行する。

```
Set-Cookie: sm_anon=<uuid>; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000; Path=/
```

以降のリクエストはこの Cookie で本人性を担保する。
v2 で認証を追加した際も Cookie は維持し、`user_id` への引き継ぎに使う。

### レスポンス形式

すべて `application/json; charset=utf-8`。エラーは以下の形式。

```jsonc
{
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "セッションが見つかりません",
    "detail": null
  }
}
```

| HTTP | code | 意味 |
|---|---|---|
| 400 | `INVALID_INPUT` | Zod バリデーション失敗 |
| 404 | `SESSION_NOT_FOUND` | 存在しない / 他人のセッション |
| 409 | `SESSION_COMPLETED` | 完了済みセッションへの操作 |
| 429 | `RATE_LIMITED` | レート制限（NFR-O3） |
| 429 | `TOKEN_BUDGET_EXCEEDED` | セッションのトークン上限超過（NFR-C1） |
| 503 | `LLM_UNAVAILABLE` | OrcaRouter への接続失敗（フォールバックも失敗） |

### ★ レスポンスに絶対に含めないフィールド

| フィールド | 理由 |
|---|---|
| `diagnoses.*`（`root_cause`, `evidence`, `confidence`） | 答えそのもの |
| `questions.correct_option_id` | 正解が分かってしまう |
| `questions.rationale_if_wrong` の全量 | 選ばれた選択肢の分だけ回答後に返す |

`packages/shared` の公開型にこれらのフィールドを**定義しない**ことで、型レベルで防ぐ。

---

## 2. エンドポイント一覧

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/v1/sessions` | セッション開始（エラー投稿） |
| GET | `/v1/sessions/:id` | セッション状態の取得（復帰用） |
| GET | `/v1/sessions/:id/stream` | 現在の質問生成を SSE で受信 |
| POST | `/v1/sessions/:id/answers` | 選択肢に回答し、次の質問を得る |
| POST | `/v1/sessions/:id/hints` | ヒントレベルを 1 段階上げる |
| POST | `/v1/sessions/:id/conclusion` | 原因を宣言し、到達判定を受ける |
| POST | `/v1/sessions/:id/reveal` | 答えを見る（解放条件を満たす場合のみ） |
| GET | `/v1/sessions/:id/report` | 振り返りレポートとスコア |
| DELETE | `/v1/sessions/:id` | セッション削除（NFR-S5） |
| GET | `/v1/me/sessions` | 履歴一覧（匿名 ID 単位） |
| GET | `/v1/me/stats` | スコア推移・軸別の傾向 |
| GET | `/v1/health` | ヘルスチェック |

---

## 3. 詳細

### 3.1 `POST /v1/sessions` — セッション開始

**リクエスト**

```jsonc
{
  "errorText": "TypeError: Cannot read properties of undefined (reading 'map')\n    at ProductList (ProductList.tsx:24:18)\n    ...",
  "codeSnippet": "const ProductList = ({ items }) => items.map(...)",   // 任意
  "language": "typescript",                                             // 任意（未指定なら推定）
  "framework": "nextjs",                                                // 任意
  "recentChange": "APIのレスポンス形式を変えた"                            // 任意
}
```

| フィールド | 型 | 必須 | 制約 |
|---|---|---|---|
| `errorText` | string | ✅ | 1〜20,000 文字 |
| `codeSnippet` | string | | 〜10,000 文字 |
| `language` | string | | 事前定義リスト |
| `framework` | string | | 事前定義リスト |
| `recentChange` | string | | 〜1,000 文字 |

**レスポンス** `201 Created`

```jsonc
{
  "session": {
    "id": "8f1c...",
    "status": "active",
    "currentStage": "observe",
    "stageIndex": 1,
    "totalStages": 5,
    "hintLevel": 0,
    "startedAt": "2026-08-09T10:00:00Z"
  },
  "question": {
    "id": "q_01...",
    "stage": "observe",
    "seqInStage": 1,
    "body": "このエラーメッセージは、何が undefined だったと言っていますか？",
    "options": [
      { "id": "a", "label": "map という名前の変数" },
      { "id": "b", "label": "map を呼び出そうとした対象のオブジェクト" },
      { "id": "c", "label": "map に渡したコールバック関数" },
      { "id": "d", "label": "map の戻り値" }
    ]
  }
}
```

**処理フロー**

1. 入力をマスキング（FR-13）→ DB 保存
2. Diagnoser を**非同期で開始**（重い処理）
3. 並行して Lv1 の観察質問を生成（NFR-P1 の 5 秒を守るため待たない）
4. Lv2 以降は診断完了後の `focus_hints` を使う

> 3 の時点で診断が未完でも、Lv1（エラーメッセージを読む）は診断結果なしで出題できる。
> これがレイテンシ要件を満たす鍵。

---

### 3.2 `GET /v1/sessions/:id/stream` — SSE ストリーミング（FR-15）

質問文の生成をトークン単位で受信する。`text/event-stream`。

```
event: token
data: {"text":"この"}

event: token
data: {"text":"エラー"}

event: question
data: {"id":"q_01...","stage":"observe","body":"...","options":[...]}

event: done
data: {}
```

| イベント | 内容 |
|---|---|
| `token` | 質問文の部分文字列（**選択肢は流さない**） |
| `question` | 漏洩ガード通過後の確定した質問オブジェクト |
| `error` | `{ code, message }` |
| `done` | 終了 |

> **注意**: `token` で流すのは質問文のみ。選択肢は漏洩ガード（LeakGuard）を通してからでないと
> 表示できないため、ストリームせず `question` イベントでまとめて送る。

---

### 3.3 `POST /v1/sessions/:id/answers` — 回答

**リクエスト**

```jsonc
{
  "questionId": "q_01...",
  "selectedOptionId": "b",
  "elapsedMs": 12400
}
```

**レスポンス** `200 OK`

```jsonc
{
  "result": {
    "isCorrect": true,
    "feedback": "その通りです。呼び出し対象を特定できましたね。"
  },
  "session": {
    "currentStage": "localize",
    "stageIndex": 2,
    "hintLevel": 0,
    "status": "active"
  },
  "nextQuestion": {
    "id": "q_02...",
    "stage": "localize",
    "seqInStage": 1,
    "body": "そのオブジェクトは、どこから渡ってきていますか？",
    "options": [ /* ... */ ]
  },
  "canDeclareConclusion": true,     // 「原因が分かった」ボタンの表示可否
  "canReveal": false                // 「答えを見る」の解放状態（FR-14）
}
```

不正解の場合は `nextQuestion` が**同一段階の別角度の質問**になる。
同段階 3 問目も不正解なら `hintLevel` が自動で 1 上がり、`nextQuestion` に反映される。

セッションが最終段階（`fix`）を通過した場合、`nextQuestion` は `null` になり
`session.status` が `completed` に遷移する。

---

### 3.4 `POST /v1/sessions/:id/hints` — ヒント開放

**リクエスト**: ボディ不要

**レスポンス** `200 OK`

```jsonc
{
  "hint": {
    "level": 1,
    "body": "エラーメッセージの後半に注目してみてください。"
  },
  "session": { "hintLevel": 1 }
}
```

`hintLevel` が既に 3 の場合は `409` を返す（それ以上のヒントは存在しない）。

---

### 3.5 `POST /v1/sessions/:id/conclusion` — 原因宣言

**リクエスト**

```jsonc
{ "body": "APIのレスポンスが返る前の初回レンダリングで items が undefined になっていた" }
```

**レスポンス** `200 OK`

```jsonc
{
  "verdict": "reached",            // reached | partial | not_reached
  "feedback": "その通りです。データが到着する前の状態を見落としていた、という構造ですね。",
  "session": { "status": "completed" },
  "reportUrl": "/v1/sessions/8f1c.../report"
}
```

`partial` / `not_reached` の場合は `session.status` は `active` のままで、
`nextQuestion` を伴って該当段階に戻る。**このとき原因は明かさない。**

---

### 3.6 `GET /v1/sessions/:id/report` — 振り返りレポート

セッションが `completed` または `revealed` のときのみ `200`。それ以外は `409`。

```jsonc
{
  "path": [
    { "stage": "observe",     "attempts": 1, "hintLevel": 0, "elapsedMs": 12400 },
    { "stage": "localize",    "attempts": 2, "hintLevel": 1, "elapsedMs": 48000 },
    { "stage": "hypothesize", "attempts": 1, "hintLevel": 1, "elapsedMs": 30100 },
    { "stage": "verify",      "attempts": 1, "hintLevel": 1, "elapsedMs": 22000 },
    { "stage": "fix",         "attempts": 1, "hintLevel": 1, "elapsedMs": 18000 }
  ],
  "stumblingPoint": "切り分けの段階で、変更点の洗い出しに時間がかかりました。",
  "generalizedLesson": "『X of undefined』は常に『X を持っているはずの入れ物が空だった』ことを意味します。まず入れ物の出所を辿るのが最短経路です。",
  "nextTimeSteps": [
    "エラーメッセージから、失敗した操作とその対象を特定する",
    "スタックトレース最上位のアプリケーションコード行を開く",
    "その値が非同期で来るなら、到着前の状態を必ず確認する"
  ],
  "revealedAnswer": "props の items が API 応答前の初回レンダリングで undefined だったため。",
  "score": {
    "observe": 100, "localize": 60, "hypothesize": 85, "verify": 85, "fix": 85,
    "total": 81,
    "previousTotal": 74,
    "scored": true
  }
}
```

`revealedAnswer` は**完了後にのみ**返る唯一の答えフィールド。
`GET /v1/sessions/:id`（進行中）のレスポンスには含まれない。

---

### 3.7 `GET /v1/me/sessions` — 履歴一覧

**クエリ**: `?limit=20&cursor=<id>`

```jsonc
{
  "sessions": [
    {
      "id": "8f1c...",
      "summary": "TypeError: Cannot read properties of undefined",
      "language": "typescript",
      "status": "completed",
      "reachedStage": "fix",
      "totalScore": 81,
      "startedAt": "2026-08-09T10:00:00Z"
    }
  ],
  "nextCursor": null
}
```

### 3.8 `GET /v1/me/stats` — スコア推移

```jsonc
{
  "sessionCount": 12,
  "selfReachRate": 0.75,
  "latest":  { "observe": 100, "localize": 60, "hypothesize": 85, "verify": 85, "fix": 85, "total": 81 },
  "average": { "observe": 88,  "localize": 55, "hypothesize": 72, "verify": 61, "fix": 70, "total": 70 },
  "trend": [
    { "startedAt": "2026-07-01T...", "total": 62 },
    { "startedAt": "2026-07-08T...", "total": 70 }
  ],
  "weakestAxis": "localize"
}
```

`scored = false`（答えを見たセッション）は `average` / `trend` から除外する。

---

## 4. レート制限（NFR-O3）

| 対象 | 制限 |
|---|---|
| `POST /v1/sessions` | 10 回 / 時 / IP |
| `POST /v1/sessions/:id/answers` | 120 回 / 時 / 匿名 ID |
| その他 | 600 回 / 時 / IP |

超過時は `429` と `Retry-After` ヘッダを返す。

---

## 5. API 契約の管理

リクエスト / レスポンスの Zod スキーマは `packages/shared/src/schemas/` に置き、
`apps/api`（検証）と `apps/web`（型付きクライアント）の**両方が同じ定義を参照**する。

```
packages/shared/src/schemas/
├── session.ts      # CreateSessionRequest / SessionPublic
├── question.ts     # QuestionPublic（correct_option_id を持たない）
├── answer.ts       # SubmitAnswerRequest / AnswerResult
├── report.ts       # ReportPublic / Score
└── error.ts        # ApiError
```

`QuestionPublic` に `correctOptionId` を定義しないことが、
[NFR-S3](requirements.md#62-セキュリティ--プライバシー)（答えを API に出さない）の実装上の担保となる。
