/**
 * 環境変数の設定漏れを検出する（deployment.md §6 のチェックリスト 5〜12 の自動化）。
 *
 * **値そのものは扱わない。** ここで判定するのは「設定されているか」だけで、
 * 検出結果に値を含めない。`/v1/health` は認証不要で公開されるため、
 * 公開側には真偽値と件数のみを返し、キー名は起動時のログにだけ出す。
 *
 * 何が必須かは動作モードで変わる（MOCK_MODE / OPS_LOG_ENABLED）。
 * 手作業のチェックリストではこの条件分岐を正しく回せないため、コードで持つ。
 */

/** `.env.example` の雛形のまま貼られたときに検出するための値 */
const PLACEHOLDER_TABLE_ID = '00000000-0000-0000-0000-000000000000'
const PLACEHOLDER_SECRET = 'change-me'

export type ConfigIssue = {
  key: string
  /** missing = 未設定 / placeholder = 雛形の値のまま */
  reason: 'missing' | 'placeholder'
}

import type { GateTimeouts } from '@socrametry/core'

type Env = Record<string, string | undefined>

function value(env: Env, key: string): string {
  return (env[key] ?? '').trim()
}

/**
 * 設定漏れの一覧を返す。空配列なら問題なし。
 *
 * @param env 既定は `process.env`。テストから差し替えられるようにしている
 */
export function checkConfig(env: Env = process.env): ConfigIssue[] {
  const issues: ConfigIssue[] = []

  const require_ = (key: string, placeholder?: string) => {
    const v = value(env, key)
    if (v === '') issues.push({ key, reason: 'missing' })
    else if (placeholder !== undefined && v === placeholder)
      issues.push({ key, reason: 'placeholder' })
  }

  // ── データストア（ADR-005 / data-model.md §2）──────────────────
  // DS_TABLE_SECRETS は答えを隔離しているテーブル。取り違えの影響が最も大きい
  for (const key of [
    'DS_TABLE_USERS',
    'DS_TABLE_SESSIONS',
    'DS_TABLE_SECRETS',
    'DS_TABLE_REPORTS',
  ]) {
    require_(key, PLACEHOLDER_TABLE_ID)
  }

  // ops_logs は書くときだけ要る（v0.1 は OPS_LOG_ENABLED=true / F11）
  if (value(env, 'OPS_LOG_ENABLED') === 'true') {
    require_('DS_TABLE_OPS_LOGS', PLACEHOLDER_TABLE_ID)
  }

  // ── 認証（security.md §5）────────────────────────────────────
  // 既定値のままだと招待コード制が実質無効になるため、未設定と同じ扱いにする
  require_('SESSION_JWT_SECRET', PLACEHOLDER_SECRET)
  require_('INVITE_CODE', PLACEHOLDER_SECRET)

  // ── LLM（MOCK_MODE のときは一切呼ばないので不要 / ADR-014）─────
  if (value(env, 'MOCK_MODE') !== 'true') {
    require_('ORCAROUTER_API_KEY')
    require_('MODEL_DIAGNOSER')
    require_('MODEL_QUESTIONER')
    require_('MODEL_JUDGE')
  }

  return issues
}

// ─────────────────────────────────────────────────────────────────────────────
//  アプリケーション設定
//
//  **読み取りは呼び出しのたびに行う。** モジュール読み込み時に固めると、
//  テストから `process.env` を差し替えても効かず、テストのために本番コードへ
//  注入口を増やすことになる。読み取りコストは無視できる。
// ─────────────────────────────────────────────────────────────────────────────

function intValue(env: Env, key: string, fallback: number): number {
  const parsed = Number.parseInt(value(env, key), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function isMockMode(env: Env = process.env): boolean {
  return value(env, 'MOCK_MODE') === 'true'
}

/**
 * 障害の詳細（外部サービスのエラーメッセージ）をレスポンスとログに出してよいか。
 *
 * security.md §2.3 は「デバッグに本文が必要な場面はあるが、それは開発環境
 * （`MOCK_MODE` または `LOG_LEVEL=DEBUG`）に限定し、本番では出さない」としている。
 * **その条件をそのままコードにしたもの。**
 *
 * 対象は外部サービスが返したメッセージであり、利用者の入力そのものではないが、
 * キーの値（メールアドレス）を含みうるため本番では伏せる。
 */
export function isDiagnosticsVerbose(env: Env = process.env): boolean {
  return isMockMode(env) || value(env, 'LOG_LEVEL').toUpperCase() === 'DEBUG'
}

/** セッション Cookie（JWT）の署名鍵（security.md §5） */
export function jwtSecret(env: Env = process.env): string {
  return value(env, 'SESSION_JWT_SECRET')
}

/** サインアップに必要な招待コード。LLM コストの流出防止も兼ねる（security.md §5） */
export function inviteCode(env: Env = process.env): string {
  return value(env, 'INVITE_CODE')
}

/**
 * ゲート遷移の待ち時間（未決 Q-3 / Q-4）。
 *
 * 確定を待つと実装が始まらないため、**仮の値で先に実装する**方針。
 * 設定にしてあるので、実測で外れても直すのは 1 行で済む。
 * デモ用プリセットは `GATE_A_TIMEOUT_MS=60000` / `GATE_B_TIMEOUT_MS=300000`。
 */
export function gateTimeouts(env: Env = process.env): GateTimeouts {
  return {
    gateAMs: intValue(env, 'GATE_A_TIMEOUT_MS', 5 * 60 * 1000),
    gateBMs: intValue(env, 'GATE_B_TIMEOUT_MS', 30 * 60 * 1000),
    /**
     * これを超えて操作がないセッションは再開させず `abandoned` にする。
     * 短い中断は差し引いて続きから再開できるが、何日も空いたものを
     * そのまま続けさせると、途中の記録が何を測ったものか分からなくなる。
     */
    abandonAfterMs: intValue(env, 'SESSION_ABANDON_AFTER_MS', 24 * 60 * 60 * 1000),
  }
}

/** Gate B の段階数。既定 5。デモで 3 に絞れる（roadmap.md 削る順序 #4） */
export function demoMaxStages(env: Env = process.env): number | undefined {
  const raw = value(env, 'DEMO_MAX_STAGES')
  if (raw === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 除外語リスト（FR-11）。社名・製品名を完全一致で伏せる */
export function maskWordsRaw(env: Env = process.env): string | undefined {
  const raw = value(env, 'MASK_WORDS')
  return raw === '' ? undefined : raw
}

/** 1 セッションの LLM トークン上限（NFR-C1）。超過で 429 を返して打ち切る */
export function sessionTokenBudget(env: Env = process.env): number {
  return intValue(env, 'SESSION_TOKEN_BUDGET', 80_000)
}

/** セッション作成のレート制限（NFR-O3） */
export function sessionRateLimitPerHour(env: Env = process.env): number {
  return intValue(env, 'RATE_LIMIT_SESSIONS_PER_HOUR', 10)
}

/**
 * コストログを `ops_logs` テーブルに書くか（F11 / data-model.md §3.8）。
 * **v0.1 は `true`**（実測コスト表を成果物とするため）。
 * 無効時も標準ログには必ず出す。
 */
export function opsLogEnabled(env: Env = process.env): boolean {
  return value(env, 'OPS_LOG_ENABLED') === 'true'
}

/**
 * 起動時（コールドスタート）に 1 回だけ呼ぶ。
 * キー名はここにしか出さない。リクエストごとには実行しない。
 */
export function logConfigIssues(env: Env = process.env): ConfigIssue[] {
  const issues = checkConfig(env)

  if (issues.length > 0) {
    console.warn(
      JSON.stringify({
        level: 'WARN',
        event: 'config.incomplete',
        message: '環境変数の設定が不足しています。クラウド実行環境の envVars を確認してください',
        count: issues.length,
        issues,
      }),
    )
  }

  return issues
}
