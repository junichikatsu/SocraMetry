import type {
  DiagnosisStatus,
  Difficulty,
  Gate,
  LlmRole,
  ScorePublic,
  ScoreExplanationPublic,
  SessionMode,
  SessionStatus,
  Stage,
  StagePathPublic,
  Verdict,
} from '@socrametry/shared'
import type { OwnerId } from './owner'

/**
 * データストアのアイテム定義（data-model.md §3）。
 *
 * **`@socrametry/shared` ではなくここに置く型がある。**
 * `rootCause` / `correctOptionId` は公開型に定義してはならないため
 * （ADR-005 / api-spec.md §1 ★）、内部型としてこのパッケージにのみ存在する。
 */

// ── users（data-model.md §3.9）─────────────────────────────────────────────

export type UserItem = {
  /** メインキー。メールアドレスがそのままキーになる（二次インデックス不要） */
  email: string
  /** サブキー。値は "account" 固定。将来 API トークン等を増やせる形にしてある */
  kind: 'account'
  /** `ownerId` の実体。メール変更でキーが変わらないよう別に持つ */
  userId: string
  displayName: string
  passwordHash: string
  passwordSalt: string
  status: 'active' | 'suspended'
  createdAt: number
  lastLoginAt: number | null
}

// ── sessions（data-model.md §3.1）──────────────────────────────────────────

/**
 * 1 ターン。**正解を持たない**ことが最重要
 * （`correctOptionId` は `session_secrets` にしかない）。
 */
export type TurnItem = {
  seq: number
  kind: 'question' | 'conclusion'
  stage: Stage
  seqInStage: number
  body: string
  options: Array<{ id: string; label: string }>
  hintLevelAtCreation: number
  leakGuardRetries: number
  askedAt: number

  // 回答後に同じ要素へ追記する（D1: 1 セッション = 1 アイテム）
  selectedOptionId?: string
  isCorrect?: boolean
  feedback?: string
  elapsedMs?: number
  answeredAt?: number
}

export type HintRecord = {
  gate: Gate
  level: number
  body: string
  /** 同段階 3 問不正解による自動開放かどうか */
  auto: boolean
  at: number
}

export type ConclusionRecord = {
  /** 冪等判定に使う本文のハッシュ（api-spec.md §4） */
  bodyHash: string
  /**
   * 利用者が書いた本文（マスキング済み）。**中断からの復旧に要る。**
   * ハッシュだけだと、再開したときに自分が何を書いたか復元できない。
   * `errorText` と同じくマスキング後を保存するので、扱うデータの種類は増えない。
   */
  body: string
  verdict: Verdict | null
  feedback: string
  at: number
}

export type SessionItem = {
  // ── キー ──
  ownerId: OwnerId
  sessionId: string

  // ── モードと出自 ──
  mode: SessionMode
  problemId: string | null
  assignmentId: string | null
  difficulty: Difficulty

  // ── 入力（すべてマスキング済み）──
  errorText: string
  codeSnippet: string | null
  language: string | null
  framework: string | null
  recentChange: string | null

  // ── 進行状態 ──
  status: SessionStatus
  gate: Gate
  reachedGate: Gate | null
  currentStage: Stage | null
  hintLevel: number
  diagnosisStatus: DiagnosisStatus
  totalStages: number
  /** 同一段階で 3 回不正解になった段階。Gate C の解放条件に使う */
  stuckStages: Stage[]
  /** 通過した段階と、その試行回数・ヒントレベル（スコアの素データ / FR-22） */
  stageResults: Array<{
    stage: Stage
    attempts: number
    solved: boolean
    hintLevel: number
    elapsedMs: number
  }>
  tokenUsed: number
  startedAt: number
  gateEnteredAt: { A: number; B: number | null; C: number | null }
  completedAt: number | null

  /**
   * 最後に操作した時刻。**中断の検出だけに使う。**
   * 表示にも評価にも出さない（`startedAt` と違って利用者の目に触れない）。
   */
  lastSeenAt: number
  /**
   * 中断していた時間の合計。ゲートの時間条件から差し引く。
   *
   * **`startedAt` を書き換えない**のは、それが履歴の並びと表示に使われているため。
   * 「いつ始めたか」は事実として動かさず、「どれだけ向き合っていたか」を別に持つ。
   *
   * 在席の判定は**書き込みを伴う操作があったか**で行う。心拍を持たないので、
   * 画面を開いたまま何もしていない時間は中断と区別できない。
   * 時間条件はどちらも「詰まった人を助ける安全弁」であり
   * （socratic-engine.md §7 / P2）、評価のための計測ではないため、
   * この粒度で足りると判断している。
   */
  awayMs: number

  turns: TurnItem[]
  hints: HintRecord[]
  conclusions: ConclusionRecord[]
  /** Gate C 後の振り返り（スコアには使わない / socratic-engine.md §8） */
  retrospection: { selectedOptionId: string | null; note: string | null; at: number } | null
}

// ── session_secrets（data-model.md §3.2）★非公開 ──────────────────────────

/** Questioner に渡してよい唯一の情報（socratic-engine.md §2） */
export type FocusHint = { stage: Stage; lookAt: string }

/**
 * 内部診断。**このアイテムは公開 API のレスポンスに一切含めない。**
 * 開示（Gate C）で使うのは `secret-repo` を経由した明示的な読み出しのみ。
 */
export type DiagnosisSecret = {
  sessionId: string
  kind: 'diagnosis'
  /** ★答えそのもの */
  rootCause: string
  confidence: number
  evidence: string[]
  /** ✅ Questioner に渡す */
  focusHints: FocusHint[]
  /** ✅ 誤答選択肢の素材 */
  distractorThemes: string[]
  difficulty: Difficulty
  /** Gate A のヒント Lv1〜3。診断から一括生成し、以降 LLM を呼ばない */
  hints: string[]
  modelUsed: string
  createdAt: number
}

export type AnswerKey = {
  correctOptionId: string
  rationaleIfCorrect: string
  /** 選ばれた選択肢の分だけ回答後に返す（全量は返さない / api-spec.md §1 ★） */
  rationaleIfWrong: Record<string, string>
}

/** 全ターンの正解を 1 アイテムにまとめる（D1: アクセス回数削減） */
export type AnswerKeysSecret = {
  sessionId: string
  kind: 'answerkeys'
  keys: Record<string, AnswerKey>
  updatedAt: number
}

/** Gate C の開示文。生成済みのものを再利用する（冪等 / api-spec.md §4） */
export type RevealSecret = {
  sessionId: string
  kind: 'reveal'
  rootCause: string
  evidence: string[]
  fixDirection: string
  prevention: string
  createdAt: number
}

export type SecretKind = 'diagnosis' | 'answerkeys' | 'reveal'

// ── reports（data-model.md §3.3）───────────────────────────────────────────

export type ReportItem = {
  ownerId: OwnerId
  sessionId: string

  summary: string
  language: string | null
  status: SessionStatus
  mode: SessionMode
  problemId: string | null
  reachedGate: Gate | null
  reachedStage: Stage | null
  difficulty: Difficulty

  path: StagePathPublic[]
  stumblingPoint: string
  generalizedLesson: string
  nextTimeSteps: string[]
  /** 完了後にのみ返す唯一の答えフィールド */
  revealedAnswer: string | null

  score: ScorePublic
  scoreExplanation: ScoreExplanationPublic
  /** 横比較に使ってよいか。**運用ルールではなくデータ構造で守る**（NFR-F2） */
  comparable: boolean
  /** Gate B の設問正答率。個人ダッシュボードの素データ */
  correctRate: number | null
  totalElapsedMs: number
  createdAt: number
}

// ── ops_logs（data-model.md §3.8）──────────────────────────────────────────

export type OpsLogItem = {
  sessionId: string
  /** サブキー。**数値**（epoch ms）。文字列にすると時系列クエリが辞書順になり壊れる */
  ts: number
  role: LlmRole
  model: string
  tier: string
  promptTokens: number
  completionTokens: number
  latencyMs: number
  estimatedCostUsd: number | null
  estimatedCostJpy: number | null
  orcaHeaders: Record<string, string>
  leakGuardHit: boolean
  error: string | null
}
