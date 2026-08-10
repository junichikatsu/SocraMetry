import type { ModelTier } from '@socrametry/shared'

/**
 * モデル別単価とコスト算出（F11 / cost-model.md §4.2）。
 *
 * **単価表はコードに持ち、モデル ID をキーにする。**
 * OrcaRouter がプロバイダをまたぐため、モデルを差し替えたら単価も自動で切り替わる。
 * 具体的な単価は OrcaRouter のカタログ（`GET /v1/models`）で確定する（未決 Q-1）。
 */

/** USD / 1M tokens */
export const PRICING: Record<string, { input: number; output: number; tier: ModelTier }> = {
  'openai/gpt-4o-mini': { input: 0.15, output: 0.6, tier: 'cheap' },
  'openai/gpt-4.1-mini': { input: 0.4, output: 1.6, tier: 'cheap' },
  'google/gemini-2.5-flash': { input: 0.3, output: 2.5, tier: 'cheap' },
  'anthropic/claude-haiku-4.5': { input: 1.0, output: 5.0, tier: 'cheap' },
  'anthropic/claude-sonnet-4.6': { input: 3.0, output: 15.0, tier: 'quality' },
  'openai/gpt-4.1': { input: 2.0, output: 8.0, tier: 'quality' },
}

/**
 * 推定コスト（USD）。
 *
 * **未知のモデルには `null` を返す。**「単価不明」と「無料」を区別するため。
 * 0 を返すと、コスト表に 0 円のセッションが並んで実測が壊れる。
 */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const p = PRICING[model]
  if (!p) return null
  return (promptTokens * p.input + completionTokens * p.output) / 1_000_000
}

export function estimateCostJpy(costUsd: number | null, usdJpyRate: number): number | null {
  if (costUsd === null) return null
  return costUsd * usdJpyRate
}

/**
 * モデル階層。単価表にないモデルは `cheap` と決めつけない。
 * 高品質モデルを安価と誤表示すると、コストログの意味が失われる。
 */
export function tierOf(model: string): ModelTier | 'unknown' {
  return PRICING[model]?.tier ?? 'unknown'
}
