import { z } from 'zod'

/**
 * 簡易認証（FR-31a / security.md §5）。
 * メール + パスワード + 招待コード。組織・ロール・テナントの概念は持たない。
 */

/** メールアドレスはデータストアの**メインキー**になるため、正規化して受け取る */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'メールアドレスの形式が不正です')

/**
 * 8 文字以上（security.md §5）。
 * 上限を設けているのは scrypt の計算時間を入力で伸ばされないようにするため。
 */
export const passwordSchema = z.string().min(8, 'パスワードは 8 文字以上にしてください').max(200)

export const signupRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(40),
  /** 招待コード必須。公開 URL に無制限のサインアップを置かない（security.md §5） */
  inviteCode: z.string().min(1, '招待コードを入力してください').max(200),
})

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
})

export type SignupRequest = z.infer<typeof signupRequestSchema>
export type LoginRequest = z.infer<typeof loginRequestSchema>

/**
 * セッション Cookie（JWT）のペイロード。
 * v0.1 は `tenantId` / `role` を持たない。持たせると
 * 「テナント分離が実装済み」と誤読される（requirements.md FR-31a の注記）。
 */
export type AuthContext = {
  userId: string
  email: string
  displayName: string
}
