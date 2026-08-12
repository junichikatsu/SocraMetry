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
      expect(row.base * row.hintPenalty * row.difficultyFactor).toBeCloseTo(row.result ?? 0, 0)
    }
  })

  /**
   * `DEMO_MAX_STAGES=3` の運用で実測したときに見つかった不具合。
   * 出題されない検証・修正を 0 点として合計に混ぜていたため、
   * **3 段階すべて正解しても総合が 49 点**になっていた。
   */
  describe('段階数を絞った運用（scope-v0.1 削る順序 #4）', () => {
    const threeStages = () =>
      STAGES.slice(0, 3).map((s) => outcome(s)).concat(
        STAGES.slice(3).map((s) => outcome(s, { asked: false, attempts: 0, solved: false })),
      )

    it('対象外の軸は 0 ではなく null（出題対象外）にする', () => {
      const { score } = calculateScore({
        outcomes: threeStages(),
        reachedGate: 'C',
        totalStages: 3,
      })
      expect(score.observe).toBe(100)
      expect(score.verify).toBeNull()
      expect(score.fix).toBeNull()
    })

    it('対象の軸だけで正規化する（3 段階すべて正解なら満点相当）', () => {
      const { score } = calculateScore({
        outcomes: threeStages(),
        reachedGate: 'C',
        totalStages: 3,
      })
      // 100 × gate_factor 0.75。0 点の軸に引きずられない
      expect(score.total).toBe(75)
    })

    it('対象外であることを算出根拠に明記する', () => {
      const { explanation } = calculateScore({
        outcomes: threeStages(),
        reachedGate: 'C',
        totalStages: 3,
      })
      const fix = explanation.breakdown.find((row) => row.axis === 'fix')
      expect(fix?.result).toBeNull()
      expect(fix?.weight).toBe(0)
      expect(fix?.note).toContain('対象外')
    })

    it('既定（5 段階）では従来どおり全軸を採点する', () => {
      const { score } = calculateScore({ outcomes: allAsked(), reachedGate: 'B' })
      expect(score.fix).toBe(100)
      expect(score.total).toBe(90)
    })
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

  /** 出題していない軸を「弱点」として提示すると、示唆そのものが誤りになる */
  it('出題対象外（null）の軸は候補に入れない', () => {
    expect(
      weakestAxis({ observe: 88, localize: 71, hypothesize: 76, verify: null, fix: null }),
    ).toBe('localize')
  })

  it('採点対象が 1 つも無ければ null', () => {
    expect(
      weakestAxis({ observe: null, localize: null, hypothesize: null, verify: null, fix: null }),
    ).toBeNull()
  })
})
