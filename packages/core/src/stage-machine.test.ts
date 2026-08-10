import { describe, expect, it } from 'vitest'
import {
  indexOfStage,
  isStageExhausted,
  nextStageAfter,
  resolveTotalStages,
  stageAt,
} from './stage-machine'

describe('stage-machine', () => {
  it('Lv1 観察 → Lv5 修正 の順に進む', () => {
    expect(stageAt(1)).toBe('observe')
    expect(nextStageAfter('observe')).toBe('localize')
    expect(nextStageAfter('verify')).toBe('fix')
  })

  it('最終段階の次は null（Gate B を通過した）', () => {
    expect(nextStageAfter('fix')).toBeNull()
  })

  it('段階のインデックスは 1 起算', () => {
    expect(indexOfStage('observe')).toBe(1)
    expect(indexOfStage('fix')).toBe(5)
  })

  it('DEMO_MAX_STAGES で段階数を絞れる（削る順序 #4 を設定値として持つ）', () => {
    expect(resolveTotalStages(3)).toBe(3)
    expect(nextStageAfter('hypothesize', 3)).toBeNull()
  })

  it('段階数の設定が壊れていても既定の 5 に落ちる', () => {
    expect(resolveTotalStages(undefined)).toBe(5)
    expect(resolveTotalStages(Number.NaN)).toBe(5)
    expect(resolveTotalStages(99)).toBe(5)
    expect(resolveTotalStages(0)).toBe(1)
  })

  it('同段階 3 問目で打ち切る（詰まらせない）', () => {
    expect(isStageExhausted(2)).toBe(false)
    expect(isStageExhausted(3)).toBe(true)
  })
})
