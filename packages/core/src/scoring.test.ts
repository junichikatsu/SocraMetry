import { describe, expect, it } from 'vitest'
import { STAGES, type Stage } from '@socrametry/shared'
import { calculateScore, GATE_FACTORS, weakestAxis, type StageOutcome } from './scoring'

function outcome(stage: Stage, partial: Partial<StageOutcome> = {}): StageOutcome {
  return {
    stage,
    attempts: 1,
    solved: true,
    hintLevel: 0,
    elapsedMs: 10_000,
    asked: true,
    ...partial,
  }
}

const allAsked = (partial: Partial<StageOutcome> = {}) => STAGES.map((s) => outcome(s, partial))
const noneAsked = () =>
  STAGES.map((s) => outcome(s, { asked: false, attempts: 0, solved: false }))

describe('calculateScore', () => {
  it('全段階を 1 問目で正解し Gate B 到達なら 90 点（100 × gate_factor 0.90）', () => {
    const { score } = calculateScore({ outcomes: allAsked(), reachedGate: 'B' })
    expect(score.observe).toBe(100)
    expect(score.total).toBe(90)
    expect(score.gateFactor).toBe(GATE_FACTORS.B)
  })

  it('ヒントを使うと段階スコアが下がる（Lv1 = 0.85）', () => {
    const { score } = calculateScore({
      outcomes: allAsked({ hintLevel: 1 }),
      reachedGate: 'B',
    })
    expect(score.localize).toBe(85)
    expect(score.total).toBe(77) // 85 × 0.90 = 76.5 → 77
  })

  it('試行回数で base が下がる（2 問目 = 70 / 3 問目 = 40 / 未正解 = 0）', () => {
    const { score } = calculateScore({
      outcomes: [
        outcome('observe', { attempts: 2 }),
        outcome('localize', { attempts: 3 }),
        outcome('hypothesize', { attempts: 3, solved: false }),
        outcome('verify'),
        outcome('fix'),
      ],
      reachedGate: 'B',
    })
    expect(score.observe).toBe(70)
    expect(score.localize).toBe(40)
    expect(score.hypothesize).toBe(0)
  })

  it('Gate A で自力解決した場合、未出題の段階を 1 問目正解と同等に扱う', () => {
    // 算出式をそのまま当てると全段階 0 点になり、
    // 「Gate A が最上位評価」（evaluation-model.md §2.2）と矛盾する
    const { score, explanation } = calculateScore({ outcomes: noneAsked(), reachedGate: 'A' })
    expect(score.total).toBe(100)
    expect(explanation.breakdown[0]?.note).toContain('自力で原因に到達')
  })

  it('Gate A でもヒントを使った分は減点される', () => {
    const { score } = calculateScore({
      outcomes: STAGES.map((s) => outcome(s, { asked: false, attempts: 0, solved: false, hintLevel: 3 })),
      reachedGate: 'A',
    })
    expect(score.total).toBe(55) // 100 × 0.55 × 1.00
  })

  it('Gate C（開示）では未出題の段階を 0 のままにする', () => {
    const { score } = calculateScore({ outcomes: noneAsked(), reachedGate: 'C' })
    expect(score.total).toBe(0)
    expect(score.gateFactor).toBe(GATE_FACTORS.C)
  })

  it('実務モードのスコアは横比較に使わせない（NFR-F2）', () => {
    const { score } = calculateScore({ outcomes: allAsked(), reachedGate: 'B' })
    expect(score.comparable).toBe(false)
  })

  it('v0.1 は難易度係数を 1.0 に固定する（FR-25 は v0.2）', () => {
    const { score } = calculateScore({ outcomes: allAsked(), reachedGate: 'B' })
    expect(score.difficultyFactor).toBe(1.0)
    expect(score.timeIndex).toBeNull()
  })

  it('算出根拠を必ず返す（NFR-F1: 説明できない数値を評価に使わせない）', () => {
    const { explanation } = calculateScore({ outcomes: allAsked(), reachedGate: 'B' })
    expect(explanation.breakdown).toHaveLength(STAGES.length)
    expect(explanation.formula).toContain('gate_factor')
    for (const row of explanation.breakdown) {
      expect(row.base * row.hintPenalty * row.difficultyFactor).toBeCloseTo(row.result, 0)
    }
  })

  it('同じ入力からは常に同じスコアが出る（NFR-Q4）', () => {
    const input = { outcomes: allAsked({ hintLevel: 2, attempts: 2 }), reachedGate: 'B' as const }
    expect(calculateScore(input).score).toEqual(calculateScore(input).score)
  })
})

describe('weakestAxis', () => {
  it('最も低い軸を返す', () => {
    expect(
      weakestAxis({ observe: 88, localize: 71, hypothesize: 76, verify: 58, fix: 72 }),
    ).toBe('verify')
  })
})
