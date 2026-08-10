import { createHash } from 'node:crypto'
import {
  canAdvanceToQuestions,
  canRequestHint,
  computeActions,
  indexOfStage,
  isStageExhausted,
  maskText,
  nextHintLevel,
  nextStageAfter,
  parseMaskWords,
  precheckConclusion,
  raiseHintLevel,
  resolveTotalStages,
  revealGateReason,
  stageAt,
  ulid,
} from '@socrametry/core'
import {
  opsRepo,
  ownerIdOf,
  reportRepo,
  secretRepo,
  sessionRepo,
  type AnswerKey,
  type DiagnosisSecret,
  type OwnerId,
  type SessionItem,
  type TurnItem,
} from '@socrametry/datastore'
import {
  diagnose,
  FALLBACK_JUDGE,
  FALLBACK_REVEAL,
  fallbackHint,
  generateReveal,
  judgeConclusion,
  LlmError,
  RETROSPECTION_QUESTION,
  type LlmCallMeta,
} from '@socrametry/llm'
import type {
  AuthContext,
  ConclusionRequest,
  ConclusionResultPublic,
  CreateSessionRequest,
  Gate,
  HintPublic,
  PendingPublic,
  QuestionPublic,
  RetrospectRequest,
  RevealPublic,
  SessionActions,
  SessionPublic,
  Stage,
} from '@socrametry/shared'
import {
  demoMaxStages,
  gateTimeouts,
  maskWordsRaw,
  opsLogEnabled,
  sessionTokenBudget,
} from '../config'
import { recordLlmCalls, totalTokens } from '../middleware/cost-log'
import { errors } from '../middleware/error-handler'
import { assertSessionRateLimit } from '../middleware/rate-limit'
import { generateGuardedHint, generateGuardedQuestion } from './guarded-llm'
import {
  findTurn,
  gateStateOf,
  parseQuestionId,
  pendingQuestion,
  questionIdOf,
  toQuestionPublic,
  toSessionPublic,
} from './presenters'

/**
 * 3 ゲートの進行を束ねる層（socratic-engine.md / api-spec.md §2.1）。
 *
 * `core`（純関数）・`llm`（生成）・`datastore`（永続化）を組み合わせるのがここの責務。
 * **判定ロジックをここに書かない。** ゲート遷移も段階遷移もスコアも `core` にあり、
 * この層はそれを呼ぶだけにする（NFR-Q2: 純関数として単体テストできる状態を保つ）。
 *
 * `secret-repo` に触れてよいのはこの層だけ（packages/README.md）。
 */

// ─────────────────────────────────────────────────────────────────────────────
//  共通ヘルパ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 入力のマスキング（FR-11）。**サーバ側は入口で 1 回だけ通す。**
 * 保存直前・送信直前に散らすと、通し忘れる箇所が生まれる（security.md §3 原則 2）。
 */
function mask(text: string): string {
  return maskText(text, { maskWords: parseMaskWords(maskWordsRaw()) })
}

function maskOptional(text: string | undefined): string | null {
  return text === undefined || text === '' ? null : mask(text)
}

async function loadSession(auth: AuthContext, sessionId: string): Promise<SessionItem> {
  const owner = ownerIdOf(auth)
  // ★ メインキーに ownerId を含めるため、他人のセッションは「見つからない」に着地する
  const session = await sessionRepo.getSession(owner, sessionId)
  if (!session) throw errors.sessionNotFound()
  return session
}

/**
 * 1 セッションのトークン上限（NFR-C1）。
 * **1 人のユーザーが無制限に課金を発生させられない状態にする。**
 */
function assertTokenBudget(session: SessionItem): void {
  if (session.tokenUsed >= sessionTokenBudget()) throw errors.tokenBudgetExceeded()
}

/** LLM 呼び出しの結果をセッションとログに反映する */
async function applyCalls(session: SessionItem, calls: readonly LlmCallMeta[]): Promise<void> {
  session.tokenUsed += totalTokens(calls)
  await recordLlmCalls(session.sessionId, calls)
}

function actionsOf(session: SessionItem, now = Date.now()): SessionActions {
  return computeActions(gateStateOf(session), now, gateTimeouts())
}

function bodyHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

/** 該当段階の着眼点。診断が無ければ null（汎用モード / FR-15） */
function focusHintFor(diagnosis: DiagnosisSecret | null, stage: Stage): string | null {
  return diagnosis?.focusHints.find((h) => h.stage === stage)?.lookAt ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST /v1/sessions — セッション開始（Gate A）
// ─────────────────────────────────────────────────────────────────────────────

export async function createSession(
  auth: AuthContext,
  req: CreateSessionRequest,
): Promise<{ session: SessionPublic; hint: HintPublic; actions: SessionActions }> {
  // 演習モード（FR-34 が前提）は v0.2。理由が伝わる形で断る
  if (req.mode === 'assessment') {
    throw errors.invalidInput('演習モードは v0.2 の機能です。実務モードでご利用ください')
  }

  const owner = ownerIdOf(auth)
  await assertSessionRateLimit(owner)

  const now = Date.now()
  const sessionId = ulid(now)

  // **診断は待たない。** ここで待つと NFR-P1（5 秒以内）を満たせない（ADR-006）
  const errorText = mask(req.errorText)
  const hint = await generateGuardedHint({
    errorText,
    language: req.language ?? null,
  })

  const session: SessionItem = {
    ownerId: owner,
    sessionId,
    mode: 'live',
    problemId: null,
    assignmentId: null,
    // 診断が返るまでは中庸に置く。実際の難易度は Diagnoser が決める
    difficulty: 'medium',
    errorText,
    codeSnippet: maskOptional(req.codeSnippet),
    language: req.language ?? null,
    framework: req.framework ?? null,
    recentChange: maskOptional(req.recentChange),
    status: 'active',
    gate: 'A',
    reachedGate: null,
    currentStage: null,
    // Lv1 は自動提示（socratic-engine.md §6 提示の順序）
    hintLevel: 1,
    diagnosisStatus: 'pending',
    totalStages: resolveTotalStages(demoMaxStages()),
    stuckStages: [],
    stageResults: [],
    tokenUsed: 0,
    startedAt: now,
    gateEnteredAt: { A: now, B: null, C: null },
    completedAt: null,
    turns: [],
    hints: [{ gate: 'A', level: 1, body: hint.body, auto: true, at: now }],
    conclusions: [],
    retrospection: null,
  }

  await applyCalls(session, hint.calls)
  await sessionRepo.putSession(session)

  return {
    session: toSessionPublic(session),
    hint: { level: 1, body: hint.body },
    actions: actionsOf(session, now),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST /v1/sessions/:id/diagnose — 先行診断（ADR-006）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * クライアントは最初のヒントを描画した直後にこれを撃つ。**投げっぱなしでよい。**
 * ユーザーがヒントを読んで考えている 20〜60 秒の間に、重い診断が完了する。
 */
export async function runDiagnosis(
  auth: AuthContext,
  sessionId: string,
): Promise<{ diagnosisStatus: SessionItem['diagnosisStatus'] }> {
  const session = await loadSession(auth, sessionId)

  // 冪等: pending 以外なら何もしない（api-spec.md §4 / 二重発火の防止）
  if (session.diagnosisStatus !== 'pending') {
    return { diagnosisStatus: session.diagnosisStatus }
  }
  assertTokenBudget(session)

  try {
    const result = await diagnose({
      errorText: session.errorText,
      codeSnippet: session.codeSnippet,
      language: session.language,
      framework: session.framework,
      recentChange: session.recentChange,
    })
    await applyCalls(session, result.calls)

    const secret: DiagnosisSecret = {
      sessionId,
      kind: 'diagnosis',
      rootCause: result.data.rootCause,
      confidence: result.data.confidence,
      evidence: result.data.evidence,
      focusHints: result.data.focusHints,
      distractorThemes: result.data.distractorThemes,
      difficulty: result.data.difficulty,
      // Gate A の Lv1〜3 を診断と同じ 1 回の呼び出しで受け取っている（NFR-C5）
      hints: result.data.gateAHints,
      modelUsed: result.calls[result.calls.length - 1]?.model ?? 'unknown',
      createdAt: Date.now(),
    }
    await secretRepo.putDiagnosis(secret)

    session.diagnosisStatus = 'ready'
    session.difficulty = result.data.difficulty
  } catch (cause) {
    if (!(cause instanceof LlmError)) throw cause
    // **問答は止めない**（NFR-O4 / FR-15）。以降は focusHints なしの汎用モードで出題する
    // 失敗した呼び出しも記録する。**失敗こそ残さないと原因が追えない**（NFR-O2）
    await applyCalls(session, cause.calls)
    console.log(
      JSON.stringify({
        level: 'WARN',
        event: 'diagnosis.failed',
        sessionId,
        reason: cause.reason,
        detail: cause.detail ?? null,
        attempts: cause.calls.map((call) => ({ model: call.model, error: call.error })),
      }),
    )
    session.diagnosisStatus = 'failed'
  }

  await sessionRepo.putSession(session)
  return { diagnosisStatus: session.diagnosisStatus }
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST /v1/sessions/:id/hints — ヒント開放（Gate A / B 共通）
// ─────────────────────────────────────────────────────────────────────────────

export async function openHint(
  auth: AuthContext,
  sessionId: string,
): Promise<{ hint: HintPublic; session: SessionPublic; actions: SessionActions }> {
  const session = await loadSession(auth, sessionId)
  if (session.status !== 'active') throw errors.sessionCompleted()
  if (!canRequestHint(session)) throw errors.hintExhausted()

  const level = nextHintLevel(session.hintLevel)
  if (level === null) throw errors.hintExhausted()

  /**
   * Lv2 / Lv3 は診断の `gateAHints` から取り出すだけで、**LLM を呼ばない**
   * （socratic-engine.md §6 / cost-model.md §2: Hinter は 1 セッション 1 回）。
   *
   * 診断がまだ終わっていない場合は定型ヒントを返す。ここで診断を待つと
   * 「ヒントを押したら 15 秒固まる」ことになり、体験として最悪の待たせ方になる。
   */
  let body: string
  if (session.diagnosisStatus === 'ready') {
    const diagnosis = await secretRepo.getDiagnosis(sessionId)
    body = diagnosis?.hints[level - 1] ?? fallbackHint(level)
  } else {
    body = fallbackHint(level)
  }

  session.hintLevel = level
  session.hints.push({ gate: session.gate, level, body, auto: false, at: Date.now() })
  await sessionRepo.putSession(session)

  return {
    hint: { level, body },
    session: toSessionPublic(session),
    actions: actionsOf(session),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  設問の生成（Gate B 共通）
// ─────────────────────────────────────────────────────────────────────────────

type NextQuestion =
  | { kind: 'question'; turn: TurnItem; answerKey: AnswerKey; calls: LlmCallMeta[] }
  /** 診断待ち。回答は記録済みなので、クライアントは同じリクエストを再送する */
  | { kind: 'pending' }
  /** Gate B の全段階を通過した。設問はもう無い */
  | { kind: 'exhausted' }

async function buildQuestion(
  session: SessionItem,
  stage: Stage,
  seqInStage: number,
  diagnosis: DiagnosisSecret | null,
): Promise<NextQuestion> {
  /**
   * **Lv1（観察）だけは診断なしで出題できる。** これが ADR-006 の前提であり、
   * 「エラーメッセージは何が undefined だと言っているか」は原因を知らずに問える。
   * Lv2 以降は `focusHints` が要るため、診断が終わるまで待たせる（202 Accepted）。
   */
  if (stage !== 'observe' && session.diagnosisStatus === 'pending') {
    return { kind: 'pending' }
  }

  assertTokenBudget(session)

  const previousQuestions = session.turns
    .filter((t) => t.kind === 'question' && t.stage === stage)
    .map((t) => t.body)

  const generated = await generateGuardedQuestion({
    input: {
      stage,
      seqInStage,
      difficulty: session.difficulty,
      errorText: session.errorText,
      codeSnippet: session.codeSnippet,
      language: session.language,
      framework: session.framework,
      recentChange: session.recentChange,
      focusHint: focusHintFor(diagnosis, stage),
      distractorThemes: diagnosis?.distractorThemes ?? [],
      previousQuestions,
    },
    // ★ 検査専用。Questioner には渡らない
    rootCause: diagnosis?.rootCause ?? null,
  })

  const seq = session.turns.length + 1
  const turn: TurnItem = {
    seq,
    kind: 'question',
    stage,
    seqInStage,
    body: generated.question.question,
    options: generated.question.options,
    hintLevelAtCreation: session.hintLevel,
    leakGuardRetries: generated.leakGuardRetries,
    askedAt: Date.now(),
  }

  return {
    kind: 'question',
    turn,
    answerKey: {
      correctOptionId: generated.question.correctOptionId,
      rationaleIfCorrect: generated.question.rationaleIfCorrect,
      rationaleIfWrong: generated.question.rationaleIfWrong as Record<string, string>,
    },
    calls: generated.calls,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST /v1/sessions/:id/advance — Gate A → B
// ─────────────────────────────────────────────────────────────────────────────

export async function advanceToQuestions(
  auth: AuthContext,
  sessionId: string,
): Promise<{ session: SessionPublic; question: QuestionPublic | null; pending?: PendingPublic }> {
  const session = await loadSession(auth, sessionId)
  if (session.status !== 'active') throw errors.sessionCompleted()

  // 冪等: 既に Gate B なら現在の設問を返す（api-spec.md §4）
  if (session.gate === 'B') {
    const existing = pendingQuestion(session)
    if (existing) {
      return { session: toSessionPublic(session), question: toQuestionPublic(sessionId, existing) }
    }
  } else {
    if (!canAdvanceToQuestions(gateStateOf(session))) throw errors.gateNotUnlocked()

    // **この遷移は不可逆。** 以降 Gate A の評価（gate_factor 1.00）は得られない
    session.gate = 'B'
    session.gateEnteredAt.B = Date.now()
    session.currentStage = stageAt(1, session.totalStages)
  }

  const stage = session.currentStage
  if (!stage) return { session: toSessionPublic(session), question: null }

  const diagnosis =
    session.diagnosisStatus === 'ready' ? await secretRepo.getDiagnosis(sessionId) : null
  // 診断待ちで 202 を返した後の再送でもここに来る。
  // 常に 1 問目として扱うと、同段階の出題数がずれてスコアの試行回数が狂う
  const askedInStage = session.turns.filter((t) => t.kind === 'question' && t.stage === stage).length
  const next = await buildQuestion(session, stage, askedInStage + 1, diagnosis)

  if (next.kind !== 'question') {
    // Lv1 は診断なしで出せる設計なので、通常ここには来ない
    await sessionRepo.putSession(session)
    return {
      session: toSessionPublic(session),
      question: null,
      pending: { reason: 'DIAGNOSIS_IN_PROGRESS', retryAfterMs: 3000 },
    }
  }

  session.turns.push(next.turn)
  await applyCalls(session, next.calls)
  await secretRepo.putAnswerKeys({
    sessionId,
    kind: 'answerkeys',
    keys: { [String(next.turn.seq)]: next.answerKey },
    updatedAt: Date.now(),
  })
  await sessionRepo.putSession(session)

  return {
    session: toSessionPublic(session),
    question: toQuestionPublic(sessionId, next.turn),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST /v1/sessions/:id/answers — 回答（Gate B）
// ─────────────────────────────────────────────────────────────────────────────

export type AnswerOutcome = {
  result: { isCorrect: boolean; feedback: string }
  session: SessionPublic
  nextQuestion: QuestionPublic | null
  pending: PendingPublic | null
  actions: SessionActions
}

export async function submitAnswer(
  auth: AuthContext,
  sessionId: string,
  req: { questionId: string; selectedOptionId: string; elapsedMs?: number },
): Promise<AnswerOutcome> {
  const session = await loadSession(auth, sessionId)
  if (session.status !== 'active') throw errors.sessionCompleted()
  if (session.gate !== 'B') throw errors.gateNotUnlocked('まだ設問に進んでいません')

  const parsed = parseQuestionId(req.questionId)
  if (!parsed || parsed.sessionId !== sessionId) {
    throw errors.invalidInput('questionId がこのセッションのものではありません')
  }
  const turn = findTurn(session, parsed.seq)
  if (!turn || turn.kind !== 'question') throw errors.invalidInput('設問が見つかりません')

  /**
   * `answerkeys`（正誤判定）と `diagnosis`（次問の着眼点）の両方が必要になる。
   * 直列に読むとレイテンシが 2 倍になるため並行にする。
   *
   * アクセス回数は 1 ターン 5 回（NFR-C4 の目標は 4 回以内）。
   * architecture.md §6 の内訳は「secrets を 1 回読む」前提だが、
   * **次問の生成には `focusHints` が必要**なので 2 種類の読み出しが避けられない。
   * 削減案（正解を署名付きトークンでクライアントに預ける）は Q-7 として保留し、
   * v0.1 は素直な実装で進めて実測してから判断する（architecture.md §6 削減の余地）。
   */
  const [answerKeys, diagnosis] = await Promise.all([
    secretRepo.getAnswerKeys(sessionId),
    session.diagnosisStatus === 'ready' ? secretRepo.getDiagnosis(sessionId) : Promise.resolve(null),
  ])

  const alreadyAnswered = turn.answeredAt !== undefined

  if (!alreadyAnswered) {
    const key = answerKeys?.keys[String(turn.seq)]
    if (!key) throw errors.invalidInput('この設問はもう受け付けられません')
    if (!turn.options.some((o) => o.id === req.selectedOptionId)) {
      throw errors.invalidInput('選択肢が不正です')
    }

    const isCorrect = key.correctOptionId === req.selectedOptionId
    // **正誤判定に LLM を使わない**（socratic-engine.md §4.1）。
    // フィードバック文は出題時に生成済みのものを使うため、ここでの LLM 呼び出しは 0 回
    turn.selectedOptionId = req.selectedOptionId
    turn.isCorrect = isCorrect
    turn.feedback = isCorrect
      ? key.rationaleIfCorrect
      : (key.rationaleIfWrong[req.selectedOptionId] ??
        'もう一度、エラーメッセージの該当箇所を見直してみてください。')
    turn.elapsedMs = req.elapsedMs ?? 0
    turn.answeredAt = Date.now()

    applyStageTransition(session, turn, isCorrect)
  }

  // 冪等の再送でも「次の設問がまだ無い」状態は解消しなければならないため、
  // 記録済みかどうかに関わらず次問の有無を確認する（api-spec.md §3.5 の再送）
  const outcome = await ensureNextQuestion(session, diagnosis, answerKeys?.keys ?? {})

  await sessionRepo.putSession(session)

  return {
    result: { isCorrect: turn.isCorrect ?? false, feedback: turn.feedback ?? '' },
    session: toSessionPublic(session),
    nextQuestion: outcome.question,
    pending: outcome.pending,
    actions: actionsOf(session),
  }
}

/**
 * 段階遷移の適用（FR-06）。
 *
 * - 正解 → 次の段階へ
 * - 不正解 → 同段階で角度を変えて再出題（最大 3 問）
 * - 3 問目も不正解 → **ヒントレベルを 1 上げて次の段階へ**
 *
 * 同段階に留めないのは、正解できない利用者が前へ進めなくなるため
 * （socratic-engine.md §7 要点 1: 前進は常にできる）。
 */
function applyStageTransition(session: SessionItem, turn: TurnItem, isCorrect: boolean): void {
  const stage = turn.stage
  const elapsedMs = session.turns
    .filter((t) => t.stage === stage)
    .reduce((sum, t) => sum + (t.elapsedMs ?? 0), 0)

  const advance = () => {
    session.currentStage = nextStageAfter(stage, session.totalStages)
  }

  if (isCorrect) {
    session.stageResults.push({
      stage,
      attempts: turn.seqInStage,
      solved: true,
      hintLevel: turn.hintLevelAtCreation,
      elapsedMs,
    })
    advance()
    return
  }

  if (isStageExhausted(turn.seqInStage)) {
    session.stageResults.push({
      stage,
      attempts: turn.seqInStage,
      solved: false,
      hintLevel: turn.hintLevelAtCreation,
      elapsedMs,
    })
    // 「詰まり」として記録する。2 段階以上で Gate C が解放される（socratic-engine.md §7）
    if (!session.stuckStages.includes(stage)) session.stuckStages.push(stage)
    session.hintLevel = raiseHintLevel(session.hintLevel)
    advance()
  }
  // 3 問目までは同段階に留まる（currentStage を変えない）
}

async function ensureNextQuestion(
  session: SessionItem,
  diagnosis: DiagnosisSecret | null,
  existingKeys: Record<string, AnswerKey>,
): Promise<{ question: QuestionPublic | null; pending: PendingPublic | null }> {
  const existing = pendingQuestion(session)
  if (existing) {
    return { question: toQuestionPublic(session.sessionId, existing), pending: null }
  }

  const stage = session.currentStage
  // 全段階を通過した。ここで完了にはしない —— 原因宣言と Gate C が残っている
  // （socratic-engine.md §7: Lv5 まで通過しても未到達なら Gate C へ）
  if (!stage) return { question: null, pending: null }

  const answeredInStage = session.turns.filter(
    (t) => t.kind === 'question' && t.stage === stage,
  ).length
  const next = await buildQuestion(session, stage, answeredInStage + 1, diagnosis)

  if (next.kind === 'pending') {
    return { question: null, pending: { reason: 'DIAGNOSIS_IN_PROGRESS', retryAfterMs: 3000 } }
  }
  if (next.kind === 'exhausted') return { question: null, pending: null }

  session.turns.push(next.turn)
  await applyCalls(session, next.calls)
  await secretRepo.putAnswerKeys({
    sessionId: session.sessionId,
    kind: 'answerkeys',
    keys: { ...existingKeys, [String(next.turn.seq)]: next.answerKey },
    updatedAt: Date.now(),
  })

  return { question: toQuestionPublic(session.sessionId, next.turn), pending: null }
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST /v1/sessions/:id/conclusion — 原因宣言と到達判定
// ─────────────────────────────────────────────────────────────────────────────

export type ConclusionOutcome = {
  conclusion: ConclusionResultPublic
  session: SessionPublic
  actions: SessionActions
  reportPath: string | null
  pending: PendingPublic | null
}

export async function declareConclusion(
  auth: AuthContext,
  sessionId: string,
  req: ConclusionRequest,
): Promise<ConclusionOutcome> {
  const session = await loadSession(auth, sessionId)
  if (session.status !== 'active') throw errors.sessionCompleted()
  if (session.gate === 'C') throw errors.gateNotUnlocked('解説の表示後は原因宣言を受け付けません')

  // 自由記述もマスキング対象（FR-11: 判断基準は「その入力が LLM に届くか」）
  const body = mask(req.body)

  const respond = (
    conclusion: ConclusionResultPublic,
    reportPath: string | null = null,
    pending: PendingPublic | null = null,
  ): ConclusionOutcome => ({
    conclusion,
    session: toSessionPublic(session),
    actions: actionsOf(session),
    reportPath,
    pending,
  })

  // Q-15: 「わかりません」を not_reached にして設問へ戻さない（socratic-engine.md §4.3）
  const precheck = precheckConclusion(body)
  if (precheck.kind === 'dont_know') {
    return respond({
      verdict: null,
      skipped: true,
      feedback:
        'ここまでで分かったことだけでも大丈夫です。設問に戻って絞り込むか、解説を読むかを選べます。',
    })
  }
  if (precheck.kind === 'too_short') {
    return respond({
      verdict: null,
      skipped: true,
      feedback: `もう少し具体的に書いてみてください（${precheck.minLength} 文字以上）。どの時点で何が起きたかを 1 文で構いません。`,
    })
  }

  // 冪等: 直前と同一本文なら記録済みの判定を返す（api-spec.md §4）
  const hash = bodyHash(body)
  const last = session.conclusions[session.conclusions.length - 1]
  if (last && last.bodyHash === hash && last.verdict !== null) {
    return respond(
      { verdict: last.verdict, feedback: last.feedback },
      last.verdict === 'reached' ? reportPathOf(sessionId) : null,
    )
  }

  if (session.diagnosisStatus === 'pending') {
    // 到達判定は診断が無いと成立しない。**回答は捨てずに待たせる**
    return respond(
      { verdict: null, skipped: true, feedback: '内容を確認しています。少しお待ちください。' },
      null,
      { reason: 'DIAGNOSIS_IN_PROGRESS', retryAfterMs: 3000 },
    )
  }

  const diagnosis = await secretRepo.getDiagnosis(sessionId)
  if (!diagnosis) {
    // 診断が失敗したセッション。**判定できないことを正直に返す**（勝手に reached にしない）
    return respond({
      verdict: null,
      skipped: true,
      feedback:
        '内部診断が完了しなかったため、到達判定ができません。解説の表示に進むことはできます。',
    })
  }

  assertTokenBudget(session)

  let verdict: ConclusionResultPublic['verdict']
  let feedback: string
  try {
    const judged = await judgeConclusion({
      conclusion: precheck.body,
      rootCause: diagnosis.rootCause,
      evidence: diagnosis.evidence,
      errorText: session.errorText,
    })
    await applyCalls(session, judged.calls)
    verdict = judged.data.verdict
    feedback = judged.data.feedback
  } catch (cause) {
    if (!(cause instanceof LlmError)) throw cause
    // 失敗時に reached へ倒さない。評価が甘くなる方向のフォールバックは作らない
    await applyCalls(session, cause.calls)
    logLlmFailure('judge', sessionId, cause)
    verdict = FALLBACK_JUDGE.verdict
    feedback = FALLBACK_JUDGE.feedback
  }

  session.conclusions.push({ bodyHash: hash, verdict, feedback, at: Date.now() })

  if (verdict === 'reached') {
    // **どのゲートで到達したかが評価の内訳になる**（evaluation-model.md §2.2）
    session.reachedGate = session.gate as Gate
    session.status = 'completed'
    session.completedAt = Date.now()
  }

  await sessionRepo.putSession(session)

  return respond(
    { verdict, feedback },
    verdict === 'reached' ? reportPathOf(sessionId) : null,
  )
}

/** 失敗した LLM 呼び出しを、切り分けできる粒度で残す（NFR-O2） */
function logLlmFailure(role: string, sessionId: string, cause: LlmError): void {
  console.log(
    JSON.stringify({
      level: 'WARN',
      event: 'llm.failed',
      role,
      sessionId,
      reason: cause.reason,
      detail: cause.detail ?? null,
      attempts: cause.calls.map((call) => ({ model: call.model, error: call.error })),
    }),
  )
}

function reportPathOf(sessionId: string): string {
  return `/v1/sessions/${sessionId}/report`
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST /v1/sessions/:id/reveal — Gate C（解説を読む）
// ─────────────────────────────────────────────────────────────────────────────

export type RevealOutcome = {
  session: SessionPublic
  reveal: RevealPublic
  retrospection: typeof RETROSPECTION_QUESTION
  actions: SessionActions
}

export async function reveal(auth: AuthContext, sessionId: string): Promise<RevealOutcome> {
  const session = await loadSession(auth, sessionId)

  const reason = revealGateReason(gateStateOf(session), Date.now(), gateTimeouts())
  if (reason === 'gate_a') {
    throw errors.gateNotUnlocked('先に設問へ進んでください')
  }
  if (reason === 'not_unlocked') {
    throw errors.gateNotUnlocked('設問を進めるか、少し時間が経つと解説を読めるようになります')
  }
  if (reason === 'inactive' && session.gate !== 'C') throw errors.sessionCompleted()

  // 冪等: 既に開示済みなら同じ内容を返す（api-spec.md §4）
  const stored = await secretRepo.getReveal(sessionId)
  if (stored) {
    return {
      session: toSessionPublic(session),
      reveal: {
        rootCause: stored.rootCause,
        evidence: stored.evidence,
        fixDirection: stored.fixDirection,
        prevention: stored.prevention,
      },
      retrospection: RETROSPECTION_QUESTION,
      actions: actionsOf(session),
    }
  }

  const diagnosis = await secretRepo.getDiagnosis(sessionId)
  const revealed = await buildReveal(session, diagnosis)

  await secretRepo.putReveal({ sessionId, kind: 'reveal', ...revealed, createdAt: Date.now() })

  session.gate = 'C'
  session.gateEnteredAt.C = Date.now()
  session.reachedGate = 'C'
  await sessionRepo.putSession(session)

  return {
    session: toSessionPublic(session),
    reveal: revealed,
    retrospection: RETROSPECTION_QUESTION,
    actions: actionsOf(session),
  }
}

async function buildReveal(
  session: SessionItem,
  diagnosis: DiagnosisSecret | null,
): Promise<RevealPublic> {
  if (!diagnosis) {
    /**
     * 診断が失敗したセッション。**「答えが出せない」状態でも画面は止めない**（FR-17）。
     * ここで何も返さないと、Gate C が到達不能になり P2（業務を止めない）に反する。
     */
    return {
      rootCause:
        '内部診断が完了しなかったため、原因の特定結果を提示できません。ここまでの観察を手がかりに、次の手順をお試しください。',
      evidence: ['診断処理が応答しなかったため、根拠を提示できません'],
      fixDirection: FALLBACK_REVEAL.fixDirection,
      prevention: FALLBACK_REVEAL.prevention,
    }
  }

  try {
    assertTokenBudget(session)
    const result = await generateReveal({
      rootCause: diagnosis.rootCause,
      evidence: diagnosis.evidence,
      errorText: session.errorText,
      language: session.language,
    })
    await applyCalls(session, result.calls)
    return result.data
  } catch (cause) {
    if (!(cause instanceof LlmError)) throw cause
    // 解説の生成に失敗しても、**診断結果そのものは手元にある**ので開示できる
    await applyCalls(session, cause.calls)
    logLlmFailure('revealer', session.sessionId, cause)
    return {
      rootCause: diagnosis.rootCause,
      evidence: diagnosis.evidence,
      fixDirection: FALLBACK_REVEAL.fixDirection,
      prevention: FALLBACK_REVEAL.prevention,
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST /v1/sessions/:id/retrospect — 振り返り（Gate C 後・必須）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 開示して終わりにすると学習が成立しない（socratic-engine.md §8）。
 * この回答は**スコアには使わない**（自己申告のため）が、
 * 振り返りレポートの材料になり、何より利用者自身に自覚を促す。
 */
export async function retrospect(
  auth: AuthContext,
  sessionId: string,
  req: RetrospectRequest,
): Promise<{ session: SessionPublic; reportPath: string }> {
  const session = await loadSession(auth, sessionId)
  if (session.gate !== 'C') throw errors.gateNotUnlocked('先に解説を読んでください')

  session.retrospection = {
    selectedOptionId: req.selectedOptionId ?? null,
    // 自由記述は Reporter に渡るためマスキング対象（FR-11）
    note: req.note ? mask(req.note) : null,
    at: Date.now(),
  }
  session.status = 'completed'
  session.completedAt = session.completedAt ?? Date.now()
  await sessionRepo.putSession(session)

  return { session: toSessionPublic(session), reportPath: reportPathOf(sessionId) }
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET / DELETE /v1/sessions/:id
// ─────────────────────────────────────────────────────────────────────────────

/** 復帰用（api-spec.md §2.1）。進行中の設問も返すのでリロードで続きから戻れる */
export async function getSessionState(
  auth: AuthContext,
  sessionId: string,
): Promise<{
  session: SessionPublic
  question: QuestionPublic | null
  hints: HintPublic[]
  actions: SessionActions
}> {
  const session = await loadSession(auth, sessionId)
  const current = pendingQuestion(session)
  return {
    session: toSessionPublic(session),
    question: current ? toQuestionPublic(sessionId, current) : null,
    hints: session.hints.map((h) => ({ level: h.level, body: h.body })),
    actions: actionsOf(session),
  }
}

/**
 * セッション削除（NFR-S7 / data-model.md §7）。
 * **CASCADE がないため関連アイテムを明示的に削除する。**
 */
export async function deleteSessionCascade(auth: AuthContext, sessionId: string): Promise<void> {
  const owner: OwnerId = ownerIdOf(auth)
  // 所有者の確認を兼ねる。他人のセッションはここで 404 になる
  await loadSession(auth, sessionId)

  await sessionRepo.deleteSession(owner, sessionId)
  await reportRepo.deleteReport(owner, sessionId)
  await secretRepo.deleteSecrets(sessionId)
  // 件数分のアクセスを消費するため、無効時はスキップする
  if (opsLogEnabled()) await opsRepo.deleteOpsLogs(sessionId)
}

/** 段階の並び順で道筋を整える。レポートと個人統計が共通で使う */
export function orderedStageResults(session: SessionItem): SessionItem['stageResults'] {
  return [...session.stageResults].sort((a, b) => indexOfStage(a.stage) - indexOfStage(b.stage))
}

export { questionIdOf }
