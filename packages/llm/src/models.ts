import type { LlmRole } from '@socrametry/shared'

/**
 * 用途別のモデル設定（FR-12 / F03 / cost-model.md §2）。
 *
 * **回数 × 単価で考えると、投資すべき場所と削るべき場所が自動的に決まる。**
 *
 * | 役割 | 階層 | 回数 / セッション |
 * |---|---|---|
 * | Diagnoser | 高品質 | 1 |
 * | Hinter | 安価 | 1 |
 * | Questioner | 安価 | 8〜12 |
 * | Judge | 安価 | 1〜3 |
 * | Revealer | 高品質 | 0〜1 |
 * | Reporter | 高品質 | 1 |
 *
 * 環境変数を**呼び出しのたびに読む**のは、テストから差し替えられるようにするため。
 * モジュール読み込み時に固めると、`process.env` を書き換えても効かない。
 */

function env(key: string, fallback = ''): string {
  return (process.env[key] ?? '').trim() || fallback
}

function intEnv(key: string, fallback: number): number {
  const parsed = Number.parseInt(env(key), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** 役割 → 環境変数。Revealer と Reporter は Diagnoser のモデルを再利用する */
const MODEL_ENV: Record<LlmRole, string> = {
  diagnoser: 'MODEL_DIAGNOSER',
  hinter: 'MODEL_QUESTIONER',
  questioner: 'MODEL_QUESTIONER',
  judge: 'MODEL_JUDGE',
  revealer: 'MODEL_DIAGNOSER',
  reporter: 'MODEL_DIAGNOSER',
}

/**
 * `max_tokens` は「必要な長さ」から決める。多めに取らない（cost-model.md §3）。
 * 上限に達した場合は生成失敗として扱う（途中で切れた JSON を無理に使わない）。
 */
const MAX_TOKENS_ENV: Record<LlmRole, { key: string; fallback: number }> = {
  diagnoser: { key: 'MAX_TOKENS_DIAGNOSER', fallback: 800 },
  hinter: { key: 'MAX_TOKENS_HINTER', fallback: 200 },
  questioner: { key: 'MAX_TOKENS_QUESTIONER', fallback: 500 },
  judge: { key: 'MAX_TOKENS_JUDGE', fallback: 300 },
  revealer: { key: 'MAX_TOKENS_REVEALER', fallback: 600 },
  reporter: { key: 'MAX_TOKENS_REPORTER', fallback: 800 },
}

export function modelFor(role: LlmRole): string {
  return env(MODEL_ENV[role])
}

export function maxTokensFor(role: LlmRole): number {
  const spec = MAX_TOKENS_ENV[role]
  return intEnv(spec.key, spec.fallback)
}

/** 失敗時の退避先。1 回だけ再試行する（NFR-O1） */
export function fallbackModel(): string | null {
  return env('MODEL_FALLBACK') || null
}

export function isMockMode(): boolean {
  return env('MOCK_MODE') === 'true'
}

export function orcaBaseUrl(): string {
  return env('ORCAROUTER_BASE_URL', 'https://api.orcarouter.ai/v1')
}

export function orcaApiKey(): string {
  return env('ORCAROUTER_API_KEY')
}

export function usdJpyRate(): number {
  return intEnv('USD_JPY_RATE', 150)
}

/**
 * 温度。**出題と判定は低め**にする。
 * 制約遵守（socratic-engine.md §3 の C1〜C7）が要求されるため、
 * 発散させると LeakGuard の再生成が増えてかえって遅く高くなる。
 */
export function temperatureFor(role: LlmRole): number {
  return role === 'diagnoser' || role === 'reporter' || role === 'revealer' ? 0.3 : 0.2
}
