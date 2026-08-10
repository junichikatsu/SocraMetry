import { z } from 'zod'
import { frameworkSchema, languageSchema } from './common'

/**
 * セッション作成（api-spec.md §3.1 / FR-01）。
 *
 * 文字数上限は UX のためだけではない。**LLM への入力トークン数の上限**であり、
 * そのままコストの上限になる（security.md §2.2）。
 * 入力バリデーションとコスト管理がここで一致している。
 */
export const createSessionRequestSchema = z.object({
  /**
   * v0.1 は `live`（実務モード）のみ。`assessment` は問題集（FR-34）が前提のため v0.2。
   * スキーマ上は両方を受け、v0.2 未実装であることは
   * ルート側で明示的なメッセージとして返す（Zod のエラー文だと理由が伝わらない）。
   */
  mode: z.enum(['live', 'assessment']).default('live'),

  errorText: z.string().min(1, 'エラーテキストを入力してください').max(20_000),
  codeSnippet: z.string().max(10_000).optional(),
  language: languageSchema.optional(),
  framework: frameworkSchema.optional(),
  recentChange: z.string().max(1_000).optional(),
})

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>

export const listSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** データストアの `startKey` をそのまま透過させる（api-spec.md §3.9） */
  startKey: z.string().max(500).optional(),
})

export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>
