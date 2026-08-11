import type { ModelTier } from '@socrametry/shared'

/**
 * モデル別単価とコスト算出（F11 / cost-model.md §4.2）。
 *
 * **単価表はコードに持ち、モデル ID をキーにする。**
 * OrcaRouter がプロバイダをまたぐため、モデルを差し替えたら単価も自動で切り替わる。
 *
 * ## 請求との突き合わせ（2026-08-12）
 *
 * 実際に使っている 2 モデル（`claude-sonnet-4.6` / `gpt-4o-mini`）について、
 * **8 セッション・52 回の呼び出しで OrcaRouter のクレジット消費と突き合わせた。**
 *
 * | | 推定 | 請求 |
 * |---|---:|---:|
 * | 4 セッション（1 回目） | 約 0.117 USD | 0.12 USD |
 * | 4 セッション（2 回目） | 0.1166 USD | 0.11 USD |
 * | **合計** | **約 0.233 USD** | **0.23 USD** |
 *
 * **差は 1.5% 以内。この 2 モデルの単価は正しい。**
 *
 * ★ **クレジット表示には反映の遅れがある。** 直後に読むと少なく見え、
 * 実際に $0.08 → $0.11 と変わった。計測時は少し待ってから読むこと。
 *
 * ## 未検証のモデル
 *
 * 下表のうち上記 2 つ以外は **Anthropic / OpenAI / Google の公表単価**であり、
 * OrcaRouter の課金額とは限らない。**使うモデルを変えたら突き合わせ直すこと。**
 */

/** USD / 1M tokens */
export const PRICING: Record<string, { input: number; output: number; tier: ModelTier }> = {
  'openai/gpt-4o-mini': { input: 0.15, output: 0.6, tier: 'cheap' }, // ★ 突き合わせ済み
  'openai/gpt-4.1-mini': { input: 0.4, output: 1.6, tier: 'cheap' },
  'google/gemini-2.5-flash': { input: 0.3, output: 2.5, tier: 'cheap' },
  'anthropic/claude-haiku-4.5': { input: 1.0, output: 5.0, tier: 'cheap' },
  'anthropic/claude-sonnet-4.6': { input: 3.0, output: 15.0, tier: 'quality' }, // ★ 突き合わせ済み
  'openai/gpt-4.1': { input: 2.0, output: 8.0, tier: 'quality' },
  /**
   * 場面別の使い分け（未決）で選ぶ可能性のあるモデル。
   * **決定してから足すと、コストログが `null` になって実測が取れない。**
   * 先に入れておく。
   */
  'anthropic/claude-sonnet-5': { input: 3.0, output: 15.0, tier: 'quality' },
  'anthropic/claude-opus-5': { input: 5.0, output: 25.0, tier: 'quality' },
  'anthropic/claude-opus-4.8': { input: 5.0, output: 25.0, tier: 'quality' },
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
