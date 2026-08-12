import type { Context } from 'hono'
import type { ZodType } from 'zod'
import { errors } from './error-handler'

/**
 * 入力検証（F05 / security.md §2.2）。
 *
 * **サーバ側で必ず検証する。** フロントの検証は UX のためのものであり防御ではない。
 * スキーマは `@socrametry/shared` にあり、FE と BE が同じ定義を参照する。
 */

/** Zod の失敗内容を、入力値を含めない形に落とす */
function issuesOf(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): unknown {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }))
}

export async function parseJson<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw errors.invalidInput('リクエストの形式が不正です')
  }

  const result = schema.safeParse(body)
  if (!result.success) throw errors.invalidInput('入力内容を確認してください', issuesOf(result.error))
  return result.data
}

export function parseQuery<T>(c: Context, schema: ZodType<T>): T {
  const result = schema.safeParse(c.req.query())
  if (!result.success) throw errors.invalidInput('クエリパラメータが不正です', issuesOf(result.error))
  return result.data
}
