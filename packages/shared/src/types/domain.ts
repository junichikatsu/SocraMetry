/**
 * ドメインの基本語彙。
 *
 * ここに定義するのは **公開してよい概念だけ**。
 * 内部診断（rootCause / evidence / confidence）と正解（correctOptionId）は
 * このパッケージに一切定義しない。型で漏洩を防ぐのが ADR-005 の実装上の担保であり、
 * 「気をつける」ではなく「書けない」状態にしておく（api-spec.md §1 ★）。
 */

/** 3 ゲート方式のゲート（socratic-engine.md §0） */
export type Gate = 'A' | 'B' | 'C'

/** Gate B の 5 段階。デバッグ脳スコアの 5 軸と 1 対 1 で対応する */
export type Stage = 'observe' | 'localize' | 'hypothesize' | 'verify' | 'fix'

/** Lv1 → Lv5 の順序。配列の順序がそのまま段階遷移の順序になる */
export const STAGES = ['observe', 'localize', 'hypothesize', 'verify', 'fix'] as const

/** 利用モード。v0.1 は live のみ（assessment は v0.2 / F16 Won't） */
export type SessionMode = 'live' | 'assessment'

export type SessionStatus = 'active' | 'completed' | 'abandoned'

/** 先行診断の状態（ADR-006 の同期用） */
export type DiagnosisStatus = 'pending' | 'ready' | 'failed'

export type Difficulty = 'easy' | 'medium' | 'hard'

/** 原因宣言の到達判定（socratic-engine.md §4.2） */
export type Verdict = 'reached' | 'partial' | 'not_reached'

/** ヒントレベルは 0〜3。0 は「まだ何も開放していない」 */
export type HintLevel = 0 | 1 | 2 | 3

/** LLM の役割。コストログのキーになる（cost-model.md §4.1） */
export type LlmRole = 'diagnoser' | 'hinter' | 'questioner' | 'judge' | 'revealer' | 'reporter'

/** モデル階層。単価表と対応する（cost-model.md §4.2） */
export type ModelTier = 'cheap' | 'quality'
