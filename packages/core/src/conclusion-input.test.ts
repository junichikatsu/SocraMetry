import { describe, expect, it } from 'vitest'
import { precheckConclusion } from './conclusion-input'

/**
 * Q-15（原因宣言の前処理）の仕様テスト。
 * 「わかりません」を `not_reached` にして設問へ戻す挙動を**作らない**ことを固定する。
 */
describe('precheckConclusion', () => {
  it('「わかりません」は判定に回さず、専用の分岐にする', () => {
    for (const input of ['わかりません', '分からない', '不明', 'no idea', 'IDK']) {
      expect(precheckConclusion(input).kind).toBe('dont_know')
    }
  })

  it('記号だけの入力も dont_know として扱う', () => {
    expect(precheckConclusion('？？？').kind).toBe('dont_know')
    expect(precheckConclusion('   ').kind).toBe('dont_know')
  })

  it('短すぎる入力は判定に回さず、入力を促す', () => {
    const result = precheckConclusion('undefined')
    expect(result.kind).toBe('too_short')
  })

  it('「〜がわからない」は考えた形跡があるので Judge に回す', () => {
    const result = precheckConclusion('items がどこから渡ってくるのかわからない')
    expect(result.kind).toBe('judge')
  })

  it('通常の宣言は Judge に回す（前後の空白は落とす）', () => {
    const result = precheckConclusion('  API の応答前に描画されて items が undefined だった  ')
    expect(result).toEqual({
      kind: 'judge',
      body: 'API の応答前に描画されて items が undefined だった',
    })
  })
})
