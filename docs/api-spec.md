# API 仕様

| 項目 | 内容 |
|---|---|
| ドキュメント版数 | v0.4 |
| 更新日 | 2026-08-11 |
| 主な変更 | **v0.1 の実装に合わせて追記。** §2.1a に簡易認証の 3 本、問答系に `GET /cost`、`/v1/health` の応答を明記 |
| ホスト | enebular クラウド実行環境の HTTP トリガー URL |

> ⚠️ **v0.1 の実装対象は §2.1（問答）と §2.2（個人）のみ。**
> §2.3（演習・問題集）と §2.4（組織）は **v0.2 以降**（F16 Won't）。
> 認証は簡易版（メール + パスワード + 招待コード）で、
> ロール・テナント・監査ログは v0.2。詳細は [scope-v0.1.md](scope-v0.1.md)。
>
> **v0.1 では同一オリジン配信のため CORS は不要**（[ADR-012](architecture.md#adr-012-フロントエンドを関数から同一オリジンで配信する)）。
> フロントは相対パス `/v1/...` で API を呼ぶ。

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

### 認証とテナント（FR-31 / NFR-S5）

BtoB 提供のため、**すべての API は認証必須**（`/v1/health` を除く）。
OIDC / OAuth の認可コードフローでログインし、セッション Cookie を発行する。

```
Set-Cookie: sm_session=<jwt>; HttpOnly; Secure; SameSite=None; Max-Age=86400; Path=/
```

> **v0.1 では `SameSite=Lax`。** フロントを関数から同一オリジンで配信するため、
> `None` にする必要がなく、CORS 設定も不要（[ADR-012](architecture.md#adr-012-フロントエンドを関数から同一オリジンで配信する)）。
>
> v0.2 でフロントを別ホスティングに分離する場合は `SameSite=None; Secure` が必須になり、
> CORS で `Access-Control-Allow-Credentials: true` と
> `Access-Control-Allow-Origin: <ALLOWED_ORIGIN>`（ワイルドカード不可）を返す必要がある。

**トークンから取り出す認証コンテキスト**

```jsonc
{ "tenantId": "org_ac31f2", "memberId": "usr_9d0e11", "role": "member", "teamId": "team_backend" }
```

| # | 鉄則 |
|---|---|
| 1 | **`tenantId` はトークンからのみ取得する。** パス・クエリ・ボディから受け取らない |
| 2 | データストアのメインキーは `ownerId = "<tenantId>:<memberId>"`。別組織はキーが一致せず**そもそも引けない**（[data-model.md §6](data-model.md#6-テナント分離の強制nfr-s5)） |
| 3 | `role` はトークンではなく `org_directory` から都度引く（ロール変更を即時反映するため） |

### ロールと閲覧範囲（NFR-S6）

| ロール | 自分 | 自チーム | 組織全体 | 問題集の編集 | 評価レポート出力 |
|---|---|---|---|---|---|
| `member` | ✅ | 集計値のみ | 集計値のみ | ✗ | ✗ |
| `lead` | ✅ | ✅ 個票 | 集計値のみ | ✅ | ✗ |
| `admin` | ✅ | ✅ | ✅ 個票 | ✅ | ✅ |

権限外のアクセスは `403 FORBIDDEN` を返し、**監査ログに記録**する（NFR-S9）。

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
| 401 | `UNAUTHENTICATED` | 未ログイン / トークン期限切れ |
| 403 | `FORBIDDEN` | ロールの権限外 / 他テナントへのアクセス |
| 404 | `SESSION_NOT_FOUND` | 存在しない / 他人のセッション |
| 409 | `SESSION_COMPLETED` | 完了済みセッションへの操作 |
| 409 | `HINT_EXHAUSTED` | ヒントレベルが既に 3 |
| 409 | `GATE_NOT_UNLOCKED` | 遷移条件を満たしていないゲートへの要求 |
| 429 | `RATE_LIMITED` | レート制限（NFR-O3） |
| 429 | `TOKEN_BUDGET_EXCEEDED` | セッションのトークン上限超過（NFR-C1） |
| 503 | `LLM_UNAVAILABLE` | OrcaRouter への接続失敗（フォールバックも失敗） |
| 503 | `DATASTORE_UNAVAILABLE` | enebular データストアへのアクセス失敗 |

`202 Accepted` は**エラーではなく待機**を意味する（→ §3.5）。

### ★ Gate C 到達前のレスポンスに絶対に含めないフィールド

| フィールド | 保存先 | 理由 |
|---|---|---|
| `rootCause` / `evidence` / `confidence` | `session_secrets` (`kind: "diagnosis"`) | 答えそのもの |
| `correctOptionId` | `session_secrets` (`kind: "answerkeys"`) | 正解が分かってしまう |
| `rationaleIfWrong` の全量 | 同上 | 選ばれた選択肢の分だけ回答後に返す |

`packages/shared` の公開型にこれらを**定義しない**ことで、型レベルで防ぐ。
さらにデータストア上も別テーブルに隔離されているため、
セッションアイテムをそのまま返しても漏れない（[ADR-005](architecture.md#adr-005-内部診断と正解を別テーブルに隔離する)）。

**開示は `POST /reveal` と `GET /report` のレスポンスでのみ行う。**
公開型は `QuestionPublic`（正解なし）と `RevealPublic`（答えあり）を別の型として定義し、
どのエンドポイントがどちらを返すかを型で固定する。

---

## 2. エンドポイント一覧

### 2.1 問答（3 ゲート）

| メソッド | パス | 説明 | ロール | レイテンシ |
|---|---|---|---|---|
| POST | `/v1/sessions` | セッション開始。**Gate A のヒントを返す。診断は待たない** | member | 〜5 秒 |
| POST | `/v1/sessions/:id/diagnose` | 先行診断の実行（クライアントが即座に発火） | member | 〜20 秒 |
| GET | `/v1/sessions/:id` | セッション状態の取得（復帰用） | member | 〜1 秒 |
| POST | `/v1/sessions/:id/hints` | **Gate A**: ヒントレベルを 1 段階上げる | member | 〜3 秒 |
| POST | `/v1/sessions/:id/advance` | **Gate A → B**: 設問に進む | member | 〜5 秒 |
| POST | `/v1/sessions/:id/answers` | **Gate B**: 選択肢に回答し、次の設問を得る | member | 〜4 秒 |
| POST | `/v1/sessions/:id/conclusion` | 原因を宣言し、到達判定を受ける | member | 〜5 秒 |
| POST | `/v1/sessions/:id/reveal` | **Gate C**: 解説を読む（遷移条件を満たす場合のみ） | member | 〜1 秒 |
| POST | `/v1/sessions/:id/retrospect` | Gate C 後の振り返り 1 問に回答する | member | 〜1 秒 |
| GET | `/v1/sessions/:id/report` | 振り返りレポートとスコア | member | 〜10 秒（初回） |
| GET | `/v1/sessions/:id/cost` | **1 セッションの実測コスト**（F11 / 下記） | member | 〜1 秒 |
| DELETE | `/v1/sessions/:id` | セッション削除（NFR-S7） | member | 〜2 秒 |

> **`GET /cost` は本書の初版に無かったエンドポイント。** 実測コスト表
> （[cost-model.md §5.4](cost-model.md#54-実測結果)）を埋めるには `ops_logs` を読む手段が要り、
> 無いと実行環境のログを人が読むしかない。デモ台本 #6「コストログを見せる」も
> 画面から出せない。`ops_logs` のメインキーは `sessionId` で `ownerId` を含まないため、
> **先に `sessions` を読んで所有者を確認してから**でなければ呼んではならない。

### 2.1a 認証（v0.1 の簡易実装）

本書の §1 は OIDC / OAuth を前提に書かれているが、**v0.1 は簡易認証**
（メール + パスワード + 招待コード / [scope-v0.1.md §4.2](scope-v0.1.md#42-認証を最小構成にする)）。
そのため以下の 3 本が実装されている。**認証不要で到達できるのはここと `/v1/health` だけ。**

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/v1/auth/signup` | 招待コード必須。成功で Cookie を発行し `201` |
| POST | `/v1/auth/login` | Cookie を発行 |
| POST | `/v1/auth/logout` | Cookie を破棄（JWT はステートレスなのでサーバ側に破棄する状態はない） |

```jsonc
// POST /v1/auth/signup
{ "email": "sato@example.com", "password": "8 文字以上", "displayName": "佐藤", "inviteCode": "..." }
// → { "me": { "userId": "usr_9d0e11", "email": "...", "displayName": "佐藤" } }
```

| HTTP | code | 意味 |
|---|---|---|
| 403 | `INVALID_INVITE_CODE` | 招待コードが違う |
| 409 | `EMAIL_TAKEN` | 登録済みのメールアドレス |
| 401 | `INVALID_CREDENTIALS` | メールまたはパスワードが違う（**どちらかは返さない**） |

> **Cookie の `Path` はトリガーのパス配下に絞る。** enebular は 1 ホストを複数
> インスタンスがパスで分け合うため、`Path=/` だと同じホストの**他の関数にも
> JWT が送信される**（`HttpOnly` は JS からの読み取りを防ぐだけで、送信は止められない）。
> トリガーのパスは設定として持たず（[ADR-009](architecture.md#adr-009-hono-を-lambda-ハンドラのルーターとして使う)）、
> リクエストのパスから導く。

### 2.2 個人（利用者向け）

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | `/v1/me` | 自分のプロフィール（v0.1 はロールを持たない） | member |
| GET | `/v1/me/sessions` | 自分の履歴一覧 | member |
| GET | `/v1/me/stats` | 自分のダッシュボード（到達ゲート分布・5 軸推移）※成長率は v0.2 | member |
| GET | `/v1/me/assignments` | 自分に割り当てられた演習一覧 ※**v0.2** | member |

### 2.3 演習・問題集（BtoB）

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | `/v1/problems` | 社内問題集の一覧（タグ・難易度で絞り込み） | lead |
| POST | `/v1/problems` | 問題を登録する | lead |
| PATCH | `/v1/problems/:id` | 問題を編集する（難易度・タグ・公開状態） | lead |
| POST | `/v1/problems/from-session/:sessionId` | **実務セッションを匿名化して問題集に登録**（FR-35） | lead |
| POST | `/v1/assignments` | 問題セットをメンバー / チームに割り当てる | lead |
| GET | `/v1/assignments` | 割り当ての進捗一覧 | lead |

### 2.4 組織（管理者向け）

| メソッド | パス | 説明 | ロール |
|---|---|---|---|
| GET | `/v1/org/dashboard` | 組織ダッシュボード（**事前集計を 1 クエリで読む**） | member（範囲はロール依存） |
| GET | `/v1/org/members` | メンバー一覧とロール | lead |
| POST | `/v1/org/members` | メンバーを招待する | admin |
| PATCH | `/v1/org/members/:id` | ロール / チーム / 有効状態を変更する | admin |
| GET | `/v1/org/ranking` | ランキング（**組織設定で有効な場合のみ**） | member |
| GET | `/v1/org/settings` | 組織設定 | admin |
| PATCH | `/v1/org/settings` | ランキング可否・保持期間などを変更する | admin |
| POST | `/v1/org/reports/evaluation` | **評価レポートを出力**（FR-27） | admin |
| GET | `/v1/health` | ヘルスチェック（認証不要 / 下記） | — |

**`GET /v1/health` の応答**

```jsonc
{
  "status": "ok",
  "version": "0.1.0",
  "commit": "d66a9ca...",        // デプロイしたコミットが動いているかの確認用
  "builtAt": "2026-08-11T01:02:11.458Z",
  "mockMode": false,             // 本番で true のまま公開していないかの目視確認（deployment.md §6 #10）
  "configOk": true,              // 環境変数の設定漏れ。★キー名は返さない（認証不要のため）
  "configMissing": 0,
  "limits": {                    // 実際に効いている設定値。環境変数と既定値のどちらが効いているか外から分かる
    "stages": 5,                 //   Gate B の段階数（DEMO_MAX_STAGES）
    "diagnoser": 1600,           //   役割別の max_tokens
    "hinter": 300, "questioner": 900, "judge": 500, "revealer": 1000, "reporter": 1000,
    "usdJpyRate": 165,           //   円換算レート（USD_JPY_RATE）
    "opsLog": true               //   ops_logs への記録が有効か（OPS_LOG_ENABLED）
  }
}
```

> **`limits` を返すのは、設定の食い違いを LLM を呼ばずに確認するため。**
> 環境変数を消したのに古い値が効いたままの状態を切り分けられず、
> 実際に LLM 呼び出しを 2 回無駄にした。値は上限であって秘匿情報ではない。
>
> **`usdJpyRate` と `opsLog` はコスト計測のために後から追加した。**
> 前者は実行環境 165 / コード既定 150 でずれ、設計書の円が
> 150 換算と 165 換算で混在した。後者は無効だと**課金されるのに記録が残らず**、
> `GET /cost` が MOCK と同じ「呼び出し 0 件」を返して見分けがつかない。
> **いずれも「設定が効いているか外から見えない」ことで実害が出た項目である。**

> **すべてのレイテンシは実行環境のタイムアウト設定内に収める必要がある。**
> タイムアウトは `enebular bulk-update cloud-config` の `timeout` で設定する。
> 実測前の暫定値は **30 秒**とし、**Day 1 午前**に上限を確認する（未決 Q-5）。

---

## 3. 詳細

### 3.1 `POST /v1/sessions` — セッション開始（Gate A）

**リクエスト（実務モード）**

```jsonc
{
  "mode": "live",
  "errorText": "TypeError: Cannot read properties of undefined (reading 'map')\n    at ProductList (ProductList.tsx:24:18)",
  "codeSnippet": "const ProductList = ({ items }) => items.map(...)",   // 任意
  "language": "typescript",                                             // 任意（未指定なら推定）
  "framework": "nextjs",                                                // 任意
  "recentChange": "APIのレスポンス形式を変えた"                            // 任意
}
```

**リクエスト（演習モード）**

```jsonc
{ "mode": "assessment", "problemId": "01J8A7R2K50000000000000001", "assignmentId": "01J8XM..." }
```

演習モードでは、エラー本文も内部診断も `question_bank` から取得する。
**Diagnoser を呼ばない**ため速く、かつ全員が同一の診断で出題される（NFR-F2）。

| フィールド | 型 | 必須 | 制約 |
|---|---|---|---|
| `mode` | string | ✅ | `live` \| `assessment` |
| `errorText` | string | live で ✅ | 1〜20,000 文字 |
| `codeSnippet` | string | | 〜10,000 文字 |
| `language` / `framework` | string | | 事前定義リスト |
| `recentChange` | string | | 〜1,000 文字 |
| `problemId` | string | assessment で ✅ | 自組織の公開済み問題のみ |

**レスポンス** `201 Created`

```jsonc
{
  "session": {
    "id": "01J8XK4M2N0000000000000001",
    "mode": "live",
    "status": "active",
    "gate": "A",
    "hintLevel": 1,
    "diagnosisStatus": "pending",     // ← クライアントはこれを見て diagnose を撃つ
    "startedAt": 1786000000000
  },
  "hint": {
    "level": 1,
    "body": "エラーメッセージの後半に注目してみてください。"
  },
  "actions": {
    "canRequestHint": true,           // Lv2 へ
    "canAdvanceToQuestions": true,    // Gate B へ（利用者の意思で即進める）
    "canDeclareConclusion": true,     // 「解決した」— Gate A での自力解決
    "canReveal": false                // Gate C はまだ塞がっている
  }
}
```

> **設問は返さない。** Gate A は着眼点のヒントのみ。
> ここで解決できたセッションが最上位評価（`gate_factor` 1.00）になる。

**処理フロー**

1. 入力をマスキング（FR-11）
2. ULID で `sessionId` を採番
3. **Gate A の Lv1 ヒントを生成**。
   - 実務モード: エラーテキストのみから生成できる汎用ヒント（診断不要）
   - 演習モード: `question_bank.diagnosis.focusHints` から生成（LLM 呼び出しゼロ）
4. `sessions` に put（`gate: "A"`, `diagnosisStatus: "pending"`）
5. 返却。**診断は行わない**

> 診断（10〜20 秒）を待たないことが、NFR-P1（5 秒以内）を満たす鍵。
> Lambda はレスポンス返却後に処理を続けられないため、診断は次の `POST /diagnose` に分離する
> （[ADR-006](architecture.md#adr-006-sse-を廃止し診断の先行実行で体感速度を確保する)）。
> 演習モードでは診断が事前に存在するため、`diagnosisStatus` は最初から `"ready"` になる。

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

### 3.3 `POST /v1/sessions/:id/hints` — ヒント開放（Gate A / B 共通）

**リクエスト**: ボディ不要

**レスポンス** `200 OK`

```jsonc
{
  "hint": { "level": 2, "body": "`reading` の直後の単語が、失敗した操作を表しています。" },
  "session": { "gate": "A", "hintLevel": 2 },
  "actions": { "canRequestHint": true, "canAdvanceToQuestions": true, "canDeclareConclusion": true, "canReveal": false }
}
```

`hintLevel` が既に 3 の場合は `409 HINT_EXHAUSTED`。

---

### 3.4 `POST /v1/sessions/:id/advance` — Gate A → B（設問に進む）

利用者が「設問に進む」を押したとき、または一定時間経過による自動遷移で呼ぶ。

**レスポンス** `200 OK`

```jsonc
{
  "session": { "gate": "B", "currentStage": "observe", "stageIndex": 1, "totalStages": 5 },
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

**注意**: この遷移は**不可逆**。以降 Gate A の評価（`gate_factor` 1.00）は得られない。
クライアントは実行前に確認ダイアログを出す。

診断が未完（`diagnosisStatus !== "ready"`）でも、Lv1 の設問は診断なしで生成できるため
このエンドポイントは成功する。診断が必要になるのは Lv2 以降。

---

### 3.5 `POST /v1/sessions/:id/answers` — 回答（Gate B）

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

### 3.6 `POST /v1/sessions/:id/conclusion` — 原因宣言

**Gate A・B のどちらからでも呼べる。** Gate A で呼んで `reached` なら自力解決（★★★）。

**リクエスト**

```jsonc
{ "body": "APIのレスポンスが返る前の初回レンダリングで items が undefined になっていた" }
```

**レスポンス** `200 OK`

```jsonc
{
  "verdict": "reached",            // reached | partial | not_reached
  "feedback": "その通りです。データが到着する前の状態を見落としていた、という構造ですね。",
  "session": { "status": "completed", "reachedGate": "A" },
  "reportPath": "/v1/sessions/01J8XK4M2N0000000000000001/report"
}
```

`partial` / `not_reached` の場合は `session.status` は `active` のままで、
Gate A なら次のヒント、Gate B なら該当段階の設問に戻る。**このとき原因は明かさない。**

---

### 3.7 `POST /v1/sessions/:id/reveal` — Gate C（解説を読む）

遷移条件（[socratic-engine.md §7](socratic-engine.md#7-ゲート遷移fr-07)）を満たさない場合は
`409 GATE_NOT_UNLOCKED`。

**レスポンス** `200 OK`

```jsonc
{
  "session": { "gate": "C", "status": "active", "reachedGate": "C" },
  "reveal": {
    "rootCause": "props の items が API 応答前の初回レンダリングで undefined だったためです。",
    "evidence": [
      "スタックトレース 3 行目が ProductList.tsx:24 を指しています",
      "items は親から props で渡され、フェッチ完了前は未定義のままです"
    ],
    "fixDirection": "データ到着前の状態を明示的に扱います。初期値を与えるか、未到着時の表示を分けます。",
    "prevention": "非同期データを受け取る props には、未到着の状態を型で表現しておくと同種のバグを防げます。"
  },
  "retrospection": {
    "question": "今回、どの段階で見落としがありましたか？",
    "options": [
      { "id": "a", "label": "エラーメッセージの読み取り" },
      { "id": "b", "label": "変更点の洗い出し" },
      { "id": "c", "label": "原因の推論" },
      { "id": "d", "label": "仮説の確かめ方" }
    ]
  }
}
```

> **UI 文言は「答えを見る」ではなく「解説を読む」。**
> 開示は敗北ではなく正しい着地点の一つとして扱う
> （[evaluation-model.md §4.1](evaluation-model.md#41-想定される歪みと対策)）。

`retrospection` への回答は `POST /v1/sessions/:id/retrospect` で送る。
**スコアには使わない**（自己申告のため）が、振り返りレポートの材料になる。
回答するとセッションが `completed` になる。

---

### 3.8 `GET /v1/sessions/:id/report` — 振り返りレポート

セッションが `completed` のときのみ `200`。それ以外は `409`。

初回アクセス時に Reporter が生成して `reports` テーブルに put し、
**同時に `member_stats` を更新する**（[data-model.md §3.5](data-model.md#35-member_stats--事前計算した集計-d4-の要)）。
2 回目以降はデータストアから読むだけ（LLM を呼ばない）。

```jsonc
{
  "mode": "live",
  "reachedGate": "B",
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
    "gateFactor": 0.90,
    "difficultyFactor": 1.0,
    "timeIndex": null,
    "previousTotal": 74,
    "comparable": false
  },
  "scoreExplanation": {
    "formula": "Σ(stage_score × weight) × gate_factor",
    "docUrl": "/docs/evaluation-model#3-スコアの算出",
    "breakdown": [
      { "axis": "localize", "base": 70, "hintPenalty": 0.85, "difficultyFactor": 1.0, "result": 60 }
    ]
  }
}
```

`revealedAnswer` は**完了後にのみ**返る唯一の答えフィールド。
`reports` テーブルにのみ存在し、進行中のセッション取得では読み出されない。

> **`scoreExplanation` は必須フィールド。** スコアが評価に使われる以上、
> 被評価者が算出根拠を確認できなければならない（NFR-F1）。
> 「なぜこの点数なのか」を説明できない数値を人事評価に使わせない、という要件の実装。

---

### 3.9 `GET /v1/me/sessions` — 履歴一覧

**クエリ**: `?limit=20&startKey=<sessionId>&mode=live`

`query(sessions, "#ownerId = :ownerId", order: false, limit)` の 1 回で取得する。
ページングはデータストアの `startKey` をそのまま透過させる。

```jsonc
{
  "sessions": [
    {
      "id": "01J8XK4M2N0000000000000001",
      "summary": "TypeError: Cannot read properties of undefined",
      "language": "typescript",
      "mode": "live",
      "status": "completed",
      "reachedGate": "B",
      "totalScore": 81,
      "startedAt": 1786000000000
    }
  ],
  "nextStartKey": null
}
```

### 3.10 `GET /v1/me/stats` — 個人ダッシュボード（FR-24）

`getItem(member_stats, { tenantId, memberId })` の **1 アクセス**で返す。

```jsonc
{
  "sessionCount": 38,
  "totalElapsedMs": 33120000,
  "gateDistribution": { "A": 0.24, "B": 0.50, "C": 0.26 },
  "selfReachRate": 0.74,               // Gate A + B の割合
  "recentAxes":   { "observe": 88, "localize": 71, "hypothesize": 76, "verify": 58, "fix": 72 },
  "previousAxes": { "observe": 80, "localize": 50, "hypothesize": 68, "verify": 56, "fix": 64 },
  "growthRate": 12,
  "orgAverage":   { "observe": 82, "localize": 65, "hypothesize": 70, "verify": 61, "fix": 69 },
  "correctRate": 0.72,
  "timeIndexAvg": 1.08,
  "weakestAxis": "verify",
  "trend": [ { "sessionId": "01J8W...", "total": 62, "gate": "B", "at": 1785000000000 } ]
}
```

`orgAverage` は組織平均のみを返す（**他メンバーの個票は含めない**）。

---

### 3.11 `GET /v1/org/dashboard` — 組織ダッシュボード（FR-38）

`query(member_stats, "#tenantId = :tenantId")` の **1 アクセス**で集計する。
これが [D4](data-model.md#4-つの設計原則)（事前計算）の目的。

**クエリ**: `?teamId=team_backend&period=6m`

```jsonc
{
  "scope": "org",                      // org | team（ロールに応じてサーバが決定）
  "memberCount": 15,
  "summary": {
    "totalSessions": 412,
    "totalElapsedMs": 356000000,
    "selfReachRate": 0.61,
    "gateDistribution": { "A": 0.18, "B": 0.43, "C": 0.39 }
  },
  "orgAxes": { "observe": 82, "localize": 65, "hypothesize": 70, "verify": 61, "fix": 69 },
  "weakestAxis": "verify",
  "insight": "検証の軸が組織全体で低い傾向です。仮説を確かめずに修正に進む場面が多い可能性があります。",

  // lead / admin のみ。member には含めない（NFR-S6）
  "members": [
    {
      "memberId": "usr_9d0e11", "displayName": "佐藤", "teamId": "team_backend",
      "sessionCount": 38, "selfReachRate": 0.74, "growthRate": 12,
      "axes": { "observe": 88, "localize": 71, "hypothesize": 76, "verify": 58, "fix": 72 },
      "lastSessionAt": 1786500000000
    }
  ]
}
```

> **初期表示は `insight`（組織の弱点）。** 個人一覧はその下に置く。
> 何を最初に見せるかがツールの使われ方を決めるため
> （[evaluation-model.md §5.2](evaluation-model.md#52-弱点の集約が最も価値が高い)）。

---

### 3.12 `GET /v1/org/ranking` — ランキング（FR-39）

**組織設定 `rankingEnabled` が `false`（既定）なら `404`。**

```jsonc
{
  "enabled": true,
  "scope": "team",
  "period": { "from": 1785000000000, "to": 1787000000000 },
  "problemId": "01J8A7R2K50000000000000001",
  "entries": [
    { "rank": 1, "displayName": "田中", "total": 94, "reachedGate": "A", "timeIndex": 1.8 },
    { "rank": 2, "displayName": "佐藤", "total": 88, "reachedGate": "A", "timeIndex": 1.2 }
  ],
  "myRank": 5,
  "totalParticipants": 12
}
```

| 制約 | 内容 |
|---|---|
| 対象 | **演習モード（`comparable: true`）のみ**。実務モードは対象外（NFR-F2） |
| 表示 | 上位のみ。下位は表示しない。自分の順位は `myRank` で個別に返す |
| 参加 | `rankingOptIn` が有効なら、参加表明したメンバーのみ |

---

### 3.13 `POST /v1/assignments` — 演習の割り当て（FR-36）

**ロール**: `lead` 以上

```jsonc
{
  "title": "新人研修 第1回 — エラーの読み方",
  "problemIds": ["01J8A...", "01J8B...", "01J8C..."],
  "targets": { "memberIds": [], "teamIds": ["team_newgrad"] },
  "dueAt": 1786600000000
}
```

**レスポンス** `201 Created`

```jsonc
{ "assignmentId": "01J8XM5P3Q0000000000000001", "assignedCount": 10 }
```

> 対象メンバーの人数分アイテムを作るため、10 名なら 10 アクセスを消費する。
> 大人数への一括割り当ては**バッチとして分割**する（100 名を超える場合）。

---

### 3.14 `POST /v1/problems/from-session/:sessionId` — 実務→問題集（FR-35）

完了した実務セッションを匿名化して問題集に登録する。

**リクエスト**

```jsonc
{
  "title": "非同期データ到着前のレンダリング",
  "difficulty": "medium",
  "category": "async",
  "targetLevel": "junior",
  "tags": ["react", "undefined", "非同期"],
  "anonymizedErrorText": "...",       // 自動マスキング結果を人が確認・修正したもの
  "anonymizedCodeSnippet": "..."
}
```

**レスポンス** `201 Created`

```jsonc
{ "problemId": "01J8A7R2K50000000000000001", "status": "draft" }
```

> **登録は必ず `draft` から始まる。** 自動匿名化の精度が未検証のため、
> `published` にするには人の確認を経る必要がある（未決 Q-13 / NFR-S2）。
> 社内の実エラーには顧客名・内部パス・識別子が含まれうる。

---

### 3.15 `POST /v1/org/reports/evaluation` — 評価レポート出力（FR-27）

**ロール**: `admin` のみ。**閲覧は監査ログに記録する**（NFR-S9）。

```jsonc
{
  "memberIds": ["usr_9d0e11"],
  "period": { "from": 1775000000000, "to": 1790000000000 },
  "format": "json"                    // json | csv（PDF は v2）
}
```

**レスポンス** `200 OK` — 構造は [evaluation-model.md §7.1](evaluation-model.md#71-出力内容) に準拠。

```jsonc
{
  "reports": [
    {
      "memberId": "usr_9d0e11",
      "displayName": "佐藤",
      "growth": { "before": 62, "after": 74, "delta": 12, "mostImproved": "localize", "stagnant": "verify" },
      "currentAxes": { "observe": 88, "localize": 71, "hypothesize": 76, "verify": 58, "fix": 72 },
      "orgAverage":  { "observe": 82, "localize": 65, "hypothesize": 70, "verify": 61, "fix": 69 },
      "gateDistribution": { "A": 0.24, "B": 0.51, "C": 0.25 },
      "previousGateDistribution": { "A": 0.12, "B": 0.44, "C": 0.44 },
      "volume": { "sessions": 38, "elapsedMs": 33120000, "assignmentCompletionRate": 0.92 },
      "developmentSuggestion": "検証力が相対的に低い。仮説を立てた後、確かめずに修正に進む傾向がある。",
      "basis": { "formulaDocUrl": "/docs/evaluation-model", "sessionIds": ["01J8W...", "..."] }
    }
  ]
}
```

**このレスポンスは総合点フィールドを持たない。**
`growth` を先頭に置き、5 軸内訳と組織平均を必ず併記する（NFR-F5）。
単一の点数だけで人を並べられる形にしないことが、この API の設計意図。

---

## 4. 冪等性

データストアにトランザクションがなく、Lambda には並行リクエストが届きうるため、
**状態を変えるエンドポイントは冪等に設計する**。

| エンドポイント | 冪等キー | 二重実行時の挙動 |
|---|---|---|
| `POST /answers` | `questionId` | 該当ターンに `answeredAt` があれば、記録済みの結果をそのまま返す |
| `POST /diagnose` | `sessionId` | `diagnosisStatus !== "pending"` なら何もせず `200` |
| `POST /advance` | `sessionId` | 既に `gate === "B"` なら現在の設問を返す |
| `POST /reveal` | `sessionId` | 既に `gate === "C"` なら同じ開示内容を返す |
| `POST /conclusion` | `sessionId` + 本文ハッシュ | 直前と同一本文なら記録済みの判定を返す |
| `GET /report`（初回生成） | `sessionId` | `reports` に既にあれば生成せず返す。`member_stats` の二重加算を防ぐ |

クライアント側は、レスポンスが返るまで送信ボタンを無効化する
（それでもネットワーク再送はありうるため、サーバ側の冪等性が最終防御）。

> **`GET /report` の冪等性が特に重要。** ここで `member_stats` を更新するため、
> 二重実行するとセッション数とスコアが二重に加算され、**評価データが壊れる**。
> `reports` アイテムの存在を先に確認してから集計を更新する。

---

## 5. レート制限（NFR-O3）

| 対象 | 制限 |
|---|---|
| `POST /v1/sessions` | 10 回 / 時 / メンバー |
| `POST /v1/sessions/:id/answers` | 120 回 / 時 / メンバー |
| `POST /v1/assignments` | 20 回 / 時 / 組織 |
| その他 | 600 回 / 時 / メンバー |

超過時は `429` と `Retry-After` ヘッダを返す。

> **実装上の注意**: Lambda は状態を持てないため、カウンタはデータストアに置くことになるが、
> それ自体がアクセス枠（E4）を消費して本末転倒になる。
> v1 は**既存アイテム内のカウンタで済む制限のみ**を実装する
> （`POST /answers` の回数はセッションの `turns.length`、
> セッション作成数は `member_stats` の当日カウンタで判定できる）。
> 認証必須になったことで、匿名の大量アクセスという脅威自体が小さくなった。

---

## 6. 監査ログ（NFR-S9）

評価データの閲覧は記録する。**「誰が誰の評価を見たか」が追えることが、
P6（評価は人を裁く道具にしない）の担保になる。**

| 記録対象 | 内容 |
|---|---|
| `GET /v1/org/dashboard`（個票を含む場合） | 閲覧者 / 対象範囲 / 時刻 |
| `POST /v1/org/reports/evaluation` | 出力者 / 対象メンバー / 期間 / 時刻 |
| `PATCH /v1/org/members/:id`（ロール変更） | 実行者 / 変更内容 / 時刻 |
| `403 FORBIDDEN` を返したアクセス | 試行者 / 対象 / 時刻 |

出力先は実行環境の標準ログ（構造化 JSON）。
組織管理者は自組織分の監査ログを閲覧できる（v2 で UI を提供）。

---

## 7. API 契約の管理

リクエスト / レスポンスの Zod スキーマは `packages/shared/src/schemas/` に置き、
`apps/function`（検証）と `apps/web`（型付きクライアント）の**両方が同じ定義を参照**する。

```
packages/shared/src/schemas/
├── auth.ts         # AuthContext / Role
├── session.ts      # CreateSessionRequest / SessionPublic / Gate
├── question.ts     # QuestionPublic（correctOptionId を持たない）
├── answer.ts       # SubmitAnswerRequest / AnswerResult / PendingResult
├── reveal.ts       # RevealPublic（★ここにだけ答えがある）
├── report.ts       # ReportPublic / Score / ScoreExplanation
├── org.ts          # OrgSettings / Member / DashboardResponse
├── problem.ts      # Problem / Assignment
└── error.ts        # ApiError
```

### 型で守る 2 つの境界

| 境界 | 実装 |
|---|---|
| **答えの境界** | `QuestionPublic` に `correctOptionId` を定義しない。答えを持つのは `RevealPublic` だけで、これを返すのは `POST /reveal` と `GET /report` のみ |
| **テナントの境界** | `ownerId` / `tenantId` はブランド型にし、認証コンテキストからのみ生成する（[data-model.md §6](data-model.md#6-テナント分離の強制nfr-s5)） |

どちらも「気をつける」で守るのではなく、**間違った型が渡せない形**にしておく。

`QuestionPublic` に `correctOptionId` を定義しないことが、
[NFR-S3](requirements.md#62-セキュリティ--プライバシー)（答えを API に出さない）の実装上の担保となる。
