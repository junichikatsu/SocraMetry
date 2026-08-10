/**
 * ULID の生成（data-model.md §2）。
 *
 * `sessionId` に ULID を使う理由は、**文字列としての辞書順 = 生成時刻順**になること。
 * データストアはサブキーを 1 つしか持てないため、
 * 「サブキー = `sessionId`」だけで ID 引き（A1）と新しい順の一覧（A2）が両立する。
 * `startedAt` を別のキーとして持つ必要がない。
 *
 * 外部ライブラリを入れないのは、依存を増やすことがそのまま ZIP に載る攻撃面を
 * 増やすことでもあるため（security.md §7）。26 文字の生成にライブラリは要らない。
 */

/** Crockford Base32。I / L / O / U を含まない（誤読を避けるため） */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ENCODING_LEN = 32
const TIME_LEN = 10
const RANDOM_LEN = 16

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

function encodeTime(now: number): string {
  let remaining = now
  let out = ''
  for (let i = 0; i < TIME_LEN; i += 1) {
    const mod = remaining % ENCODING_LEN
    out = ENCODING[mod] + out
    remaining = (remaining - mod) / ENCODING_LEN
  }
  return out
}

/** テストから差し替えられるようにしている（決定的な ID を作るため） */
export type RandomSource = (length: number) => Uint8Array

const defaultRandom: RandomSource = (length) => {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

export function ulid(now: number = Date.now(), random: RandomSource = defaultRandom): string {
  const bytes = random(RANDOM_LEN)
  let randomPart = ''
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    randomPart += ENCODING[(bytes[i] ?? 0) % ENCODING_LEN]
  }
  return encodeTime(now) + randomPart
}

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value)
}

/** ULID の先頭 10 文字から生成時刻を復元する。ログの突き合わせに使う */
export function ulidTime(id: string): number {
  let time = 0
  for (const char of id.slice(0, TIME_LEN)) {
    const index = ENCODING.indexOf(char)
    if (index < 0) return Number.NaN
    time = time * ENCODING_LEN + index
  }
  return time
}

/** ユーザー ID。`ownerId` の実体になる（data-model.md §3.9） */
export function newUserId(random: RandomSource = defaultRandom): string {
  const bytes = random(6)
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return `usr_${out}`
}
