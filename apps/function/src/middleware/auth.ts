import type { AuthContext } from '@socrametry/shared'
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { sign, verify } from 'hono/jwt'
import { jwtSecret } from '../config'
import { errors } from './error-handler'

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

export async function issueSessionCookie(c: Context, auth: AuthContext): Promise<void> {
  const secret = jwtSecret()
  if (secret === '') throw errors.dataStoreUnavailable()

  const exp = Math.floor(Date.now() / 1000) + TTL_SEC
  const token = await sign({ ...auth, exp } satisfies JwtPayload, secret, ALG)

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: TTL_SEC,
    // ローカル開発（http://localhost）では Secure な Cookie がブラウザに保存されない。
    // 実際のスキームを見て決めることで、本番は Secure・ローカルは動く状態を両立させる
    secure: new URL(c.req.url).protocol === 'https:',
  })
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
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
