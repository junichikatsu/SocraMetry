import type { OptionPublic } from '@socrametry/shared'

/**
 * 設問の形の検査（socratic-engine.md §3 の出題制約）。
 *
 * **Questioner は答えを知らない**（ADR-003）。そのため
 * 「〜は正しいですか？ / はい・いいえ」のように**事実の真偽を問う形**を作ると、
 * 正解を決められない。実際に実 LLM で次の設問が生成された。
 *
 * ```
 * Q: 最近の変更に関連して、アプリが参照する API キーの情報は正しいですか？
 *    a. はい、ローテーション後の情報が正しく更新されていると思う   ← 正解扱い
 *    b. いいえ、ヘッダー生成ロジックに問題があるかもしれない
 * ```
 *
 * 実際の原因は「更新されていなかった」ため、a を正解とするのは破綻している。
 * **答えを知らない出題者が正解を決められる問いになっているか**を、
 * LLM ではなく決定的なルールで検査する（LeakGuard と同じ考え方）。
 */

/** 真偽の返答で始まる選択肢。「はい、〜」「いいえ、〜」の形を拾う */
const TRUTH_VALUE_PREFIX = /^\s*(はい|いいえ|イエス|ノー|yes|no)\b|^\s*(はい|いいえ)[、,。]/i

/** 「〜ですか？」のうち、真偽を問う述語 */
const TRUTH_VALUE_QUESTION =
  /(正しい|合っている|一致している|更新されている|設定されている|反映されている|されています|ありますか)(です)?か[?？]?\s*$/

export type QuestionShapeResult = {
  /** 出題として成立しない形なら true */
  invalid: boolean
  rules: string[]
}

/**
 * 検査は**選択肢の形を主**に見る。設問文だけでは判断を誤りやすい
 * （「その値は正しく渡っていますか？」は真偽問いだが、
 * 選択肢が具体的な観点なら成立する）。
 */
export function checkQuestionShape(
  body: string,
  options: readonly OptionPublic[],
): QuestionShapeResult {
  const rules: string[] = []

  const truthValueOptions = options.filter((option) => TRUTH_VALUE_PREFIX.test(option.label))
  // 1 つだけなら、たまたまその語で始まっただけの可能性がある。
  // 2 つ以上あるときに「真偽の二択」と判断する
  if (truthValueOptions.length >= 2) rules.push('Q1')

  // 設問文が真偽を問い、かつ選択肢にも真偽語が混ざっている場合
  if (TRUTH_VALUE_QUESTION.test(body.trim()) && truthValueOptions.length >= 1) rules.push('Q2')

  // 選択肢の重複。同じ内容が並ぶと正解が一意に決まらない
  const labels = options.map((option) => option.label.trim())
  if (new Set(labels).size !== labels.length) rules.push('Q3')

  return { invalid: rules.length > 0, rules }
}
