import { describe, expect, it } from 'vitest'
import { checkConfig } from './config'

/** すべて設定済みの状態（MOCK_MODE=true / OPS_LOG_ENABLED=true = v0.1 の想定） */
const complete = {
  MOCK_MODE: 'true',
  OPS_LOG_ENABLED: 'true',
  DS_TABLE_USERS: '11111111-1111-1111-1111-111111111111',
  DS_TABLE_SESSIONS: '22222222-2222-2222-2222-222222222222',
  DS_TABLE_SECRETS: '33333333-3333-3333-3333-333333333333',
  DS_TABLE_REPORTS: '44444444-4444-4444-4444-444444444444',
  DS_TABLE_OPS_LOGS: '55555555-5555-5555-5555-555555555555',
  SESSION_JWT_SECRET: '2d4620f5c936b745508ff98fabf9fb78',
  INVITE_CODE: 'SOCRA-TEST-CODE',
}

const keysOf = (env: Record<string, string | undefined>) => checkConfig(env).map((i) => i.key)

describe('checkConfig', () => {
  it('すべて揃っていれば問題なしを返す', () => {
    expect(checkConfig(complete)).toEqual([])
  })

  it('未設定を検出する', () => {
    expect(keysOf({ ...complete, DS_TABLE_SECRETS: undefined })).toEqual(['DS_TABLE_SECRETS'])
  })

  it('空文字と空白のみは未設定として扱う', () => {
    expect(keysOf({ ...complete, INVITE_CODE: '   ' })).toEqual(['INVITE_CODE'])
  })

  it('.env.example の雛形の値のままなら検出する', () => {
    const issues = checkConfig({
      ...complete,
      DS_TABLE_USERS: '00000000-0000-0000-0000-000000000000',
      SESSION_JWT_SECRET: 'change-me',
    })

    expect(issues).toEqual([
      { key: 'DS_TABLE_USERS', reason: 'placeholder' },
      { key: 'SESSION_JWT_SECRET', reason: 'placeholder' },
    ])
  })
})

// 何が必須かは動作モードで変わる。手作業のチェックリストでは回せない部分
describe('モードによる必須項目の変化', () => {
  it('MOCK_MODE=false なら OrcaRouter の設定が必須になる', () => {
    expect(keysOf({ ...complete, MOCK_MODE: 'false' })).toEqual([
      'ORCAROUTER_API_KEY',
      'MODEL_DIAGNOSER',
      'MODEL_QUESTIONER',
      'MODEL_JUDGE',
    ])
  })

  it('MOCK_MODE=true なら OrcaRouter の設定が無くても問題なし', () => {
    expect(checkConfig({ ...complete, ORCAROUTER_API_KEY: undefined })).toEqual([])
  })

  it('OPS_LOG_ENABLED=true なら ops_logs のテーブル ID が必須になる', () => {
    expect(keysOf({ ...complete, DS_TABLE_OPS_LOGS: undefined })).toEqual(['DS_TABLE_OPS_LOGS'])
  })

  it('OPS_LOG_ENABLED が false なら ops_logs のテーブル ID は不要', () => {
    const env = { ...complete, OPS_LOG_ENABLED: 'false', DS_TABLE_OPS_LOGS: undefined }

    expect(checkConfig(env)).toEqual([])
  })
})

describe('検出結果の内容', () => {
  it('値を含めない（ログにも公開レスポンスにも値を出さないため）', () => {
    const issues = checkConfig({ ...complete, SESSION_JWT_SECRET: 'change-me' })

    expect(JSON.stringify(issues)).not.toContain('change-me')
    expect(Object.keys(issues[0] ?? {})).toEqual(['key', 'reason'])
  })
})
