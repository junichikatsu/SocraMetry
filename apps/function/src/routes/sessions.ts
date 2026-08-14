import { createSessionRequestSchema, ulidSchema } from '@socrametry/shared'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../middleware/auth'
import { errors } from '../middleware/error-handler'
import { parseJson } from '../middleware/validate'
import {
  createSession,
  deleteSessionCascade,
  getSessionState,
  getTranscript,
} from '../services/session-service'

/**
 * セッションの作成・取得・削除（api-spec.md §2.1）。
 */
export const sessionRoutes = new Hono<AppEnv>()

/**
 * パスパラメータの `sessionId` を検証する。
 * 形式が不正なものをデータストアに渡さない（無駄なアクセスを 1 回消費しないため）。
 */
export function sessionIdOf(c: Context): string {
  const parsed = ulidSchema.safeParse(c.req.param('id'))
  if (!parsed.success) throw errors.sessionNotFound()
  return parsed.data
}

sessionRoutes.post('/v1/sessions', async (c) => {
  const req = await parseJson(c, createSessionRequestSchema)
  const result = await createSession(c.get('auth'), req)
  return c.json(result, 201)
})

/** 復帰用。リロードしても続きから戻れる */
sessionRoutes.get('/v1/sessions/:id', async (c) =>
  c.json(await getSessionState(c.get('auth'), sessionIdOf(c))),
)

/**
 * 中断したセッションを画面に組み直すための記録（#27）。
 * `sessions` に入っているものを時系列に並べ直したもの。
 */
sessionRoutes.get('/v1/sessions/:id/transcript', async (c) =>
  c.json(await getTranscript(c.get('auth'), sessionIdOf(c))),
)

/** 利用者が自分のデータを削除できる（NFR-S7） */
sessionRoutes.delete('/v1/sessions/:id', async (c) => {
  await deleteSessionCascade(c.get('auth'), sessionIdOf(c))
  return c.json({ ok: true })
})
