# API 仕様

| 項目 | 内容 |
|---|---|
| ドキュメント版数 | v0.2 |
| 更新日 | 2026-08-09 |
| 主な変更 | SSE を廃止（Lambda はバッファ応答のため）、先行診断 `POST /sessions/:id/diagnose` を追加 |
| ホスト | enebular クラウド実行環境の HTTP トリガー URL（`NEXT_PUBLIC_API_BASE_URL`） |

---

## 1. 共通仕様

### エンドポイントの実体

enebular の HTTP トリガーは**パスを 1 本しか持てない**（インスタンス内で一意）。
そのため、トリガーのパスをアプリのルートとし、**その配下のルーティングは
関数内部の Hono が行う**（[ADR-009](architecture.md#adr-009-hono-を-lambda-ハンドラのルーターとして使う)）。

```
https://<enebular-http-trigger>/socrametry/v1/sessions
                                └─ トリガーのパス ─┘└─ Hono の内部ルート ─┘
```

以下、パスは Hono の内部ルート（`/v1/...`）で表記する。

### 認証 / セッション識別

v1 は認証なし。初回アクセス時に匿名 ID を Cookie で発行する。

```
Set-Cookie: sm_anon=<uuid>.<hmac>; HttpOnly; Secure; SameSite=None; Max-Age=31536000; Path=/
```

> `SameSite=None` なのは、フロント（Vercel）と API（enebular）が**別オリジン**のため。
> `Secure` 必須。CORS は `Access-Control-Allow-Credentials: true` と
> `Access-Control-Allow-Origin: <ALLOWED_ORIGIN>`（ワイルドカード不可）を返す。

内部的には Cookie の UUID から `ownerId = "anon#<uuid>"` を組み立て、
データストアのメインキーとして使う（[data-model.md](data-model.md#2-テーブル一覧4-テーブル)）。

### レスポンス形式

すべて `application/json; charset=utf-8`。Lambda ハンドラは
`{ statusCode, headers, body }` を返すため、**ストリーミングは行われない**。

エラーは以下の形式。

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
| 409 | `HINT_EXHAUSTED` | ヒントレベルが既に 3 |
| 429 | `RATE_LIMITED` | レート制限（NFR-O3） |
| 429 | `TOKEN_BUDGET_EXCEEDED` | セッションのトークン上限超過（NFR-C1） |
| 503 | `LLM_UNAVAILABLE` | OrcaRouter への接続失敗（フォールバックも失敗） |
| 503 | `DATASTORE_UNAVAILABLE` | enebular データストアへのアクセス失敗 |

`202 Accepted` は**エラーではなく待機**を意味する（→ §3.3）。

### ★ レスポンスに絶対に含めないフィールド

| フィールド | 保存先 | 理由 |
|---|---|---|
| `rootCause` / `evidence` / `confidence` | `session_secrets` (`kind: "diagnosis"`) | 答えそのもの |
| `correctOptionId` | `session_secrets` (`kind: "answerkeys"`) | 正解が分かってしまう |
| `rationaleIfWrong` の全量 | 同上 | 選ばれた選択肢の分だけ回答後に返す |

`packages/shared` の公開型にこれらを**定義しない**ことで、型レベルで防ぐ。
さらにデータストア上も別テーブルに隔離されているため、
セッションアイテムをそのまま返しても漏れない（[ADR-005](architecture.md#adr-005-内部診断と正解を別テーブルに隔離する)）。

---

## 2. エンドポイント一覧

| メソッド | パス | 説明 | 想定レイテンシ |
|---|---|---|---|
| POST | `/v1/sessions` | セッション開始（エラー投稿）。**診断は待たない** | 〜5 秒 |
| POST | `/v1/sessions/:id/diagnose` | 先行診断の実行（クライアントが即座に発火） | 〜20 秒 |
| GET | `/v1/sessions/:id` | セッション状態の取得（復帰用） | 〜1 秒 |
| POST | `/v1/sessions/:id/answers` | 選択肢に回答し、次の質問を得る | 〜4 秒 |
| POST | `/v1/sessions/:id/hints` | ヒントレベルを 1 段階上げる | 〜3 秒 |
| POST | `/v1/sessions/:id/conclusion` | 原因を宣言し、到達判定を受ける | 〜5 秒 |
| POST | `/v1/sessions/:id/reveal` | 答えを見る（解放条件を満たす場合のみ） | 〜1 秒 |
| GET | `/v1/sessions/:id/report` | 振り返りレポートとスコア | 〜10 秒（初回生成時） |
| DELETE | `/v1/sessions/:id` | セッション削除（NFR-S5） | 〜2 秒 |
| GET | `/v1/me/sessions` | 履歴一覧 | 〜1 秒 |
| GET | `/v1/me/stats` | スコア推移・軸別の傾向 | 〜1 秒 |
| GET | `/v1/health` | ヘルスチェック | 〜0.1 秒 |

> **すべてのレイテンシは実行環境のタイムアウト設定内に収める必要がある。**
> タイムアウトは `enebular bulk-update cloud-config` の `timeout` で設定する。
> 実測前の暫定値は **30 秒**とし、M1 で上限を確認する（未決 Q-5）。

---

## 3. 詳細

### 3.1 `POST /v1/sessions` — セッション開始

**リクエスト**

```jsonc
{
  "errorText": "TypeError: Cannot read properties of undefined (reading 'map')\n    at ProductList (ProductList.tsx:24:18)",
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
    "id": "01J8XK4M2N0000000000000001",
    "status": "active",
    "currentStage": "observe",
    "stageIndex": 1,
    "totalStages": 5,
    "hintLevel": 0,
    "diagnosisStatus": "pending",     // ← クライアントはこれを見て diagnose を撃つ
    "startedAt": 1786000000000
  },
  "question": {
    "id": "01J8XK4M2N0000000000000001#1",
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

1. 入力をマスキング（FR-13）
2. ULID で `sessionId` を採番
3. **Lv1（観察）の質問を生成**。この段階の問いは「エラーメッセージをどう読むか」であり、
   **内部診断がなくても生成できる**
4. `sessions` に put（`diagnosisStatus: "pending"`）、`session_secrets` に正解を put
5. 返却。**診断は行わない**

> 診断（10〜20 秒）を待たないことが、NFR-P1（5 秒以内）を満たす鍵。
> Lambda はレスポンス返却後に処理を続けられないため、診断は次の `POST /diagnose` に分離する
> （[ADR-006](architecture.md#adr-006-sse-を廃止し診断の先行実行で体感速度を確保する)）。

---

### 3.2 `POST /v1/sessions/:id/diagnose` — 先行診断

**クライアントは最初の質問を描画した直後にこれを撃つ。** レスポンスを待つ必要はない
（`fetch(...).catch(() => {})` で投げっぱなしにしてよい）。

**リクエスト**: ボディ不要

**レスポンス** `200 OK`

```jsonc
{ "diagnosisStatus": "ready" }
```

`diagnosisStatus` が既に `pending` 以外なら、何もせず即座に `200` を返す（冪等）。
診断に失敗した場合は `"failed"` を返し、以降の質問は
`focusHints` なしの汎用モードで生成する（体験は劣化するが継続はできる）。

**ユーザーが Lv1 の選択肢を読んで考えている 20〜60 秒の間に、この処理が完了する。**

---

### 3.3 `POST /v1/sessions/:id/answers` — 回答

**リクエスト**

```jsonc
{
  "questionId": "01J8XK4M2N0000000000000001#1",
  "selectedOptionId": "b",
  "elapsedMs": 12400
}
```

**レスポンス（通常）** `200 OK`

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
    "id": "01J8XK4M2N0000000000000001#2",
    "stage": "localize",
    "seqInStage": 1,
    "body": "そのオブジェクトは、どこから渡ってきていますか？",
    "options": [ /* ... */ ]
  },
  "canDeclareConclusion": true,     // 「原因が分かった」ボタンの表示可否
  "canReveal": false                // 「答えを見る」の解放状態（FR-14）
}
```

**レスポンス（診断が未完）** `202 Accepted`

Lv2 以降の質問は `focusHints` を必要とするため、診断が終わっていない場合は待たせる。

```jsonc
{
  "result": { "isCorrect": true, "feedback": "その通りです。" },
  "nextQuestion": null,
  "pending": { "reason": "DIAGNOSIS_IN_PROGRESS", "retryAfterMs": 3000 }
}
```

クライアントは `retryAfterMs` 後に**同じリクエストを再送**する。
回答は既に記録済みのため、再送しても二重にはならない（§4 冪等性）。

**挙動**

- 不正解の場合、`nextQuestion` は**同一段階の別角度の質問**になる
- 同段階 3 問目も不正解なら `hintLevel` が自動で 1 上がり、`nextQuestion` に反映される
- 最終段階（`fix`）を通過した場合、`nextQuestion` は `null`、`session.status` は `completed`

---

### 3.4 `POST /v1/sessions/:id/hints` — ヒント開放

**リクエスト**: ボディ不要

**レスポンス** `200 OK`

```jsonc
{
  "hint": { "level": 1, "body": "エラーメッセージの後半に注目してみてください。" },
  "session": { "hintLevel": 1 }
}
```

`hintLevel` が既に 3 の場合は `409 HINT_EXHAUSTED`。

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
  "reportPath": "/v1/sessions/01J8XK4M2N0000000000000001/report"
}
```

`partial` / `not_reached` の場合は `session.status` は `active` のままで、
`nextQuestion` を伴って該当段階に戻る。**このとき原因は明かさない。**

---

### 3.6 `GET /v1/sessions/:id/report` — 振り返りレポート

セッションが `completed` または `revealed` のときのみ `200`。それ以外は `409`。

初回アクセス時に Reporter が生成して `reports` テーブルに put する。
2 回目以降はデータストアから読むだけ（LLM を呼ばない）。

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
`reports` テーブルにのみ存在し、進行中のセッション取得では読み出されない。

---

### 3.7 `GET /v1/me/sessions` — 履歴一覧

**クエリ**: `?limit=20&startKey=<sessionId>`

`query(sessions, "#ownerId = :ownerId", order: false, limit)` の 1 回で取得する。
ページングはデータストアの `startKey` をそのまま透過させる。

```jsonc
{
  "sessions": [
    {
      "id": "01J8XK4M2N0000000000000001",
      "summary": "TypeError: Cannot read properties of undefined",
      "language": "typescript",
      "status": "completed",
      "reachedStage": "fix",
      "totalScore": 81,
      "startedAt": 1786000000000
    }
  ],
  "nextStartKey": null
}
```

### 3.8 `GET /v1/me/stats` — スコア推移

`query(reports, "#ownerId = :ownerId", limit: 100)` の 1 回で集計する
（`reports` のメインキーを `ownerId` にしている理由）。

```jsonc
{
  "sessionCount": 12,
  "selfReachRate": 0.75,
  "latest":  { "observe": 100, "localize": 60, "hypothesize": 85, "verify": 85, "fix": 85, "total": 81 },
  "average": { "observe": 88,  "localize": 55, "hypothesize": 72, "verify": 61, "fix": 70, "total": 70 },
  "trend": [
    { "sessionId": "01J8W...", "total": 62 },
    { "sessionId": "01J8X...", "total": 70 }
  ],
  "weakestAxis": "localize"
}
```

`scored = false`（答えを見たセッション）は `average` / `trend` から除外する。

---

## 4. 冪等性

データストアにトランザクションがなく、Lambda には並行リクエストが届きうるため、
**状態を変える 3 エンドポイントは冪等に設計する**。

| エンドポイント | 冪等キー | 二重実行時の挙動 |
|---|---|---|
| `POST /answers` | `questionId` | 該当ターンに `answeredAt` があれば、記録済みの結果をそのまま返す |
| `POST /diagnose` | `sessionId` | `diagnosisStatus !== "pending"` なら何もせず `200` |
| `POST /conclusion` | `sessionId` + 本文ハッシュ | 直前と同一本文なら記録済みの判定を返す |

クライアント側は、レスポンスが返るまで送信ボタンを無効化する
（それでもネットワーク再送はありうるため、サーバ側の冪等性が最終防御）。

---

## 5. レート制限（NFR-O3）

| 対象 | 制限 |
|---|---|
| `POST /v1/sessions` | 10 回 / 時 / 匿名 ID |
| `POST /v1/sessions/:id/answers` | 120 回 / 時 / 匿名 ID |
| その他 | 600 回 / 時 / 匿名 ID |

超過時は `429` と `Retry-After` ヘッダを返す。

> **実装上の注意**: Lambda は状態を持てないため、カウンタはデータストアに置くことになるが、
> それ自体がアクセス枠（E4）を消費して本末転倒になる。
> v1 は**セッションアイテム内のカウンタで済む制限のみ**を実装し
> （`POST /answers` の回数はセッションの `turns.length` で判定できる）、
> IP ベースの制限は enebular 側の HTTP トリガー設定に委ねる方針とする（未決 Q-6）。

---

## 6. API 契約の管理

リクエスト / レスポンスの Zod スキーマは `packages/shared/src/schemas/` に置き、
`apps/function`（検証）と `apps/web`（型付きクライアント）の**両方が同じ定義を参照**する。

```
packages/shared/src/schemas/
├── session.ts      # CreateSessionRequest / SessionPublic
├── question.ts     # QuestionPublic（correctOptionId を持たない）
├── answer.ts       # SubmitAnswerRequest / AnswerResult / PendingResult
├── report.ts       # ReportPublic / Score
└── error.ts        # ApiError
```

`QuestionPublic` に `correctOptionId` を定義しないことが、
[NFR-S3](requirements.md#62-セキュリティ--プライバシー)（答えを API に出さない）の実装上の担保となる。
