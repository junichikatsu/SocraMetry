import { afterEach, describe, expect, it } from 'vitest'
import { fallbackModel, isMockMode, maxTokensFor, modelFor, orcaBaseUrl, usdJpyRate } from './models'

const KEYS = [
  'MODEL_DIAGNOSER',
  'MODEL_QUESTIONER',
  'MODEL_JUDGE',
  'MODEL_FALLBACK',
  'MAX_TOKENS_QUESTIONER',
  'MOCK_MODE',
  'ORCAROUTER_BASE_URL',
  'USD_JPY_RATE',
]

afterEach(() => {
  for (const key of KEYS) delete process.env[key]
})

describe('モデル出し分け（F03 / FR-12）', () => {
  it('用途別に環境変数からモデルを引く', () => {
    process.env['MODEL_DIAGNOSER'] = 'anthropic/claude-sonnet-4.6'
    process.env['MODEL_QUESTIONER'] = 'openai/gpt-4o-mini'
    process.env['MODEL_JUDGE'] = 'openai/gpt-4o-mini'

    expect(modelFor('diagnoser')).toBe('anthropic/claude-sonnet-4.6')
    expect(modelFor('questioner')).toBe('openai/gpt-4o-mini')
    expect(modelFor('judge')).toBe('openai/gpt-4o-mini')
  })

  it('Revealer と Reporter は Diagnoser のモデルを再利用する（文章品質が要る役割）', () => {
    process.env['MODEL_DIAGNOSER'] = 'anthropic/claude-sonnet-4.6'
    expect(modelFor('revealer')).toBe('anthropic/claude-sonnet-4.6')
    expect(modelFor('reporter')).toBe('anthropic/claude-sonnet-4.6')
  })

  it('Hinter は安価モデル側（呼び出し回数が多い側）に寄せる', () => {
    process.env['MODEL_QUESTIONER'] = 'openai/gpt-4o-mini'
    expect(modelFor('hinter')).toBe('openai/gpt-4o-mini')
  })
})

describe('max_tokens（F04 / cost-model.md §3）', () => {
  it('役割ごとの既定値を持つ（多めに取らない）', () => {
    expect(maxTokensFor('diagnoser')).toBe(800)
    expect(maxTokensFor('hinter')).toBe(200)
    expect(maxTokensFor('questioner')).toBe(500)
    expect(maxTokensFor('judge')).toBe(300)
  })

  it('環境変数で上書きできる', () => {
    process.env['MAX_TOKENS_QUESTIONER'] = '640'
    expect(maxTokensFor('questioner')).toBe(640)
  })

  it('壊れた値は既定に落とす（0 や負数で生成不能にしない）', () => {
    process.env['MAX_TOKENS_QUESTIONER'] = 'abc'
    expect(maxTokensFor('questioner')).toBe(500)
    process.env['MAX_TOKENS_QUESTIONER'] = '0'
    expect(maxTokensFor('questioner')).toBe(500)
  })
})

describe('その他の設定', () => {
  it('MOCK_MODE は "true" のときだけ有効（曖昧な値で誤って本番を固定応答にしない）', () => {
    expect(isMockMode()).toBe(false)
    process.env['MOCK_MODE'] = 'TRUE'
    expect(isMockMode()).toBe(false)
    process.env['MOCK_MODE'] = 'true'
    expect(isMockMode()).toBe(true)
  })

  it('OrcaRouter の baseURL に既定値を持つ', () => {
    expect(orcaBaseUrl()).toBe('https://api.orcarouter.ai/v1')
  })

  it('退避モデルは未設定なら null（無いのに切り替えようとしない）', () => {
    expect(fallbackModel()).toBeNull()
    process.env['MODEL_FALLBACK'] = 'google/gemini-2.5-flash'
    expect(fallbackModel()).toBe('google/gemini-2.5-flash')
  })

  it('円換算レートの既定は 150', () => {
    expect(usdJpyRate()).toBe(150)
  })
})
