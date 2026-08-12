import type { Gate, SessionActions, SessionStatus } from '@socrametry/shared'
import { canRequestHint, MAX_HINT_LEVEL } from './hint-policy'

/**
 * ゲート遷移（FR-07 / socratic-engine.md §7）。
 *
 * | # | 要点 |
 * |---|---|
 * | 1 | **前進は常にできる。** どのゲートでも「進む」導線を塞がない（P4） |
 * | 2 | **後戻りはできない。** Gate B に入った後に Gate A の評価は得られない |
 * | 3 | 時間経過による自動遷移を持つ。放置で業務が止まるのを避ける |
 * | 4 | **Gate C は必ず到達可能。** 永久に答えが得られない状態を作らない（P2） |
 */

/**
 * 遷移の待ち時間は**環境変数で持つ**（Q-3 / Q-4 は仮の値で先に実装する方針）。
 * デモ・ブース・実運用で必要な値が違い、実測で外れても直すのは設定 1 行で済む。
 */
export type GateTimeouts = {
  /** Gate A → B の自動遷移。ヒント Lv3 開放後にこの時間が経過したら進む */
  gateAMs: number
  /** Gate B → C の解放。セッション開始からこの時間が経過したら解放する */
  gateBMs: number
}

export const DEFAULT_GATE_TIMEOUTS: GateTimeouts = {
  gateAMs: 5 * 60 * 1000,
  gateBMs: 30 * 60 * 1000,
}

export type GateState = {
  gate: Gate
  status: SessionStatus
  hintLevel: number
  reachedGate: Gate | null
  startedAt: number
  /** 各ゲートに入った時刻。A は必ず入っている */
  gateEnteredAt: { A: number; B: number | null; C: number | null }
  /** Gate B を最終段階まで通過したか */
  allStagesPassed: boolean
  /** 同一段階で 3 回不正解になった段階の数。2 以上で「詰まり」と判定する */
  stuckStageCount: number
}

/**
 * 利用者の明示要求による Gate A → B。
 *
 * **回数制限を設けない。** 制限は「使うと損」という圧を作り、
 * evaluation-model.md §4.1 の歪み #1（詰まっても開示を使わず放置）を
 * Gate A で再現してしまう。自立性はヒント使用量で測れる。
 */
export function canAdvanceToQuestions(state: GateState): boolean {
  return state.status === 'active' && state.gate === 'A'
}

/**
 * 時間経過による Gate A → B が発火する**時刻**。発火しない状態なら null。
 *
 * 条件は「ヒント Lv3 まで開放**かつ**一定時間経過」。時間だけを条件にすると、
 * ヒントを読んでいる最中に勝手に設問へ送られる。
 *
 * **この関数があるのはクライアントに渡す値を作るため。**
 * Lambda は定期実行を持てないので、タイマーの置き場所はクライアントしかない（#20）。
 * そのとき渡すのは**「いつ」だけ**にする。条件式そのものを渡すと、
 * ゲート遷移規則（socratic-engine.md §7）がサーバとクライアントに分かれて必ずずれる。
 */
export function autoAdvanceAt(state: GateState, timeouts: GateTimeouts): number | null {
  if (!canAdvanceToQuestions(state)) return null
  if (state.hintLevel < MAX_HINT_LEVEL) return null
  return state.gateEnteredAt.A + timeouts.gateAMs
}

/**
 * 時間経過による Gate A → B。
 *
 * 判定は `autoAdvanceAt` に寄せてある。**条件を 2 箇所に書かない。**
 */
export function shouldAutoAdvanceToQuestions(
  state: GateState,
  now: number,
  timeouts: GateTimeouts,
): boolean {
  const at = autoAdvanceAt(state, timeouts)
  return at !== null && now >= at
}

export type RevealGateReason =
  | 'already_revealed'
  | 'all_stages_passed'
  | 'stuck'
  | 'timeout'
  | 'not_unlocked'
  | 'gate_a'
  | 'inactive'

/**
 * Gate C（開示）の解放判定。
 *
 * 解放されていない要求には `409 GATE_NOT_UNLOCKED` を返す（api-spec.md §3.7）。
 * **Gate A から直接は開示しない。** Gate A で開示できてしまうと、
 * 3 ゲートの段階構造そのものが成立しない。
 */
export function revealGateReason(
  state: GateState,
  now: number,
  timeouts: GateTimeouts,
): RevealGateReason {
  // 既に開示済みなら同じ内容を返す（冪等 / api-spec.md §4）
  if (state.gate === 'C') return 'already_revealed'
  if (state.status !== 'active') return 'inactive'
  if (state.gate === 'A') return 'gate_a'
  if (state.allStagesPassed) return 'all_stages_passed'
  if (state.stuckStageCount >= 2) return 'stuck'
  if (now - state.startedAt >= timeouts.gateBMs) return 'timeout'
  return 'not_unlocked'
}

export function canReveal(state: GateState, now: number, timeouts: GateTimeouts): boolean {
  const reason = revealGateReason(state, now, timeouts)
  return reason !== 'not_unlocked' && reason !== 'gate_a' && reason !== 'inactive'
}

/**
 * クライアントに返す「どのボタンを出してよいか」。
 *
 * 判定を**サーバが持つ**ことが重要。クライアントに条件式を置くと、
 * 遷移規則が 2 箇所に分かれて必ずずれる。
 */
export function computeActions(
  state: GateState,
  now: number,
  timeouts: GateTimeouts,
): SessionActions {
  const active = state.status === 'active'
  return {
    canRequestHint: canRequestHint(state),
    canAdvanceToQuestions: canAdvanceToQuestions(state),
    // 原因宣言は Gate A・B のどちらからでも行える（api-spec.md §3.6）
    canDeclareConclusion: active && state.gate !== 'C',
    canReveal: canReveal(state, now, timeouts),
  }
}
