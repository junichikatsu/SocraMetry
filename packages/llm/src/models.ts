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
 *
 * **既定値は実測で引き上げた。** cost-model.md の当初の見積もりは英語基準で、
 * 日本語は 1 文字あたりのトークン消費が大きい。実際に Diagnoser が 800 では
 * 収まらず、`max_tokens reached` で 2 モデルとも失敗した。
 *
 * > **上限を上げてもコストは増えない。** これは上限であって使用量ではなく、
 * > 実際の課金は生成された長さで決まる。**足りないと全額が無駄になる**
 * > （切れた JSON は使えないのに、そこまでのトークンは課金される）ため、
 * > 必要な長さより少し余裕を持たせる方が安い。
 */
const MAX_TOKENS_ENV: Record<LlmRole, { key: string; fallback: number }> = {
  // rootCause + evidence 5 + focusHints 5 + distractorThemes 6 + gateAHints 3。
  // 出力項目が最も多い役割で、gateAHints を同じ呼び出しで返す設計（NFR-C5）の分も要る
  diagnoser: { key: 'MAX_TOKENS_DIAGNOSER', fallback: 1600 },
  hinter: { key: 'MAX_TOKENS_HINTER', fallback: 300 },
  // 設問 1 文 + 選択肢 5 + 誤答ごとの誘導文 4
  questioner: { key: 'MAX_TOKENS_QUESTIONER', fallback: 900 },
  judge: { key: 'MAX_TOKENS_JUDGE', fallback: 500 },
  revealer: { key: 'MAX_TOKENS_REVEALER', fallback: 1000 },
  reporter: { key: 'MAX_TOKENS_REPORTER', fallback: 1000 },
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

/**
 * 円換算レート。
 *
 * **既定値は実行環境の設定と揃える。** 既定 150 / 実行環境 165 という状態で、
 * 設計書の円が 150 換算と 165 換算で混在した（レビューで指摘されて発覚）。
 * 既定と本番がずれていると、どちらの数字を見ているのか誰にも分からなくなる。
 *
 * 効いている値は `GET /v1/health` の `limits.usdJpyRate` で確認できる。
 */
export function usdJpyRate(): number {
  return intEnv('USD_JPY_RATE', 165)
}

/**
 * 温度。**出題と判定は低め**にする。
 * 制約遵守（socratic-engine.md §3 の C1〜C7）が要求されるため、
 * 発散させると LeakGuard の再生成が増えてかえって遅く高くなる。
 */
export function temperatureFor(role: LlmRole): number {
  return role === 'diagnoser' || role === 'reporter' || role === 'revealer' ? 0.3 : 0.2
}
