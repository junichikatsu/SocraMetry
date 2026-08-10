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
