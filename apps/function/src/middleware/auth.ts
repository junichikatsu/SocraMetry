import type { AuthContext } from '@socrametry/shared'
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { sign, verify } from 'hono/jwt'
import { jwtSecret } from '../config'
import { ApiError, errors } from './error-handler'

/**
 * 認証（FR-31a / security.md §5）。
 *
 * JWT (HS256) を **HttpOnly / SameSite=Lax** の Cookie に入れる。
 * ステートレスなので Lambda と相性がよく、セッションストアを持たなくて済む。
 *
 * **`SameSite=None` にしない。** フロントを関数から同一オリジンで配信するため
 * `Lax` で足りる（ADR-012）。`None` は `Secure` 必須で環境差に弱い。
 *
 * v0.1 は `tenantId` / `role` を持たない。持たせるとテナント分離（NFR-S5）が
 * 実装済みだと誤読される（requirements.md FR-31a）。
 */

export const SESSION_COOKIE = 'sm_session'
const TTL_SEC = 24 * 60 * 60

/**
 * 署名アルゴリズムを**明示する。**
 * 検証側でトークンの `alg` ヘッダを信用すると、`none` や非対称鍵への
 * すり替え（アルゴリズム混同）を受けうる。ここを固定すれば成立しない。
 */
const ALG = 'HS256' as const

type JwtPayload = AuthContext & { exp: number }

/** hono の型に認証コンテキストを載せる */
export type AppEnv = { Variables: { auth: AuthContext } }

/**
 * Cookie の適用範囲を**トリガーのパス配下に絞る**。
 *
 * enebular のクラウド実行環境は 1 ホストを複数インスタンスがパスで分け合う。
 * `Path=/` のままだと、同じホストの別パスに載っている**他の関数にも
 * `sm_session` が送信される**。`HttpOnly` は JS からの読み取りを防ぐだけで、
 * サーバへ送られること自体は止められないため、同居する第三者に JWT が渡る。
 * `SameSite=Lax` も同一サイト（`enebular.com`）内では効かない。
 *
 * トリガーのパスは設定として持たない（ADR-009）ので、**リクエストのパスから導く。**
 * アプリのルートはすべて `/v1/...` なので、先頭が `v1` でなければ
 * それがトリガーのパスである。
 */
export function cookiePath(c: Context): string {
  const segments = c.req.path.split('/').filter((segment) => segment !== '')
  const base = segments[0]
  if (base === undefined || base === 'v1') return '/'
  return `/${base}`
}

export async function issueSessionCookie(c: Context, auth: AuthContext): Promise<void> {
  const secret = jwtSecret()
  // 設定漏れを「保存先に接続できない」等の別の原因に見せない。
  // 切り分けにかかる時間がそのまま損失になるため、原因はそのまま出す
  // （キーの値は出さない / `/v1/health` の configOk と対応する）
  if (secret === '') {
    throw new ApiError(503, 'INTERNAL_ERROR', 'サーバの認証設定が未完了です（SESSION_JWT_SECRET）')
  }

  const exp = Math.floor(Date.now() / 1000) + TTL_SEC
  const token = await sign({ ...auth, exp } satisfies JwtPayload, secret, ALG)

  const path = cookiePath(c)
  // 以前 `Path=/` で発行した Cookie が残っていると、2 つ送られて
  // どちらが使われるかが曖昧になる。新しく発行する前に消す
  if (path !== '/') deleteCookie(c, SESSION_COOKIE, { path: '/' })

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path,
    maxAge: TTL_SEC,
    // ローカル開発（http://localhost）では Secure な Cookie がブラウザに保存されない。
    // 実際のスキームを見て決めることで、本番は Secure・ローカルは動く状態を両立させる
    secure: new URL(c.req.url).protocol === 'https:',
  })
}

export function clearSessionCookie(c: Context): void {
  const path = cookiePath(c)
  deleteCookie(c, SESSION_COOKIE, { path })
  // 過去に `Path=/` で発行したものも消す（移行期の取りこぼしを防ぐ）
  if (path !== '/') deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

/**
 * すべての API で認証を必須にする（`/v1/health` と `/v1/auth/*` を除く）。
 *
 * ここを通らない経路を作らないことが重要。認証を各ルートで書くと、
 * 追加したルートで**書き忘れる**（api-spec.md §1）。
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) throw errors.unauthenticated()

  const secret = jwtSecret()
  if (secret === '') throw errors.unauthenticated()

  try {
    const payload = (await verify(token, secret, ALG)) as unknown as JwtPayload
    if (!payload?.userId) throw errors.unauthenticated()
    c.set('auth', {
      userId: payload.userId,
      email: payload.email,
      displayName: payload.displayName,
    })
  } catch {
    // 期限切れ・改竄のどちらも同じ扱い。理由を返して探索の材料にしない
    throw errors.unauthenticated()
  }

  await next()
}
