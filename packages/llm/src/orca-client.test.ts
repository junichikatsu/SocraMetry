import { describe, expect, it } from 'vitest'
import { extractJson } from './orca-client'

/**
 * 実モデルの応答は素の `JSON.parse` に耐えない。
 * ここを落とすと、正しい内容が入っているのに定型テンプレートへ落ち、
 * **体験が劣化したうえで LLM 料金だけが発生する。**
 */
describe('extractJson', () => {
  it('素の JSON を読む', () => {
    expect(extractJson('{"hint":"ここを見て"}')).toEqual({ hint: 'ここを見て' })
  })

  it('```json のコードフェンスを剥がす', () => {
    const content = '```json\n{"hint":"ここを見て"}\n```'
    expect(extractJson(content)).toEqual({ hint: 'ここを見て' })
  })

  it('言語指定のないコードフェンスも剥がす', () => {
    expect(extractJson('```\n{"hint":"x"}\n```')).toEqual({ hint: 'x' })
  })

  it('前置きの一文が付いていても取り出す', () => {
    const content = '承知しました。以下が結果です。\n{"hint":"x"}'
    expect(extractJson(content)).toEqual({ hint: 'x' })
  })

  it('前後に文があっても取り出す', () => {
    expect(extractJson('結果:\n{"a":1}\n以上です。')).toEqual({ a: 1 })
  })

  it('JSON が無ければ undefined（生成失敗として扱う）', () => {
    expect(extractJson('すみません、お答えできません。')).toBeUndefined()
    expect(extractJson('')).toBeUndefined()
  })

  it('配列や数値だけの応答は受け付けない（このアプリのスキーマでは必ず不正）', () => {
    expect(extractJson('[1,2,3]')).toBeUndefined()
    expect(extractJson('42')).toBeUndefined()
  })

  it('壊れた JSON は undefined', () => {
    expect(extractJson('{"hint":')).toBeUndefined()
  })

  it('取り出すだけで、中身の妥当性は判定しない（検証は Zod の役目）', () => {
    expect(extractJson('{"unexpected":true}')).toEqual({ unexpected: true })
  })
})
