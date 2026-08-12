import { describe, expect, it } from 'vitest'
import {
  autoAdvanceAt,
  canAdvanceToQuestions,
  canReveal,
  computeActions,
  DEFAULT_GATE_TIMEOUTS,
  RESUME_GRACE_MS,
  resumeFrom,
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
    awayMs: 0,
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

/**
 * 中断の扱い（#27）。
 *
 * 2 つのタイマーはどちらも「詰まった人を助けるための安全弁」であって
 * 評価のための計測ではない。助ける対象は画面の前で詰まっている人なので、
 * 席を外していた時間を数えない。
 */
describe('中断していた時間を数えない', () => {
  const AWAY = 3 * 60 * 60 * 1000 // 3 時間

  it('Gate A → B: 中断のぶんだけ発火が後ろへずれる', () => {
    const fresh = state({ hintLevel: 3 })
    const resumed = state({ hintLevel: 3, awayMs: AWAY })

    expect(autoAdvanceAt(resumed, DEFAULT_GATE_TIMEOUTS)).toBe(
      (autoAdvanceAt(fresh, DEFAULT_GATE_TIMEOUTS) ?? 0) + AWAY,
    )
  })

  it('Gate A → B: 3 時間放置して開いた瞬間に設問へ飛ばされない', () => {
    const now = T0 + AWAY
    expect(
      shouldAutoAdvanceToQuestions(state({ hintLevel: 3, awayMs: AWAY }), now, DEFAULT_GATE_TIMEOUTS),
    ).toBe(false)
    // 中断を数えていた頃は、この条件で飛んでいた
    expect(shouldAutoAdvanceToQuestions(state({ hintLevel: 3 }), now, DEFAULT_GATE_TIMEOUTS)).toBe(
      true,
    )
  })

  it('Gate C: 一晩置いても解説は開かない（評価としての抜け道を塞ぐ）', () => {
    const now = T0 + AWAY
    const resumed = state({ gate: 'B', awayMs: AWAY })
    expect(revealGateReason(resumed, now, DEFAULT_GATE_TIMEOUTS)).toBe('not_unlocked')
    // 中断を数えなければ、実際に向き合った時間が溜まったときだけ開く
    expect(
      revealGateReason(resumed, now + DEFAULT_GATE_TIMEOUTS.gateBMs, DEFAULT_GATE_TIMEOUTS),
    ).toBe('timeout')
  })
})

describe('resumeFrom — 空白をどう扱うか', () => {
  it('ふつうの操作間隔は中断としない（設問を読む数十秒を中断にしない）', () => {
    expect(resumeFrom(T0, T0 + 30_000, DEFAULT_GATE_TIMEOUTS)).toEqual({ kind: 'continue' })
  })

  it('猶予を超えたら中断として差し引く', () => {
    const away = 10 * 60 * 1000
    expect(resumeFrom(T0, T0 + away, DEFAULT_GATE_TIMEOUTS)).toEqual({ kind: 'resume', awayMs: away })
  })

  it('打ち切りの時間を超えたら再開させない', () => {
    const away = DEFAULT_GATE_TIMEOUTS.abandonAfterMs
    expect(resumeFrom(T0, T0 + away, DEFAULT_GATE_TIMEOUTS)).toEqual({ kind: 'abandon', awayMs: away })
  })

  /** サーバ間の時計のずれで未来の値が入っても、時間が巻き戻ったことにしない */
  it('時計が巻き戻っても負の値を返さない', () => {
    expect(resumeFrom(T0, T0 - 60_000, DEFAULT_GATE_TIMEOUTS)).toEqual({ kind: 'continue' })
  })

  it('境界: 猶予ちょうどは中断、打ち切りちょうどは打ち切り', () => {
    expect(resumeFrom(T0, T0 + RESUME_GRACE_MS - 1, DEFAULT_GATE_TIMEOUTS).kind).toBe('continue')
    expect(resumeFrom(T0, T0 + RESUME_GRACE_MS, DEFAULT_GATE_TIMEOUTS).kind).toBe('resume')
    expect(
      resumeFrom(T0, T0 + DEFAULT_GATE_TIMEOUTS.abandonAfterMs - 1, DEFAULT_GATE_TIMEOUTS).kind,
    ).toBe('resume')
    expect(
      resumeFrom(T0, T0 + DEFAULT_GATE_TIMEOUTS.abandonAfterMs, DEFAULT_GATE_TIMEOUTS).kind,
    ).toBe('abandon')
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
