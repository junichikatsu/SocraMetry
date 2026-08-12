import type {
  DiagnosisStatus,
  Gate,
  SessionMode,
  SessionStatus,
  Stage,
  Verdict,
} from './domain'

/**
 * API のレスポンスに載る公開型。
 *
 * **`QuestionPublic` に `correctOptionId` を定義しない**ことが
 * NFR-S3（答えを API に出さない）の実装上の担保になる（api-spec.md §7）。
 * 答えを持つ型は `RevealPublic` だけで、これを返すのは
 * `POST /reveal` と `GET /report` のみ。
 */

export type OptionPublic = {
  id: string
  label: string
}

export type QuestionPublic = {
  /** `<sessionId>#<seq>` 形式。回答の冪等キーになる（api-spec.md §4） */
  id: string
  stage: Stage
  seqInStage: number
  body: string
  options: OptionPublic[]
}

export type HintPublic = {
  level: number
  body: string
}

export type SessionPublic = {
  id: string
  mode: SessionMode
  status: SessionStatus
  gate: Gate
  hintLevel: number
  /** Gate B に入ってから設定される */
  currentStage: Stage | null
  /** 1 起算。Gate A では null */
  stageIndex: number | null
  totalStages: number
  diagnosisStatus: DiagnosisStatus
  /** 解決したゲート。未解決なら null */
  reachedGate: Gate | null
  startedAt: number
  /**
   * 時間経過による Gate A → B（FR-07 / #20）まで**あと何ミリ秒か**。
   * 発火条件を満たしていなければ null。
   *
   * **絶対時刻ではなく残り時間を渡す。** クライアントの時計はサーバとずれる。
   * 判定条件そのものはサーバ（`core` の `autoAdvanceAt`）にあり、
   * クライアントが持つのはタイマーだけ。Lambda が定期実行を持てないため、
   * タイマーの置き場所がクライアントしかないという事情だけの分担。
   */
  autoAdvanceInMs: number | null
}

/**
 * クライアントが「どのボタンを出してよいか」を判断するための状態。
 *
 * 遷移可否の判定を**サーバが持つ**ことが重要。クライアントに条件式を持たせると、
 * ゲート遷移規則（socratic-engine.md §7）が 2 箇所に分かれて必ずずれる。
 */
export type SessionActions = {
  canRequestHint: boolean
  canAdvanceToQuestions: boolean
  canDeclareConclusion: boolean
  canReveal: boolean
}

export type AnswerResultPublic = {
  isCorrect: boolean
  feedback: string
}

/** 診断待ちで次の設問を出せないときの待機情報（api-spec.md §3.5 / 202） */
export type PendingPublic = {
  reason: 'DIAGNOSIS_IN_PROGRESS'
  retryAfterMs: number
}

/** ★ 答えを含む唯一の公開型。Gate C 到達後にのみ返す */
export type RevealPublic = {
  rootCause: string
  evidence: string[]
  fixDirection: string
  prevention: string
}

export type RetrospectionPublic = {
  question: string
  options: OptionPublic[]
}

/**
 * 原因宣言の結果。
 *
 * `verdict` が `null` になるのは**判定を行わなかった場合**（socratic-engine.md §4.3 / Q-15）。
 * 「わかりません」や短すぎる入力を `not_reached` にすると設問へ戻されてしまうため、
 * 3 値判定そのものを回避する経路を型に持たせている。
 */
export type ConclusionResultPublic = {
  verdict: Verdict | null
  feedback: string
  /** 判定を行わなかった場合に true */
  skipped?: boolean
}

export type ScorePublic = ScoreAxes & {
  total: number
  gateFactor: number
  difficultyFactor: number
  /** 演習モードのみ算出（v0.1 は常に null） */
  timeIndex: number | null
  previousTotal: number | null
  /** 横比較に使ってよいか。実務モードは常に false（NFR-F2） */
  comparable: boolean
}

/**
 * スコアの算出根拠。**必須フィールド**（NFR-F1）。
 * 「なぜこの点数なのか」を説明できない数値を評価に使わせない、という要件の実装。
 */
export type ScoreExplanationPublic = {
  formula: string
  docUrl: string
  breakdown: Array<{
    axis: Stage
    base: number
    hintPenalty: number
    difficultyFactor: number
    /** 対象の軸だけで正規化した重み。対象外は 0 */
    weight: number
    /** 出題対象外なら null */
    result: number | null
    /** 出題されなかった段階の扱いを利用者に説明するための注記 */
    note?: string
  }>
}

export type StagePathPublic = {
  stage: Stage
  attempts: number
  hintLevel: number
  elapsedMs: number
}

export type ReportPublic = {
  sessionId: string
  mode: SessionMode
  reachedGate: Gate | null
  path: StagePathPublic[]
  stumblingPoint: string
  generalizedLesson: string
  nextTimeSteps: string[]
  /** 完了後にのみ返る唯一の答えフィールド（data-model.md §3.3） */
  revealedAnswer: string | null
  score: ScorePublic
  scoreExplanation: ScoreExplanationPublic
  createdAt: number
}

export type SessionSummaryPublic = {
  id: string
  summary: string
  language: string | null
  mode: SessionMode
  status: SessionStatus
  reachedGate: Gate | null
  totalScore: number | null
  startedAt: number
}

/**
 * 個人ダッシュボード（FR-24）。
 *
 * v0.1 は `member_stats`（v0.2 / ADR-011）を持たないため、
 * `reports` テーブルの 1 クエリ（data-model.md A4）から都度集計する。
 * 成長率（FR-26）と `timeIndexAvg` は v0.2 のため返さない。
 */
export type MeStatsPublic = {
  sessionCount: number
  totalElapsedMs: number
  gateDistribution: { A: number; B: number; C: number; unresolved: number }
  /** Gate A + B の割合。分母は完了セッションのみ（evaluation-model.md §2.2） */
  selfReachRate: number
  recentAxes: ScoreAxes | null
  correctRate: number | null
  weakestAxis: Stage | null
  trend: Array<{ sessionId: string; total: number; gate: Gate | null; at: number }>
}

/**
 * 5 軸のスコア。
 *
 * **`null` は「出題対象外」を表す。** `DEMO_MAX_STAGES` で段階数を絞ると、
 * 対象外の軸はそもそも出題されない。0 と区別できないと
 *「何もしていないのに 0 点」と読めてしまう（scope-v0.1.md 削る順序 #4）。
 */
export type ScoreAxes = {
  observe: number | null
  localize: number | null
  hypothesize: number | null
  verify: number | null
  fix: number | null
}

export type MePublic = {
  userId: string
  email: string
  displayName: string
}

/** エラーレスポンス（api-spec.md §1） */
export type ApiErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_COMPLETED'
  | 'HINT_EXHAUSTED'
  | 'GATE_NOT_UNLOCKED'
  | 'EMAIL_TAKEN'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_INVITE_CODE'
  | 'RATE_LIMITED'
  | 'TOKEN_BUDGET_EXCEEDED'
  | 'LLM_UNAVAILABLE'
  | 'DATASTORE_UNAVAILABLE'
  | 'INTERNAL_ERROR'

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode
    message: string
    detail: unknown
  }
}
