import type { ApiErrorCode } from '@socrametry/shared'
import { DataStoreError } from '@socrametry/datastore'
import { LlmError } from '@socrametry/llm'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

/**
 * 異常系の統一処理（F12 / FR-17 / api-spec.md §1）。
 *
 * **画面が止まらず、原因が表示される**ことが要件。
 * そのために「握りつぶさない」「入力値を漏らさない」の両方を満たす必要がある。
 *
 * ```ts
 * // ✗ 入力がそのままログに乗る
 * catch (e) { console.error('failed', { input: req.body, error: e }) }
 * // ✓ 入力の「形」だけを残す
 * catch (e) { console.error('failed', { errorTextLength: n, code: e.code }) }
 * ```
 */

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ApiErrorCode,
    message: string,
    readonly detail: unknown = null,
    /** `429` に付ける `Retry-After`（秒） */
    readonly retryAfterSec?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export const errors = {
  invalidInput: (message = '入力内容を確認してください', detail: unknown = null) =>
    new ApiError(400, 'INVALID_INPUT', message, detail),
  unauthenticated: (message = 'ログインが必要です') =>
    new ApiError(401, 'UNAUTHENTICATED', message),
  sessionNotFound: () =>
    new ApiError(404, 'SESSION_NOT_FOUND', 'セッションが見つかりません'),
  sessionCompleted: (message = 'このセッションは完了しています') =>
    new ApiError(409, 'SESSION_COMPLETED', message),
  hintExhausted: () =>
    new ApiError(409, 'HINT_EXHAUSTED', 'ヒントはこれ以上開放できません'),
  gateNotUnlocked: (message = 'まだこの操作は行えません') =>
    new ApiError(409, 'GATE_NOT_UNLOCKED', message),
  emailTaken: () =>
    new ApiError(409, 'EMAIL_TAKEN', 'このメールアドレスは既に登録されています'),
  invalidCredentials: () =>
    // どちらが違うかを返さない（アカウントの存在を推測させないため）
    new ApiError(401, 'INVALID_CREDENTIALS', 'メールアドレスまたはパスワードが違います'),
  invalidInviteCode: () =>
    new ApiError(403, 'INVALID_INVITE_CODE', '招待コードが違います'),
  rateLimited: (retryAfterSec: number) =>
    new ApiError(
      429,
      'RATE_LIMITED',
      'セッションの作成が上限に達しました。しばらく待ってから再度お試しください',
      null,
      retryAfterSec,
    ),
  tokenBudgetExceeded: () =>
    new ApiError(
      429,
      'TOKEN_BUDGET_EXCEEDED',
      'このセッションの利用量が上限に達しました。新しいセッションを開始してください',
    ),
  llmUnavailable: () =>
    new ApiError(
      503,
      'LLM_UNAVAILABLE',
      'AI の応答を取得できませんでした。少し待ってからもう一度お試しください',
    ),
  /**
   * `detail` に**どの操作がどう失敗したか**を載せる（値は載せない）。
   *
   * 「保存先に接続できません」だけでは、設定漏れ・接続不可・データストア側の
   * エラーのどれなのかが切り分けられず、FR-17（原因が表示される）を満たさない。
   * 載せるのは操作名・失敗の種別・例外クラス名だけで、
   * 送信したアイテムや鍵の値は含まない（security.md §2.3）。
   */
  dataStoreUnavailable: (detail: unknown = null) =>
    new ApiError(
      503,
      'DATASTORE_UNAVAILABLE',
      'データの保存先に接続できませんでした。少し待ってからもう一度お試しください',
      detail,
    ),
}

/**
 * 例外をレスポンスに写す。
 *
 * `LlmError` / `DataStoreError` を**ここで一括して変換する**のは、
 * 各ルートで try/catch を書くと変換漏れが起き、500 が素で出るため。
 * 500 が出た時点で「原因が表示される」（FR-17）が満たせなくなる。
 */
export function toErrorResponse(err: unknown, c: Context): Response {
  const apiError = normalize(err)

  // 運用ログ。**入力値を含めない**（security.md §2.3）
  const level = apiError.status >= 500 ? 'ERROR' : 'WARN'
  console.log(
    JSON.stringify({
      level,
      event: 'request.error',
      code: apiError.code,
      status: apiError.status,
      path: c.req.path,
      method: c.req.method,
      // 値を含まない識別子のみ（DataStoreError の operation / kind / errorName）
      ...(apiError.detail === null ? {} : { detail: apiError.detail }),
    }),
  )

  const headers: Record<string, string> = {}
  if (apiError.retryAfterSec !== undefined) {
    headers['Retry-After'] = String(apiError.retryAfterSec)
  }

  return c.json(
    {
      error: { code: apiError.code, message: apiError.message, detail: apiError.detail },
    },
    apiError.status,
    headers,
  )
}

function normalize(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  if (err instanceof LlmError) return errors.llmUnavailable()
  if (err instanceof DataStoreError) return errors.dataStoreUnavailable(err.toPublicDetail())

  // 想定外。**例外メッセージをレスポンスに載せない**（入力値が混じりうる）
  console.log(
    JSON.stringify({
      level: 'ERROR',
      event: 'unexpected.error',
      name: err instanceof Error ? err.name : typeof err,
    }),
  )
  return new ApiError(500, 'INTERNAL_ERROR', '処理中に問題が発生しました')
}
