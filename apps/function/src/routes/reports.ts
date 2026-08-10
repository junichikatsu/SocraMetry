import { listSessionsQuerySchema } from '@socrametry/shared'
import { Hono } from 'hono'
import type { AppEnv } from '../middleware/auth'
import { parseQuery } from '../middleware/validate'
import { getMyStats, getOrCreateReport, listMySessions } from '../services/report-service'
import { sessionIdOf } from './sessions'

/**
 * レポートと個人統計（api-spec.md §3.8〜3.10 / FR-23 / FR-24）。
 */
export const reportRoutes = new Hono<AppEnv>()

/** 初回のみ生成し `reports` に保存する。2 回目以降は LLM を呼ばない（冪等） */
reportRoutes.get('/v1/sessions/:id/report', async (c) =>
  c.json(await getOrCreateReport(c.get('auth'), sessionIdOf(c))),
)

reportRoutes.get('/v1/me/sessions', async (c) => {
  const query = parseQuery(c, listSessionsQuerySchema)
  return c.json(await listMySessions(c.get('auth'), query))
})

reportRoutes.get('/v1/me/stats', async (c) => c.json(await getMyStats(c.get('auth'))))
