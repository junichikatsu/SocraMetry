import { z } from 'zod'
import { optionIdSchema, questionIdSchema } from './common'

/**
 * Gate B の回答（api-spec.md §3.5）。
 *
 * `questionId` を**クライアントに送らせる**のは冪等性のため。
 * サーバは「現在の設問」ではなく「指定された設問」への回答として扱い、
 * 既に `answeredAt` があれば記録済みの結果をそのまま返す（api-spec.md §4）。
 */
export const submitAnswerRequestSchema = z.object({
  questionId: questionIdSchema,
  selectedOptionId: optionIdSchema,
  /**
   * 経過時間はクライアント計測値。**スコアには掛けない**ため改竄の影響がない
   * （evaluation-model.md §3.3: 時間はスコアに掛けず別指標として並記する）。
   * 上限を置いているのは、レポートの表示が壊れないようにするためだけ。
   */
  elapsedMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
})

export type SubmitAnswerRequest = z.infer<typeof submitAnswerRequestSchema>

/**
 * 原因宣言（api-spec.md §3.6 / FR-09）。
 * **本製品で自由記述を受けるのはここだけ**であり、この入力も FR-11 のマスキング対象。
 */
export const conclusionRequestSchema = z.object({
  body: z.string().min(1, '原因を入力してください').max(2_000),
})

export type ConclusionRequest = z.infer<typeof conclusionRequestSchema>

/** Gate C 後の振り返り 1 問（api-spec.md §3.7）。スコアには使わない */
export const retrospectRequestSchema = z.object({
  selectedOptionId: optionIdSchema.optional(),
  note: z.string().max(1_000).optional(),
})

export type RetrospectRequest = z.infer<typeof retrospectRequestSchema>
