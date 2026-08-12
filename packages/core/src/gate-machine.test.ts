import { describe, expect, it } from 'vitest'
import {
  autoAdvanceAt,
  canAdvanceToQuestions,
  canReveal,
  computeActions,
  DEFAULT_GATE_TIMEOUTS,
  revealGateReason,
  shouldAutoAdvanceToQuestions,
  type GateState,
} from './gate-machine'

const T0 = 1_786_000_000_000

function state(partial: Partial<GateState> = {}): GateState {
  return {
    gate: 'A',
    status: 'active',
    hintLevel: 1,
    reachedGate: null,
    startedAt: T0,
    gateEnteredAt: { A: T0, B: null, C: null },
    allStagesPassed: false,
    stuckStageCount: 0,
    ...partial,
  }
}

describe('Gate A → B', () => {
  it('利用者の明示要求はいつでも通る（回数制限を設けない）', () => {
    expect(canAdvanceToQuestions(state())).toBe(true)
    expect(canAdvanceToQuestions(state({ hintLevel: 0 }))).toBe(true)
  })

  it('Gate B に入った後は戻れない（後戻り禁止）', () => {
    expect(canAdvanceToQuestions(state({ gate: 'B' }))).toBe(false)
  })

  it('自動遷移はヒント Lv3 開放かつ一定時間経過の両方が必要', () => {
    const late = T0 + DEFAULT_GATE_TIMEOUTS.gateAMs
    expect(shouldAutoAdvanceToQuestions(state({ hintLevel: 2 }), late, DEFAULT_GATE_TIMEOUTS)).toBe(
      false,
    )
    expect(shouldAutoAdvanceToQuestions(state({ hintLevel: 3 }), T0, DEFAULT_GATE_TIMEOUTS)).toBe(
      false,
    )
    expect(shouldAutoAdvanceToQuestions(state({ hintLevel: 3 }), late, DEFAULT_GATE_TIMEOUTS)).toBe(
      true,
    )
  })

  /**
   * クライアントにタイマーを置くための値（#20）。**条件はサーバに残す**ため、
   * 渡すのは「いつ」だけ。ここが null なら、クライアントはタイマーを張らない。
   */
  describe('autoAdvanceAt — クライアントに渡す発火時刻', () => {
    it('ヒントが Lv3 に達していなければ発火しない', () => {
      expect(autoAdvanceAt(state({ hintLevel: 2 }), DEFAULT_GATE_TIMEOUTS)).toBeNull()
    })

    it('Lv3 まで開放していれば、Gate A に入った時刻 + 待ち時間を返す', () => {
      expect(autoAdvanceAt(state({ hintLevel: 3 }), DEFAULT_GATE_TIMEOUTS)).toBe(
        T0 + DEFAULT_GATE_TIMEOUTS.gateAMs,
      )
    })

    it('Gate B に入った後・完了後は発火しない', () => {
      expect(autoAdvanceAt(state({ gate: 'B', hintLevel: 3 }), DEFAULT_GATE_TIMEOUTS)).toBeNull()
      expect(
        autoAdvanceAt(state({ status: 'completed', hintLevel: 3 }), DEFAULT_GATE_TIMEOUTS),
      ).toBeNull()
    })

    it('shouldAutoAdvanceToQuestions と食い違わない（条件を 2 箇所に書かない）', () => {
      for (const hintLevel of [0, 1, 2, 3]) {
        for (const offset of [0, DEFAULT_GATE_TIMEOUTS.gateAMs]) {
          const s = state({ hintLevel })
          const at = autoAdvanceAt(s, DEFAULT_GATE_TIMEOUTS)
          expect(shouldAutoAdvanceToQuestions(s, T0 + offset, DEFAULT_GATE_TIMEOUTS)).toBe(
            at !== null && T0 + offset >= at,
          )
        }
      }
    })
  })
})

describe('Gate B → C', () => {
  const inB = (partial: Partial<GateState> = {}) =>
    state({ gate: 'B', gateEnteredAt: { A: T0, B: T0 + 1000, C: null }, ...partial })

  it('Gate A から直接は開示できない（3 ゲート構造が崩れる）', () => {
    expect(revealGateReason(state(), T0, DEFAULT_GATE_TIMEOUTS)).toBe('gate_a')
    expect(canReveal(state(), T0, DEFAULT_GATE_TIMEOUTS)).toBe(false)
  })

  it('条件を満たさない要求は not_unlocked（409 GATE_NOT_UNLOCKED）', () => {
    expect(revealGateReason(inB(), T0 + 1000, DEFAULT_GATE_TIMEOUTS)).toBe('not_unlocked')
  })

  it('全段階を通過しても未到達なら解放する', () => {
    expect(canReveal(inB({ allStagesPassed: true }), T0, DEFAULT_GATE_TIMEOUTS)).toBe(true)
  })

  it('2 段階以上で詰まったら解放する', () => {
    expect(canReveal(inB({ stuckStageCount: 1 }), T0, DEFAULT_GATE_TIMEOUTS)).toBe(false)
    expect(canReveal(inB({ stuckStageCount: 2 }), T0, DEFAULT_GATE_TIMEOUTS)).toBe(true)
  })

  it('一定時間が経てば必ず解放する（Gate C は必ず到達可能 / P2）', () => {
    const late = T0 + DEFAULT_GATE_TIMEOUTS.gateBMs
    expect(canReveal(inB(), late, DEFAULT_GATE_TIMEOUTS)).toBe(true)
  })

  it('開示済みなら同じ内容を返す（冪等）', () => {
    expect(revealGateReason(state({ gate: 'C' }), T0, DEFAULT_GATE_TIMEOUTS)).toBe(
      'already_revealed',
    )
  })
})

describe('computeActions', () => {
  it('Gate A の初期状態：ヒント要求・設問へ進む・原因宣言が可能で、開示は塞がっている', () => {
    expect(computeActions(state(), T0, DEFAULT_GATE_TIMEOUTS)).toEqual({
      canRequestHint: true,
      canAdvanceToQuestions: true,
      canDeclareConclusion: true,
      canReveal: false,
    })
  })

  it('ヒントを 3 まで開放したら追加要求はできない', () => {
    const actions = computeActions(state({ hintLevel: 3 }), T0, DEFAULT_GATE_TIMEOUTS)
    expect(actions.canRequestHint).toBe(false)
  })

  it('完了済みセッションでは操作を出さない', () => {
    const actions = computeActions(
      state({ status: 'completed', reachedGate: 'B', gate: 'B' }),
      T0,
      DEFAULT_GATE_TIMEOUTS,
    )
    expect(actions).toEqual({
      canRequestHint: false,
      canAdvanceToQuestions: false,
      canDeclareConclusion: false,
      canReveal: false,
    })
  })
})
