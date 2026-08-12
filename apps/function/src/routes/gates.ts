import {
  conclusionRequestSchema,
  retrospectRequestSchema,
  submitAnswerRequestSchema,
} from '@socrametry/shared'
import { Hono } from 'hono'
import type { AppEnv } from '../middleware/auth'
import { parseJson } from '../middleware/validate'
import {
  advanceToQuestions,
  declareConclusion,
  openHint,
  retrospect,
  reveal,
  runDiagnosis,
  submitAnswer,
} from '../services/session-service'
import { sessionIdOf } from './sessions'

/**
 * 3 ゲートの進行（api-spec.md §3.2〜3.7）。
 *
 * | パス | ゲート |
 * |---|---|
 * | `POST /diagnose` | 先行診断（ADR-006） |
 * | `POST /hints` | Gate A: ヒント開放 |
 * | `POST /advance` | Gate A → B |
 * | `POST /answers` | Gate B: 回答 |
 * | `POST /conclusion` | 原因宣言（A・B どちらからでも） |
 * | `POST /reveal` | Gate C: 解説 |
 * | `POST /retrospect` | Gate C 後の振り返り（必須） |
 */
export const gateRoutes = new Hono<AppEnv>()

/**
 * 先行診断。クライアントは投げっぱなしでよい（`fetch(...).catch(() => {})`）。
 * ここで待たせないことが NFR-P1（5 秒以内）を満たす鍵。
 */
gateRoutes.post('/v1/sessions/:id/diagnose', async (c) =>
  c.json(await runDiagnosis(c.get('auth'), sessionIdOf(c))),
)

gateRoutes.post('/v1/sessions/:id/hints', async (c) =>
  c.json(await openHint(c.get('auth'), sessionIdOf(c))),
)

gateRoutes.post('/v1/sessions/:id/advance', async (c) => {
  const result = await advanceToQuestions(c.get('auth'), sessionIdOf(c))
  // 設問がまだ作れない場合も**回答済みの状態は保存されている**ので 202 で待たせる
  return result.pending ? c.json(result, 202) : c.json(result)
})

gateRoutes.post('/v1/sessions/:id/answers', async (c) => {
  const req = await parseJson(c, submitAnswerRequestSchema)
  const result = await submitAnswer(c.get('auth'), sessionIdOf(c), req)
  // `202` はエラーではなく待機。回答は記録済みなので再送しても二重にならない
  return result.pending ? c.json(result, 202) : c.json(result)
})

gateRoutes.post('/v1/sessions/:id/conclusion', async (c) => {
  const req = await parseJson(c, conclusionRequestSchema)
  const result = await declareConclusion(c.get('auth'), sessionIdOf(c), req)
  return result.pending ? c.json(result, 202) : c.json(result)
})

gateRoutes.post('/v1/sessions/:id/reveal', async (c) =>
  c.json(await reveal(c.get('auth'), sessionIdOf(c))),
)

gateRoutes.post('/v1/sessions/:id/retrospect', async (c) => {
  const req = await parseJson(c, retrospectRequestSchema)
  return c.json(await retrospect(c.get('auth'), sessionIdOf(c), req))
})
