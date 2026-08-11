import { describe, expect, it } from 'vitest'
import {
  checkFeedbackLeak,
  checkVerdictConsistency,
  REACHED_FALLBACK_FEEDBACK,
  SAFE_FEEDBACK,
} from './verdict-shape'
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

/**
 * Judge のプロンプトには `rootCause` が入っている。
 * 「明かさないでください」という自然文の指示だけでは、
 * socratic-engine.md §5 が退けた確率的な方式そのものになる。
 */
describe('checkFeedbackLeak', () => {
  const ROOT_CAUSE =
    'props で渡される items が API 応答前の初回レンダリング時に undefined になっている'

  describe('partial / not_reached — セッションが続くので全ルールを当てる', () => {
    it('原因を書き写した文面を検出する', () => {
      const leaked =
        'props の items が API 応答前の初回レンダリング時に undefined になっているためです。'
      expect(checkFeedbackLeak('not_reached', leaked, ROOT_CAUSE).leaked).toBe(true)
    })

    it('断定表現を検出する（L1）', () => {
      expect(
        checkFeedbackLeak('partial', '原因は初期化漏れです。', ROOT_CAUSE).rules,
      ).toContain('L1')
    })

    it('修正手順を検出する（L3）', () => {
      expect(
        checkFeedbackLeak('partial', '初期値を追加してください。', ROOT_CAUSE).rules,
      ).toContain('L3')
    })

    it('正しい誘導は通す', () => {
      const guiding = 'その現象が起きるのはどんなときでしょうか。'
      expect(checkFeedbackLeak('partial', guiding, ROOT_CAUSE).leaked).toBe(false)
    })
  })

  describe('reached — 既に自力で言い当てているので L1 と L4 は当てない', () => {
    /**
     * 一律にかけると、**成功体験のたびに定型文へ潰れる。**
     * 到達した人への文面が診断文と語彙を共有するのは当然である。
     */
    it('捉えた内容を言語化した文面を通す（語彙が重なっても）', () => {
      const praise =
        'その通りです。API 応答前の初回レンダリングで items が undefined だった、という構造を捉えられています。'
      const result = checkFeedbackLeak('reached', praise, ROOT_CAUSE)
      expect(result.leaked).toBe(false)
    })

    it('同じ文面を not_reached として見れば漏洩になる（判定で扱いが変わることの確認）', () => {
      const praise =
        'その通りです。API 応答前の初回レンダリングで items が undefined だった、という構造を捉えられています。'
      expect(checkFeedbackLeak('not_reached', praise, ROOT_CAUSE).leaked).toBe(true)
    })

    it('修正手順は reached でも検出する（Gate C の内容の先出しになる）', () => {
      const result = checkFeedbackLeak(
        'reached',
        'その通りです。初期値を追加してください。',
        ROOT_CAUSE,
      )
      expect(result.rules).toContain('L3')
    })

    it('コードブロックは reached でも検出する', () => {
      const withCode = 'その通りです。 ```ts items ?? [] ```'
      const result = checkFeedbackLeak('reached', withCode, ROOT_CAUSE)
      expect(result.rules).toContain('L2')
    })
  })

  describe('SAFE_FEEDBACK', () => {
    it('差し替え文はどれも検査を通る（差し替えた結果がまた落ちない）', () => {
      for (const verdict of ['reached', 'partial', 'not_reached'] as const) {
        const feedback = SAFE_FEEDBACK[verdict]
        expect(checkFeedbackLeak(verdict, feedback, ROOT_CAUSE).leaked, verdict).toBe(false)
        expect(checkVerdictConsistency(verdict, feedback).inconsistent, verdict).toBe(false)
      }
    })

    it('差し替え文は原因の語彙を含まない', () => {
      for (const verdict of ['partial', 'not_reached'] as const) {
        expect(SAFE_FEEDBACK[verdict]).not.toContain('undefined')
        expect(SAFE_FEEDBACK[verdict]).not.toContain('props')
      }
    })
  })
})
