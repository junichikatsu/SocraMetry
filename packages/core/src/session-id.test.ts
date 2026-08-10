import { describe, expect, it } from 'vitest'
import { isUlid, newUserId, ulid, ulidTime } from './session-id'

const fixedRandom = (length: number) => new Uint8Array(length).fill(0)

describe('ulid', () => {
  it('26 文字の Crockford Base32 になる', () => {
    const id = ulid()
    expect(id).toHaveLength(26)
    expect(isUlid(id)).toBe(true)
  })

  it('辞書順が生成時刻順になる（サブキー 1 つで新しい順の一覧が成立する）', () => {
    const older = ulid(1_786_000_000_000, fixedRandom)
    const newer = ulid(1_786_000_000_001, fixedRandom)
    expect(older < newer).toBe(true)
  })

  it('先頭 10 文字から生成時刻を復元できる', () => {
    const now = 1_786_000_000_000
    expect(ulidTime(ulid(now, fixedRandom))).toBe(now)
  })

  it('同じ時刻でも乱数部で衝突を避ける', () => {
    const a = ulid(1_786_000_000_000)
    const b = ulid(1_786_000_000_000)
    expect(a).not.toBe(b)
  })

  it('紛らわしい文字（I / L / O / U）を含まない', () => {
    expect(ulid()).not.toMatch(/[ILOU]/)
  })
})

describe('newUserId', () => {
  it('usr_ 接頭辞をつける（ownerId の実体になる）', () => {
    expect(newUserId(fixedRandom)).toBe('usr_000000000000')
    expect(newUserId()).toMatch(/^usr_[0-9a-f]{12}$/)
  })
})
