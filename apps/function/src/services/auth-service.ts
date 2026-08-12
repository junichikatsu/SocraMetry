import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { newUserId } from '@socrametry/core'
import { userRepo, type UserItem } from '@socrametry/datastore'
import type { AuthContext, LoginRequest, SignupRequest } from '@socrametry/shared'
import { inviteCode } from '../config'
import { errors } from '../middleware/error-handler'

/**
 * 簡易認証（FR-31a / security.md §5）。
 *
 * ハッシュは `node:crypto` の scrypt。**外部依存ゼロ**で、Lambda に追加パッケージが要らない。
 * 依存を増やすことは、そのまま ZIP に載る攻撃面を増やすことでもある（security.md §7）。
 *
 * > パスワードを平文で保存しない、Cookie を HttpOnly にするといった基本は当然として、
 * > **この製品でいちばん守るべき資産は「ユーザーが貼り付けた業務コード」である。**
 * > 認証の強度より、入力の扱い（マスキング）の方が本質的に重要。
 */

const KEY_LEN = 64
const SALT_BYTES = 16

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, KEY_LEN).toString('hex')
}

/** ソルトはユーザーごとに生成する（同じパスワードが同じハッシュにならないように） */
function newSalt(): string {
  return randomBytes(SALT_BYTES).toString('hex')
}

/**
 * 比較は `timingSafeEqual` で行う。
 * 文字列の `===` は先頭から比較して早期に抜けるため、
 * 一致した長さが応答時間に現れる（タイミング攻撃）。
 */
function verifyPassword(password: string, user: UserItem): boolean {
  const candidate = Buffer.from(hashPassword(password, user.passwordSalt), 'hex')
  const stored = Buffer.from(user.passwordHash, 'hex')
  if (candidate.length !== stored.length) return false
  return timingSafeEqual(candidate, stored)
}

export async function signup(req: SignupRequest): Promise<AuthContext> {
  const expected = inviteCode()
  // 設定漏れで招待コード制が無効になる状態を作らない（config.ts の検査と対応）
  if (expected === '' || req.inviteCode !== expected) throw errors.invalidInviteCode()

  const existing = await userRepo.getUserByEmail(req.email)
  if (existing) throw errors.emailTaken()

  const salt = newSalt()
  const user: UserItem = {
    email: req.email,
    kind: 'account',
    // `userId` を別に持つのは、メール変更でキーが変わると過去のセッションが引けなくなるため
    userId: newUserId(),
    displayName: req.displayName,
    passwordHash: hashPassword(req.password, salt),
    passwordSalt: salt,
    status: 'active',
    createdAt: Date.now(),
    lastLoginAt: Date.now(),
  }
  await userRepo.putUser(user)

  return { userId: user.userId, email: user.email, displayName: user.displayName }
}

export async function login(req: LoginRequest): Promise<AuthContext> {
  const user = await userRepo.getUserByEmail(req.email)
  // 存在しない場合もパスワード不一致と同じ応答にする（アカウントの存在を漏らさない）
  if (!user || user.status !== 'active') throw errors.invalidCredentials()
  if (!verifyPassword(req.password, user)) throw errors.invalidCredentials()

  // 最終ログイン時刻の更新に失敗しても、ログイン自体は成立させる
  try {
    await userRepo.putUser({ ...user, lastLoginAt: Date.now() })
  } catch {
    console.log(JSON.stringify({ level: 'WARN', event: 'user.last_login_update_failed' }))
  }

  return { userId: user.userId, email: user.email, displayName: user.displayName }
}
