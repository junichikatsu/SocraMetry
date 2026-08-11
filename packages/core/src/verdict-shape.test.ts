import { describe, expect, it } from 'vitest'
import { checkVerdictConsistency, REACHED_FALLBACK_FEEDBACK } from './verdict-shape'
import { stripHintLabel } from './hint-text'

describe('checkVerdictConsistency', () => {
  /** 実 LLM が実際に返した応答。デモの山場を壊す */
  it('reached なのに「まだ足りない」と読める文面を検出する', () => {
    const result = checkVerdictConsistency(
      'reached',
      'APIの応答が返る前に items が undefined であることを捉えています。APIレスポンスの形式変更に伴う影響を考えると、より深い原因を探る必要があります。',
    )
    expect(result.inconsistent).toBe(true)
    expect(result.rules).toContain('V1')
  })

  it('reached を問いかけで終える文面を検出する', () => {
    const result = checkVerdictConsistency('reached', 'その通りです。次はどこを見ますか？')
    expect(result.rules).toContain('V2')
  })

  it('言い切っている reached の文面は通す', () => {
    for (const feedback of [
      'その通りです。データが到着する前の状態を見落としていた、という構造ですね。',
      '原因の層まで辿れています。値の出所を疑えたのが効いています。',
    ]) {
      expect(checkVerdictConsistency('reached', feedback).inconsistent, feedback).toBe(false)
    }
  })

  /** partial / not_reached で促すのは正しい挙動なので、検査対象にしない */
  it('partial と not_reached は促していても通す', () => {
    const urging = 'もう一度、エラーメッセージの語順を追ってみてください。'
    expect(checkVerdictConsistency('partial', urging).inconsistent).toBe(false)
    expect(checkVerdictConsistency('not_reached', urging).inconsistent).toBe(false)
  })

  it('判定を行わなかった場合（null）は検査しない', () => {
    expect(checkVerdictConsistency(null, 'まだ分からなくても大丈夫です。').inconsistent).toBe(false)
  })

  it('差し替え文は促しを含まない（それ自体が検査を通る）', () => {
    expect(checkVerdictConsistency('reached', REACHED_FALLBACK_FEEDBACK).inconsistent).toBe(false)
  })
})

describe('stripHintLabel', () => {
  /**
   * Diagnoser のプロンプトの出力例が `"Lv1: 着目範囲を狭める…"` だったため、
   * モデルが本文にラベルを含めていた。画面は別にバッジを出すので二重になる。
   */
  it('先頭のレベル表記を落とす', () => {
    expect(stripHintLabel('Lv2: その変数がどこから来ているかを辿ってください')).toBe(
      'その変数がどこから来ているかを辿ってください',
    )
    expect(stripHintLabel('Lv3：考え方の枠組みを与えます')).toBe('考え方の枠組みを与えます')
    expect(stripHintLabel('[Lv1] エラーの後半を見てください')).toBe('エラーの後半を見てください')
    expect(stripHintLabel('レベル2. 見るべき対象を絞ります')).toBe('見るべき対象を絞ります')
  })

  /** 一般化された知識の説明で段階に言及すること自体は正当 */
  it('本文の途中に現れるレベル表記は残す', () => {
    const body = 'この考え方は Lv3 のヒントと同じ枠組みです'
    expect(stripHintLabel(body)).toBe(body)
  })

  it('ラベルが無ければそのまま返す', () => {
    expect(stripHintLabel('エラーメッセージの後半に注目してみてください。')).toBe(
      'エラーメッセージの後半に注目してみてください。',
    )
  })

  it('前後の空白は落とす', () => {
    expect(stripHintLabel('  Lv1:  先頭を見る  ')).toBe('先頭を見る')
  })
})
