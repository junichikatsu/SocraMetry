import type { Difficulty, Stage } from '@socrametry/shared'
import { isMockMode } from './models'
import { MOCK_DIAGNOSIS, MOCK_HINT, MOCK_QUESTIONS, MOCK_REPORT, MOCK_REVEAL, mockJudge } from './mock'
import { callJson, mockMeta, type LlmResult } from './orca-client'
import {
  diagnoserPrompt,
  hinterPrompt,
  judgePrompt,
  questionerPrompt,
  reporterPrompt,
  revealerPrompt,
} from './prompts'
import {
  diagnoserOutputSchema,
  hinterOutputSchema,
  judgeOutputSchema,
  questionerOutputSchema,
  reporterOutputSchema,
  revealerOutputSchema,
  type DiagnoserOutput,
  type HinterOutput,
  type JudgeOutput,
  type QuestionerOutput,
  type ReporterOutput,
  type RevealerOutput,
} from './schemas'

/**
 * 役割別の呼び出し口（ADR-003 / ADR-014）。
 *
 * **MOCK モードの分岐は各関数の入口 1 箇所**に置く。
 * 後から入れると LLM 呼び出しがコードの各所に散った後になり、差し込みが高くつく。
 *
 * ここが「答えを渡さない」境界でもある。`generateQuestion` の引数に
 * `rootCause` が存在しないことが、ADR-003 の実装上の担保になっている。
 */

export type ErrorContext = {
  errorText: string
  codeSnippet?: string | null
  language?: string | null
  framework?: string | null
  recentChange?: string | null
}

// ── ① Diagnoser（高品質・1 セッション 1 回 / NFR-C3 で再診断しない）─────────

export function diagnose(input: ErrorContext): Promise<LlmResult<DiagnoserOutput>> {
  if (isMockMode()) return Promise.resolve({ data: MOCK_DIAGNOSIS, calls: [mockMeta('diagnoser')] })
  return callJson({ role: 'diagnoser', ...diagnoserPrompt(input), schema: diagnoserOutputSchema })
}

// ── Hinter（安価・診断前の Gate A Lv1）──────────────────────────────────────

export function generateHint(input: {
  errorText: string
  language?: string | null
}): Promise<LlmResult<HinterOutput>> {
  if (isMockMode()) {
    return Promise.resolve({ data: { hint: MOCK_HINT }, calls: [mockMeta('hinter')] })
  }
  return callJson({ role: 'hinter', ...hinterPrompt(input), schema: hinterOutputSchema })
}

// ── ② Questioner（安価・8〜12 回）★ rootCause を受け取らない ───────────────

export type QuestionerInput = ErrorContext & {
  stage: Stage
  seqInStage: number
  difficulty: Difficulty
  /** 該当段階の着眼点のみ。診断が無い / 失敗した場合は null（汎用モード / FR-15） */
  focusHint: string | null
  distractorThemes: string[]
  previousQuestions: string[]
  /** 再生成の理由。何が駄目だったかを伝えないと同じ失敗を繰り返す */
  regenerateReason?: 'leak' | 'shape' | null
}

export function generateQuestion(input: QuestionerInput): Promise<LlmResult<QuestionerOutput>> {
  if (isMockMode()) {
    return Promise.resolve({
      data: MOCK_QUESTIONS[input.stage],
      calls: [mockMeta('questioner')],
    })
  }
  return callJson({
    role: 'questioner',
    ...questionerPrompt({ ...input, regenerateReason: input.regenerateReason ?? null }),
    schema: questionerOutputSchema,
  })
}

// ── ③ Judge（安価・到達判定）────────────────────────────────────────────────

export function judgeConclusion(input: {
  conclusion: string
  rootCause: string
  evidence: string[]
  errorText: string
  /** 判定を据え置いて文面だけ書き直させる場合に渡す */
  feedbackOnly?: { verdict: string; previous: string } | null
}): Promise<LlmResult<JudgeOutput>> {
  if (isMockMode()) {
    return Promise.resolve({ data: mockJudge(input.conclusion), calls: [mockMeta('judge')] })
  }
  return callJson({
    role: 'judge',
    ...judgePrompt({ ...input, feedbackOnly: input.feedbackOnly ?? null }),
    schema: judgeOutputSchema,
  })
}

// ── Revealer（高品質・Gate C）───────────────────────────────────────────────

export function generateReveal(input: {
  rootCause: string
  evidence: string[]
  errorText: string
  language?: string | null
}): Promise<LlmResult<RevealerOutput>> {
  if (isMockMode()) return Promise.resolve({ data: MOCK_REVEAL, calls: [mockMeta('revealer')] })
  return callJson({ role: 'revealer', ...revealerPrompt(input), schema: revealerOutputSchema })
}

// ── Reporter（高品質・1 セッション 1 回）────────────────────────────────────

export function generateReport(input: {
  errorText: string
  rootCause: string | null
  reachedGate: string
  path: Array<{ stage: Stage; attempts: number; hintLevel: number; elapsedMs: number }>
  retrospectionAnswer: string | null
}): Promise<LlmResult<ReporterOutput>> {
  if (isMockMode()) return Promise.resolve({ data: MOCK_REPORT, calls: [mockMeta('reporter')] })
  return callJson({ role: 'reporter', ...reporterPrompt(input), schema: reporterOutputSchema })
}
