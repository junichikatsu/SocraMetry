/**
 * `@socrametry/core` — ドメインロジック。
 *
 * **外部依存なし。LLM もデータストアも呼ばない**（NFR-Q2 / NFR-Q4）。
 * 段階遷移・ゲート遷移・スコアリング・LeakGuard・マスキングは、
 * すべて単体テストできる純関数として実装する。
 */

export * from './masking'
export * from './leak-guard'
export * from './question-shape'
export * from './gate-machine'
export * from './stage-machine'
export * from './hint-policy'
export * from './scoring'
export * from './session-id'
export * from './conclusion-input'
