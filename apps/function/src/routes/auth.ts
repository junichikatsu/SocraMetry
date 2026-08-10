import { loginRequestSchema, signupRequestSchema } from '@socrametry/shared'
import { Hono } from 'hono'
import { clearSessionCookie, issueSessionCookie, requireAuth, type AppEnv } from '../middleware/auth'
import { parseJson } from '../middleware/validate'
import { login, signup } from '../services/auth-service'

/**
 * サインアップ / ログイン（FR-31a）。
 * **認証不要で到達できるのはここと `/v1/health` だけ。**
 */
export const authRoutes = new Hono<AppEnv>()

authRoutes.post('/v1/auth/signup', async (c) => {
  const req = await parseJson(c, signupRequestSchema)
  const auth = await signup(req)
  await issueSessionCookie(c, auth)
  return c.json({ me: auth }, 201)
})

authRoutes.post('/v1/auth/login', async (c) => {
  const req = await parseJson(c, loginRequestSchema)
  const auth = await login(req)
  await issueSessionCookie(c, auth)
  return c.json({ me: auth })
})

/** Cookie を落とすだけ。JWT はステートレスなのでサーバ側に破棄する状態がない */
authRoutes.post('/v1/auth/logout', (c) => {
  clearSessionCookie(c)
  return c.json({ ok: true })
})

authRoutes.get('/v1/me', requireAuth, (c) => c.json({ me: c.get('auth') }))
