import type { SessionItem, TurnItem } from '@socrametry/datastore'
import type { GateState } from '@socrametry/core'
import { autoAdvanceAt, indexOfStage } from '@socrametry/core'
import type { QuestionPublic, SessionPublic, SessionSummaryPublic } from '@socrametry/shared'
import { gateTimeouts } from '../config'

/**
 * データストアのアイテムを公開型に写す層。
 *
 * **アイテムをそのまま返さない。** `sessions` は答えを持たない設計なので
 * そのまま返しても漏れないが（ADR-005）、内部フィールド（`stuckStages` /
 * `tokenUsed` / `stageResults`）は API 契約に含めるべきものではない。
 * ここを通すことで「レスポンスに何が載るか」が 1 箇所で読める。
 */

export function questionIdOf(sessionId: string, seq: number): string {
  return `${sessionId}#${seq}`
}

export function parseQuestionId(questionId: string): { sessionId: string; seq: number } | null {
  const [sessionId, rawSeq] = questionId.split('#')
  const seq = Number.parseInt(rawSeq ?? '', 10)
  if (!sessionId || !Number.isInteger(seq)) return null
  return { sessionId, seq }
}

export function toSessionPublic(session: SessionItem, now: number = Date.now()): SessionPublic {
  const advanceAt = autoAdvanceAt(gateStateOf(session), gateTimeouts())
  return {
    id: session.sessionId,
    mode: session.mode,
    status: session.status,
    gate: session.gate,
    hintLevel: session.hintLevel,
    currentStage: session.currentStage,
    stageIndex: session.currentStage ? indexOfStage(session.currentStage) : null,
    totalStages: session.totalStages,
    diagnosisStatus: session.diagnosisStatus,
    reachedGate: session.reachedGate,
    startedAt: session.startedAt,
    // 残り時間に直してから渡す。クライアントの時計とのずれを持ち込まない
    autoAdvanceInMs: advanceAt === null ? null : Math.max(0, advanceAt - now),
  }
}

export function toQuestionPublic(sessionId: string, turn: TurnItem): QuestionPublic {
  return {
    id: questionIdOf(sessionId, turn.seq),
    stage: turn.stage,
    seqInStage: turn.seqInStage,
    body: turn.body,
    options: turn.options,
  }
}

/** 履歴一覧の 1 行（api-spec.md §3.9） */
export function toSessionSummary(
  session: SessionItem,
  totalScore: number | null,
): SessionSummaryPublic {
  return {
    id: session.sessionId,
    // 一覧の見出しはエラーの 1 行目。本文全体を返して一覧を重くしない
    summary: session.errorText.split('\n')[0]?.slice(0, 120) ?? '',
    language: session.language,
    mode: session.mode,
    status: session.status,
    reachedGate: session.reachedGate,
    totalScore,
    startedAt: session.startedAt,
  }
}

/** ゲート遷移の判定に必要な状態だけを取り出す（`core` は永続化の形を知らない） */
export function gateStateOf(session: SessionItem): GateState {
  const answered = session.turns.filter((t) => t.kind === 'question' && t.answeredAt !== undefined)
  const lastStage = session.currentStage
  return {
    gate: session.gate,
    status: session.status,
    hintLevel: session.hintLevel,
    reachedGate: session.reachedGate,
    startedAt: session.startedAt,
    gateEnteredAt: session.gateEnteredAt,
    // 最終段階まで通過したか。`currentStage` が null になるのは Gate B を抜けたとき
    allStagesPassed: session.gate === 'B' && lastStage === null && answered.length > 0,
    stuckStageCount: session.stuckStages.length,
  }
}

/** 最後に出題され、まだ回答されていないターン */
export function pendingQuestion(session: SessionItem): TurnItem | null {
  for (let i = session.turns.length - 1; i >= 0; i -= 1) {
    const turn = session.turns[i]
    if (turn && turn.kind === 'question' && turn.answeredAt === undefined) return turn
  }
  return null
}

export function findTurn(session: SessionItem, seq: number): TurnItem | null {
  return session.turns.find((t) => t.seq === seq) ?? null
}
