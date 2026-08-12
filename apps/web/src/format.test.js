// @ts-check
import { describe, expect, it } from 'vitest'
import { retryLabel } from './format.js'

describe('retryLabel — 429 の待ち時間', () => {
  it('分に切り上げる（切り捨てると、その時刻に試してまだ弾かれる）', () => {
    expect(retryLabel(60)).toBe('あと約 1 分で再開できます。')
    expect(retryLabel(61)).toBe('あと約 2 分で再開できます。')
    expect(retryLabel(1382)).toBe('あと約 24 分で再開できます。')
    expect(retryLabel(3540)).toBe('あと約 59 分で再開できます。')
  })

  it('1 分未満は秒を出さない（秒まで見せても判断は変わらない）', () => {
    expect(retryLabel(1)).toBe('あと 1 分ほどで再開できます。')
    expect(retryLabel(59)).toBe('あと 1 分ほどで再開できます。')
  })

  /**
   * レート制限の窓は 1 時間なので 3600 秒より大きい値は来ない。
   * それでも時間へ換算すると 3601 秒を「約 2 時間」と切り上げ、
   * 実際より長く待たせる案内になる。上限で言い切る。
   */
  it('1 時間ぶんは言い切る（切り上げて実際より長く待たせない）', () => {
    expect(retryLabel(3600)).toBe('あと約 1 時間で再開できます。')
    expect(retryLabel(3601)).toBe('あと約 1 時間で再開できます。')
  })

  /** ヘッダが無い応答（429 以外）では何も足さない */
  it('値が無い・不正なら空文字を返す', () => {
    for (const input of [null, undefined, 0, -1, NaN, Infinity, '600']) {
      expect(retryLabel(/** @type {never} */ (input)), String(input)).toBe('')
    }
  })
})
