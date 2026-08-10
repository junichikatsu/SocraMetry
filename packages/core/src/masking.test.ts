import { describe, expect, it } from 'vitest'
import { maskDetail, maskText, parseMaskWords } from './masking'

/**
 * マスキングの回帰テスト（security.md §3 実装原則 #3）。
 * 正規表現は壊れやすいため、代表パターンを固定して守る。
 */
describe('maskText', () => {
  it('API キーをプレフィックスで検出する', () => {
    expect(maskText('ORCAROUTER_API_KEY=sk-orca-abcdefghijklmnopqrstuvwx')).toBe(
      'ORCAROUTER_API_KEY=[REDACTED_KEY]',
    )
    expect(maskText('token: ghp_1234567890abcdefghijABCDEFGHIJ')).toBe('token: [REDACTED_KEY]')
    expect(maskText('AKIAIOSFODNN7EXAMPLE で認証')).toBe('[REDACTED_KEY] で認証')
    expect(maskText('key=AIzaSyA1234567890abcdefghijklmnopqrs')).toBe('key=[REDACTED_KEY]')
  })

  it('Bearer トークンを伏せる', () => {
    expect(maskText('Authorization: Bearer abcdef1234567890.xyz')).toBe(
      'Authorization: Bearer [REDACTED_TOKEN]',
    )
  })

  it('JWT を伏せる', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g'
    expect(maskText(`cookie sm_session=${jwt}`)).toBe('cookie sm_session=[REDACTED_JWT]')
  })

  it('接続文字列の資格情報部だけを伏せる（ホストは診断に必要なので残す）', () => {
    expect(maskText('postgres://app_user:s3cr3t@db.internal:5432/main')).toBe(
      'postgres://[REDACTED_CREDENTIALS]@db.internal:5432/main',
    )
  })

  it('絶対パスはファイル名より前をすべて伏せる（中間ディレクトリの顧客名を残さない）', () => {
    expect(maskText('at /Users/tanaka/projects/acme-corp/src/invoice.js:42:18')).toBe(
      'at <path>/invoice.js:42:18',
    )
    expect(maskText('  File "/home/deploy/app/main.py", line 10')).toBe(
      '  File "<path>/main.py", line 10',
    )
    expect(maskText('at C:\\Users\\sato\\work\\acme\\index.ts:7')).toBe('at <path>/index.ts:7')
  })

  it('メールアドレスを伏せる', () => {
    expect(maskText('contact sato@example.co.jp for detail')).toBe(
      'contact [REDACTED_EMAIL] for detail',
    )
  })

  it('除外語リストを完全一致で伏せる（大小文字は無視する）', () => {
    expect(maskText('AcmeCorp の決済 API が失敗', { maskWords: ['acmecorp'] })).toBe(
      '[REDACTED_NAME] の決済 API が失敗',
    )
  })

  it('除外語リストの空要素を無視する（全文が置換される事故を防ぐ）', () => {
    expect(maskText('普通の文', { maskWords: ['', '  '] })).toBe('普通の文')
  })

  it('二重適用しても結果が変わらない（クライアントとサーバの二段構成の前提）', () => {
    const input = [
      'sk-orca-abcdefghijklmnopqrstuvwx',
      'at /Users/tanaka/app/src/a.ts:1:2',
      'sato@example.com',
      'postgres://u:p@h/db',
      'Authorization: Bearer abcdefghijklmn',
    ].join('\n')

    const once = maskText(input, { maskWords: ['Acme'] })
    expect(maskText(once, { maskWords: ['Acme'] })).toBe(once)
  })

  it('置換件数を種別ごとに返す（本文はログに出さず件数だけを使う）', () => {
    const { hits } = maskDetail('sk-orca-abcdefghijklmnopqrstuvwx と a@b.co')
    expect(hits.key).toBe(1)
    expect(hits.email).toBe(1)
  })

  it('秘匿情報を含まない文はそのまま返す', () => {
    const text = "TypeError: Cannot read properties of undefined (reading 'map')"
    expect(maskText(text)).toBe(text)
  })
})

describe('parseMaskWords', () => {
  it('カンマ区切りを解析し、空要素を落とす', () => {
    expect(parseMaskWords('Acme, ,BetaCorp,')).toEqual(['Acme', 'BetaCorp'])
    expect(parseMaskWords(undefined)).toEqual([])
  })
})
