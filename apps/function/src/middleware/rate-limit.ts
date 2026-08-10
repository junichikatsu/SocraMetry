import { ulidTime } from '@socrametry/core'
import { sessionRepo, type OwnerId } from '@socrametry/datastore'
import { sessionRateLimitPerHour } from '../config'
import { errors } from './error-handler'

/**
 * レート制限（NFR-O3 / F04 / security.md §6）。
 *
 * **フロントの制御は UX、サーバの制限が防御。**
 * 連打防止をフロントだけで実装すると、ボタンを押さずに直接 API を叩けば無効化できる。
 *
 * カウンタ専用のアイテムを持たない。**レート制限のためだけにアクセス枠（E4）を
 * 消費するのは本末転倒**であり、既存アイテムから判定できる範囲に留める（api-spec.md §5）。
 * `sessionId` は ULID なので、**ID そのものが作成時刻を持っている。**
 * 新しい順に N 件引いて、N 件目がまだ 1 時間以内なら上限に達している。
 */

const HOUR_MS = 60 * 60 * 1000

export async function assertSessionRateLimit(owner: OwnerId, now = Date.now()): Promise<void> {
  const limit = sessionRateLimitPerHour()
  const { sessions } = await sessionRepo.listSessions(owner, { limit })
  if (sessions.length < limit) return

  const oldest = sessions[sessions.length - 1]
  if (!oldest) return

  const oldestAt = ulidTime(oldest.sessionId)
  if (!Number.isFinite(oldestAt)) return

  const elapsed = now - oldestAt
  if (elapsed >= HOUR_MS) return

  throw errors.rateLimited(Math.ceil((HOUR_MS - elapsed) / 1000))
}
