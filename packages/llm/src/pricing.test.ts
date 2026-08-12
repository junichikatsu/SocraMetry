import { describe, expect, it } from 'vitest'
import { estimateCostJpy, estimateCostUsd, PRICING, tierOf } from './pricing'

describe('estimateCostUsd', () => {
  it('入出力のトークン数から単価を掛けて算出する', () => {
    // gpt-4o-mini: 入力 0.15 / 出力 0.60 USD per 1M tokens
    expect(estimateCostUsd('openai/gpt-4o-mini', 1_000_000, 0)).toBeCloseTo(0.15)
    expect(estimateCostUsd('openai/gpt-4o-mini', 0, 1_000_000)).toBeCloseTo(0.6)
  })

  it('未知のモデルは null を返す（「単価不明」と「無料」を区別する）', () => {
    expect(estimateCostUsd('unknown/model', 1000, 100)).toBeNull()
    expect(estimateCostJpy(null, 150)).toBeNull()
  })

  it('円換算はレートを掛けるだけ', () => {
    expect(estimateCostJpy(0.02, 150)).toBeCloseTo(3.0)
  })
})

describe('tierOf', () => {
  it('モデル階層を返す', () => {
    expect(tierOf('openai/gpt-4o-mini')).toBe('cheap')
    expect(tierOf('anthropic/claude-sonnet-4.6')).toBe('quality')
  })

  it('単価表にないモデルを cheap と決めつけない（コストログの意味が失われる）', () => {
    expect(tierOf('unknown/model')).toBe('unknown')
  })
})

describe('PRICING', () => {
  it('出力単価が入力単価を下回るモデルを登録しない（設定ミスの検出）', () => {
    for (const [model, price] of Object.entries(PRICING)) {
      expect(price.output, model).toBeGreaterThanOrEqual(price.input)
    }
  })
})
