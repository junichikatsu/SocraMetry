import type { Gate, HintLevel, SessionStatus } from '@socrametry/shared'

/**
 * ヒント開放条件（FR-03 / socratic-engine.md §6）。
 *
 * Lv1 は**セッション開始時に自動提示**、Lv2 / Lv3 は利用者の要求で開放する。
 * Lv3 でも答えは言わない。一般化された知識を与えるだけであり、
 * 今回のケースに当てはめるのは利用者の仕事。
 */

export const MAX_HINT_LEVEL = 3

export function canRequestHint(params: {
  gate: Gate
  status: SessionStatus
  hintLevel: number
}): boolean {
  if (params.status !== 'active') return false
  // Gate C は開示済みなので、ヒントという概念自体が意味を持たない
  if (params.gate === 'C') return false
  return params.hintLevel < MAX_HINT_LEVEL
}

/** 次のヒントレベル。既に 3 なら null（呼び出し側が 409 HINT_EXHAUSTED を返す） */
export function nextHintLevel(current: number): HintLevel | null {
  if (current >= MAX_HINT_LEVEL) return null
  const next = current + 1
  return next as HintLevel
}

/**
 * 同段階 3 問不正解による自動開放（socratic-engine.md §3）。
 * 上限に達していれば据え置く。**上限を超えて減点し続けない。**
 */
export function raiseHintLevel(current: number): HintLevel {
  return Math.min(current + 1, MAX_HINT_LEVEL) as HintLevel
}
