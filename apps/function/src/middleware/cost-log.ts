import { opsRepo, type OpsLogItem } from '@socrametry/datastore'
import type { LlmCallMeta } from '@socrametry/llm'
import { opsLogEnabled } from '../config'

/**
 * 1 リクエスト単価のログ出力（F11 / FR-28 / cost-model.md §4）。
 *
 * 出力先は 2 つ。
 *
 * | 先 | いつ |
 * |---|---|
 * | 実行環境の標準ログ（構造化 JSON） | **常時**。運用時の監視 |
 * | `ops_logs` テーブル | `OPS_LOG_ENABLED=true` のとき。実測コスト表の集計に使う |
 *
 * **PII は記録しない。** エラーテキストの本文は出さず、
 * 役割・モデル・トークン数・推定単価だけを残す（security.md §2.3）。
 */

/**
 * コストログの書き込みは**失敗してもリクエストを落とさない**。
 * ログのためにユーザーの操作が失敗するのは本末転倒であり、
 * かつ `ops_logs` はアクセス枠（E4）を消費するので、
 * 枠切れがそのまま機能停止になってはならない。
 */
export async function recordLlmCalls(sessionId: string, calls: readonly LlmCallMeta[]): Promise<void> {
  for (const call of calls) {
    console.log(
      JSON.stringify({
        type: 'llm_call',
        sessionId,
        role: call.role,
        model: call.model,
        tier: call.tier,
        promptTokens: call.promptTokens,
        completionTokens: call.completionTokens,
        latencyMs: call.latencyMs,
        estimatedCostUsd: call.estimatedCostUsd,
        estimatedCostJpy: call.estimatedCostJpy,
        orcaHeaders: call.orcaHeaders,
        leakGuardHit: call.leakGuardHit,
        fallbackUsed: call.fallbackUsed,
        mocked: call.mocked,
        error: call.error,
        ts: Date.now(),
      }),
    )
  }

  if (!opsLogEnabled()) return
  // MOCK モードの呼び出しはデータストアに残さない。
  // 実測コスト表（F11）に 0 円の行が混ざると、平均が実態からずれる
  const persisted = calls.filter((call) => !call.mocked)
  if (persisted.length === 0) return

  try {
    for (const [index, call] of persisted.entries()) {
      const item: OpsLogItem = {
        sessionId,
        // サブキーは数値。同一ミリ秒での衝突を避けるため index をずらして加える
        ts: Date.now() + index,
        role: call.role,
        model: call.model,
        tier: call.tier,
        promptTokens: call.promptTokens,
        completionTokens: call.completionTokens,
        latencyMs: call.latencyMs,
        estimatedCostUsd: call.estimatedCostUsd,
        estimatedCostJpy: call.estimatedCostJpy,
        orcaHeaders: call.orcaHeaders,
        leakGuardHit: call.leakGuardHit,
        error: call.error,
      }
      await opsRepo.putOpsLog(item)
    }
  } catch {
    console.log(
      JSON.stringify({ level: 'WARN', event: 'ops_log.write_failed', sessionId }),
    )
  }
}

/** セッション完了時のサマリ（cost-model.md §4.1）。実測コスト表の 1 行になる */
export function logSessionCost(params: {
  sessionId: string
  reachedGate: string | null
  calls: readonly LlmCallMeta[]
}): void {
  const totals = params.calls.reduce(
    (acc, call) => ({
      prompt: acc.prompt + call.promptTokens,
      completion: acc.completion + call.completionTokens,
      usd: acc.usd + (call.estimatedCostUsd ?? 0),
      jpy: acc.jpy + (call.estimatedCostJpy ?? 0),
      quality: acc.quality + (call.tier === 'quality' ? 1 : 0),
      cheap: acc.cheap + (call.tier === 'cheap' ? 1 : 0),
    }),
    { prompt: 0, completion: 0, usd: 0, jpy: 0, quality: 0, cheap: 0 },
  )

  console.log(
    JSON.stringify({
      type: 'session_cost',
      sessionId: params.sessionId,
      reachedGate: params.reachedGate,
      calls: { quality: totals.quality, cheap: totals.cheap },
      tokens: { prompt: totals.prompt, completion: totals.completion },
      costUsd: totals.usd,
      costJpy: totals.jpy,
      ts: Date.now(),
    }),
  )
}

/** 消費トークン数の合計。セッションのトークン予算（NFR-C1）に加算する */
export function totalTokens(calls: readonly LlmCallMeta[]): number {
  return calls.reduce((sum, call) => sum + call.promptTokens + call.completionTokens, 0)
}
