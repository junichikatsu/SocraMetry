import { STAGES, type Stage } from '@socrametry/shared'

/**
 * 段階遷移（FR-06 / socratic-engine.md §3）。
 *
 * Lv1 観察 → Lv5 修正。正解で次段階へ、不正解は同段階で角度を変えて最大 3 問。
 */

/** 同段階での最大出題数。3 問目も不正解なら次へ送る（P4: 詰まらせない） */
export const MAX_QUESTIONS_PER_STAGE = 3

/**
 * 段階数の解決。既定は 5（= 5 軸）。
 *
 * `DEMO_MAX_STAGES` で 3 に絞れるようにしているのは、
 * roadmap.md「削る順序 #4」（Lv1〜5 → Lv1〜3）を**設定値として**持つため。
 * 新規実装ではなく、遅れたときの逃げ道を先に用意しているだけ。
 */
export function resolveTotalStages(demoMaxStages?: number): number {
  if (demoMaxStages === undefined) return STAGES.length
  if (!Number.isInteger(demoMaxStages)) return STAGES.length
  return Math.min(Math.max(demoMaxStages, 1), STAGES.length)
}

/** 1 起算のインデックスから段階を引く。範囲外は null */
export function stageAt(index: number, totalStages: number = STAGES.length): Stage | null {
  if (index < 1 || index > resolveTotalStages(totalStages)) return null
  return STAGES[index - 1] ?? null
}

/** 段階の 1 起算インデックス */
export function indexOfStage(stage: Stage): number {
  return STAGES.indexOf(stage) + 1
}

/** 次の段階。最終段階なら null（= Gate B を通過した） */
export function nextStageAfter(stage: Stage, totalStages: number = STAGES.length): Stage | null {
  return stageAt(indexOfStage(stage) + 1, totalStages)
}

/**
 * 同段階で 3 問目も不正解だったか。
 *
 * このとき「ヒントレベルを 1 上げて**次の段階へ**進む」。
 * 同段階に留めると、正解できない利用者が永久に前へ進めなくなる
 * （socratic-engine.md §7 要点 1: 前進は常にできる）。
 */
export function isStageExhausted(seqInStage: number): boolean {
  return seqInStage >= MAX_QUESTIONS_PER_STAGE
}
