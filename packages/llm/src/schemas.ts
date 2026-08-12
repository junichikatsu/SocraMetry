import { z } from 'zod'

/**
 * LLM の出力スキーマ。
 *
 * **生成結果は必ずここを通す。** 構造が崩れた出力を通すと、
 * 選択肢が空の設問や `correctOptionId` が存在しない設問が
 * そのままユーザーに出る（= 回答不能で導線が止まる / FR-17）。
 * スキーマ不一致は「生成失敗」として扱い、退避モデル → 定型テンプレートへ落とす。
 */

const stageSchema = z.enum(['observe', 'localize', 'hypothesize', 'verify', 'fix'])
const optionIdSchema = z.enum(['a', 'b', 'c', 'd', 'e'])

export const diagnoserOutputSchema = z.object({
  /** ★ 答え。Questioner には渡さない */
  rootCause: z.string().min(1).max(600),
  /** 低い場合は情報を補う質問に切り替える（socratic-engine.md §2） */
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().min(1).max(300)).min(1).max(5),
  /** ✅ Questioner に渡す唯一の情報 */
  focusHints: z
    .array(z.object({ stage: stageSchema, lookAt: z.string().min(1).max(200) }))
    .min(1)
    .max(5),
  /** ✅ 誤答選択肢の素材 */
  distractorThemes: z.array(z.string().min(1).max(120)).max(6).default([]),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  /**
   * Gate A のヒント Lv1〜3。**同じ 1 回の呼び出しで受け取る。**
   * ヒントは `focusHints` から作れるため、追加の LLM 呼び出しを発生させない
   * （socratic-engine.md §6 / NFR-C5）。
   */
  gateAHints: z.array(z.string().min(1).max(300)).length(3),
})

export type DiagnoserOutput = z.infer<typeof diagnoserOutputSchema>

export const hinterOutputSchema = z.object({
  hint: z.string().min(1).max(300),
})

export type HinterOutput = z.infer<typeof hinterOutputSchema>

export const questionerOutputSchema = z
  .object({
    question: z.string().min(1).max(300),
    /** 難易度に応じて 2〜5 個（socratic-engine.md C7） */
    options: z
      .array(z.object({ id: optionIdSchema, label: z.string().min(1).max(200) }))
      .min(2)
      .max(5),
    correctOptionId: optionIdSchema,
    rationaleIfCorrect: z.string().min(1).max(300),
    /**
     * 不正解時の誘導。選ばれた分だけ回答後に返す。
     * `partialRecord` にしているのは、**正解の選択肢には誘導文が要らない**ため。
     * 全キー必須にすると、正解分の空文字を埋めるだけの生成が発生する。
     */
    rationaleIfWrong: z.partialRecord(optionIdSchema, z.string().min(1).max(300)).default({}),
  })
  // 正解 ID が選択肢に無い出力は回答不能になるため、ここで弾く
  .refine((v) => v.options.some((o) => o.id === v.correctOptionId), {
    message: 'correctOptionId が options に存在しません',
  })
  // 選択肢 ID の重複も回答不能を招く
  .refine((v) => new Set(v.options.map((o) => o.id)).size === v.options.length, {
    message: 'options の id が重複しています',
  })

export type QuestionerOutput = z.infer<typeof questionerOutputSchema>

export const judgeOutputSchema = z.object({
  verdict: z.enum(['reached', 'partial', 'not_reached']),
  feedback: z.string().min(1).max(400),
})

export type JudgeOutput = z.infer<typeof judgeOutputSchema>

export const revealerOutputSchema = z.object({
  rootCause: z.string().min(1).max(600),
  evidence: z.array(z.string().min(1).max(300)).min(1).max(5),
  fixDirection: z.string().min(1).max(400),
  prevention: z.string().min(1).max(400),
})

export type RevealerOutput = z.infer<typeof revealerOutputSchema>

export const reporterOutputSchema = z.object({
  stumblingPoint: z.string().min(1).max(300),
  /** **この製品の実質的な成果物**（socratic-engine.md §8） */
  generalizedLesson: z.string().min(1).max(400),
  nextTimeSteps: z.array(z.string().min(1).max(200)).min(1).max(5),
})

export type ReporterOutput = z.infer<typeof reporterOutputSchema>
