import {
  checkLeak,
  checkLeakInParts,
  checkQuestionShape,
  checkVerdictConsistency,
  REACHED_FALLBACK_FEEDBACK,
  stripHintLabel,
} from '@socrametry/core'
import {
  FALLBACK_JUDGE,
  FALLBACK_QUESTIONS,
  fallbackHint,
  generateHint,
  generateQuestion,
  judgeConclusion,
  LlmError,
  type JudgeOutput,
  type LlmCallMeta,
  type QuestionerInput,
  type QuestionerOutput,
} from '@socrametry/llm'

/**
 * LeakGuard を通した生成（FR-08 / socratic-engine.md §5）。
 *
 * 三重防御の 2 段目と 3 段目をここで実装する。
 *
 * | # | 防御 | 実装場所 |
 * |---|---|---|
 * | 1 | **役割分離**（Questioner に結論を渡さない） | `@socrametry/llm`（引数に `rootCause` が無い） |
 * | 2 | 生成文の検査 → **制約を強めて 1 回だけ再生成** | 本ファイル |
 * | 3 | 定型テンプレートへのフォールバック | 本ファイル |
 *
 * **`rootCause` はここまでしか来ない。**
 * LeakGuard の語彙一致（L4）に必要なので受け取るが、
 * `generateQuestion` には渡さない。**検査に使う値と、生成に渡す値を分けている**のが要点。
 * 3 回目の生成は試さない。確率に頼らないことがこの設計の趣旨である。
 */

export type GuardedQuestion = {
  question: QuestionerOutput
  calls: LlmCallMeta[]
  leakGuardRetries: number
  /** 定型テンプレートに落ちたか。運用ログで頻度を追う */
  fallbackUsed: boolean
}

/** 設問のうち、ユーザーに見える文面すべてを検査対象にする */
function inspectableParts(q: QuestionerOutput): string[] {
  return [q.question, ...q.options.map((o) => o.label), q.rationaleIfCorrect, ...Object.values(q.rationaleIfWrong)]
}

export async function generateGuardedQuestion(params: {
  input: QuestionerInput
  /** 検査専用。生成には渡さない */
  rootCause: string | null
}): Promise<GuardedQuestion> {
  const calls: LlmCallMeta[] = []
  const guardOptions = {
    stage: params.input.stage,
    ...(params.rootCause === null ? {} : { rootCause: params.rootCause }),
  }

  // 1 回目は素の制約で、2 回目は**何が駄目だったか**を伝えて再生成する
  let regenerateReason: 'leak' | 'shape' | null = null

  for (const attempt of [0, 1]) {
    try {
      const result = await generateQuestion({ ...params.input, regenerateReason })
      calls.push(...result.calls)

      const leak = checkLeakInParts(inspectableParts(result.data), guardOptions)
      /**
       * 漏洩だけでなく**出題として成立するか**も検査する。
       * 「〜は正しいですか？／はい・いいえ」の形は、
       * 答えを知らない出題者には正解を決められない（question-shape.ts）。
       * 再生成の経路は漏洩と共通にする。3 回目は試さない。
       */
      const shape = checkQuestionShape(result.data.question, result.data.options)

      if (!leak.leaked && !shape.invalid) {
        return { question: result.data, calls, leakGuardRetries: attempt, fallbackUsed: false }
      }

      // 検出イベントは構造化ログに記録する（プロンプト改善のため）
      if (leak.leaked) logLeak('questioner', params.input.stage, leak.rules, attempt)
      if (shape.invalid) logShape('questioner', params.input.stage, shape.rules, attempt)
      // 漏洩の方が重い。両方出たら漏洩の指示を優先する
      regenerateReason = leak.leaked ? 'leak' : 'shape'
      const last = calls[calls.length - 1]
      if (last) last.leakGuardHit = true
    } catch (cause) {
      if (!(cause instanceof LlmError)) throw cause
      // 失敗した呼び出しも記録に残す（NFR-O2）。原因を追う手段がなくなるため
      calls.push(...cause.calls)
      logGenerationFailure('questioner', cause)
      break
    }
  }

  // 3 段目: 定型テンプレート。**体験は劣化するが継続はできる**（NFR-O4 / FR-17）
  logFallback('questioner', params.input.stage)
  return {
    question: FALLBACK_QUESTIONS[params.input.stage],
    calls,
    leakGuardRetries: 2,
    fallbackUsed: true,
  }
}

export type GuardedHint = {
  body: string
  calls: LlmCallMeta[]
  fallbackUsed: boolean
}

/**
 * Gate A の Lv1 ヒント（診断前）。
 * ここは**エラーテキストだけから作る**ため `rootCause` の照合対象がない。
 * それでも断定表現と修正動詞の検査（L1 / L3）は通す。
 */
export async function generateGuardedHint(params: {
  errorText: string
  language: string | null
}): Promise<GuardedHint> {
  const calls: LlmCallMeta[] = []
  try {
    const result = await generateHint(params)
    calls.push(...result.calls)

    // 画面が「Lv2」を別に表示するため、本文のレベル表記は落とす
    const hint = stripHintLabel(result.data.hint)
    const leak = checkLeak(hint)
    if (!leak.leaked) return { body: hint, calls, fallbackUsed: false }

    logLeak('hinter', null, leak.rules, 0)
    const last = calls[calls.length - 1]
    if (last) last.leakGuardHit = true
  } catch (cause) {
    if (!(cause instanceof LlmError)) throw cause
    calls.push(...cause.calls)
    logGenerationFailure('hinter', cause)
  }

  // ヒントは再生成しない。1 文しかないため、失敗したら定型に落とす方が速く確実
  logFallback('hinter', null)
  return { body: fallbackHint(1), calls, fallbackUsed: true }
}

export type GuardedJudge = {
  judgement: JudgeOutput
  calls: LlmCallMeta[]
  /** 文面を差し替えたか。運用ログで頻度を追う */
  repaired: boolean
}

/**
 * 到達判定（FR-09）。**判定と文面の整合を検査する。**
 *
 * `reached` なのに「まだ足りない」と読める文面が返ることが実測で確認された。
 * デモの山場（自力で到達する場面）を壊すため、決定的なルールで検査し、
 * 1 回だけ書き直させる。それでも直らなければ**判定は変えずに文面だけ**差し替える。
 *
 * **判定そのものは書き直させない。** 評価に使う値なので、
 * 文面の都合で判定が動くようなことがあってはならない。
 */
export async function judgeGuarded(input: {
  conclusion: string
  rootCause: string
  evidence: string[]
  errorText: string
}): Promise<GuardedJudge> {
  const calls: LlmCallMeta[] = []

  try {
    const first = await judgeConclusion(input)
    calls.push(...first.calls)

    const shape = checkVerdictConsistency(first.data.verdict, first.data.feedback)
    if (!shape.inconsistent) return { judgement: first.data, calls, repaired: false }

    logVerdictShape(shape.rules, 0)

    // 判定は据え置き、文面だけ書き直させる
    const retry = await judgeConclusion({
      ...input,
      feedbackOnly: { verdict: first.data.verdict, previous: first.data.feedback },
    })
    calls.push(...retry.calls)

    // 判定が変わった場合は 1 回目を正とする（文面の書き直しで判定を動かさない）
    const judgement: JudgeOutput = { verdict: first.data.verdict, feedback: retry.data.feedback }
    const second = checkVerdictConsistency(judgement.verdict, judgement.feedback)
    if (!second.inconsistent) return { judgement, calls, repaired: true }

    logVerdictShape(second.rules, 1)
    return {
      judgement: { verdict: first.data.verdict, feedback: REACHED_FALLBACK_FEEDBACK },
      calls,
      repaired: true,
    }
  } catch (cause) {
    if (!(cause instanceof LlmError)) throw cause
    calls.push(...cause.calls)
    logGenerationFailure('judge', cause)
    // 失敗時に reached へ倒さない。評価が甘くなる方向のフォールバックは作らない
    return { judgement: { ...FALLBACK_JUDGE }, calls, repaired: false }
  }
}

function logVerdictShape(rules: string[], attempt: number): void {
  console.log(
    JSON.stringify({ level: 'WARN', event: 'verdict.inconsistent', rules, attempt }),
  )
}

function logLeak(role: string, stage: string | null, rules: string[], attempt: number): void {
  console.log(
    JSON.stringify({ level: 'WARN', event: 'leakguard.hit', role, stage, rules, attempt }),
  )
}

function logShape(role: string, stage: string | null, rules: string[], attempt: number): void {
  console.log(
    JSON.stringify({ level: 'WARN', event: 'question.invalid_shape', role, stage, rules, attempt }),
  )
}

function logFallback(role: string, stage: string | null): void {
  console.log(JSON.stringify({ level: 'WARN', event: 'generation.fallback', role, stage }))
}

function logGenerationFailure(role: string, cause: LlmError): void {
  console.log(
    JSON.stringify({
      level: 'WARN',
      event: 'generation.failed',
      role,
      reason: cause.reason,
      detail: cause.detail ?? null,
      attempts: cause.calls.map((call) => ({ model: call.model, error: call.error })),
    }),
  )
}
