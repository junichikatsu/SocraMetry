import { describe, expect, it } from 'vitest'
import { checkLeak, checkLeakInParts, significantTerms } from './leak-guard'

const ROOT_CAUSE =
  'props で渡される items が API 応答の遅延により初回レンダリング時 undefined になっている'

/**
 * LeakGuard の回帰テスト（NFR-Q1）。
 * ここが壊れると製品価値そのものが消えるため、**検出漏れ**と**過検出**の両方を守る。
 */
describe('checkLeak — 検出すべきもの', () => {
  it('L1: 断定表現を検出する', () => {
    expect(checkLeak('原因は items が undefined だったことです').rules).toContain('L1')
    expect(checkLeak('props の未初期化が原因です').rules).toContain('L1')
    expect(checkLeak('API の遅延のせいで落ちています').rules).toContain('L1')
    expect(checkLeak('ここを直せば動きます').rules).toContain('L1')
  })

  it('L2: Lv5 以外でのコードブロックを検出する', () => {
    const text = '次のように書きます\n```ts\nitems ?? []\n```'
    expect(checkLeak(text, { stage: 'observe' }).rules).toContain('L2')
  })

  it('L3: 修正動詞を検出する', () => {
    expect(checkLeak('初期値を追加してください', { stage: 'hypothesize' }).rules).toContain('L3')
  })

  it('L4: rootCause の語彙一致を検出する', () => {
    const generated = 'props の items が API 応答前の初回レンダリングで undefined でした'
    expect(checkLeak(generated, { rootCause: ROOT_CAUSE }).rules).toContain('L4')
  })

  /**
   * 語彙一致の 2 条件はどちらも 3 語を前提にしていたため、
   * **簡潔な診断文でこそ L4 が評価されない**状態になっていた。
   * フォールバックモデルや退避時に短い診断文が返る可能性がある。
   */
  describe('L4: 特徴語が 2 個以下の診断文', () => {
    it('特徴語 1 個の診断文をそのまま書いたら検出する', () => {
      expect(checkLeak('初期化漏れが起きています', { rootCause: '初期化漏れ' }).rules).toContain(
        'L4',
      )
    })

    it('特徴語 2 個がどちらも出ていれば検出する', () => {
      const rootCause = 'items が undefined'
      expect(checkLeak('items が undefined でした', { rootCause }).rules).toContain('L4')
    })

    it('一部しか出ていなければ通す（過検出しない）', () => {
      const rootCause = 'items が undefined'
      expect(checkLeak('items の中身を確かめましたか', { rootCause }).rules).not.toContain('L4')
      expect(checkLeak('初期化の順序を見てください', { rootCause: '初期化漏れ' }).rules).not.toContain(
        'L4',
      )
    })
  })

  it('L5: Lv1〜4 に修正手法が出ていることを検出する', () => {
    expect(checkLeak('オプショナルチェーンを使う方法', { stage: 'verify' }).rules).toContain('L5')
    expect(checkLeak('null チェックの位置', { stage: 'localize' }).rules).toContain('L5')
  })
})

describe('checkLeak — 検出してはいけないもの（過検出は再生成とテンプレート落ちを招く）', () => {
  it('Gate B Lv1 の正当な設問は通る', () => {
    const q = 'このエラーメッセージは、何が undefined だったと言っていますか？'
    expect(checkLeak(q, { stage: 'observe', rootCause: ROOT_CAUSE }).leaked).toBe(false)
  })

  it('Gate A のヒントは通る', () => {
    const hint = 'エラーメッセージの後半に注目してみてください。'
    expect(checkLeak(hint, { rootCause: ROOT_CAUSE }).leaked).toBe(false)
  })

  it('語が 1 つだけ一致しても漏洩と見なさない（エラー文中の識別子は必ず重なる）', () => {
    const q = 'undefined と表示されているのは、どの操作の対象でしょうか？'
    expect(checkLeak(q, { rootCause: ROOT_CAUSE }).rules).not.toContain('L4')
  })

  it('Lv5（修正）では修正の話をしてよい', () => {
    const q = '二度と起こさないために、どこに何を足しますか？'
    const result = checkLeak(q, { stage: 'fix', rootCause: ROOT_CAUSE })
    expect(result.rules).not.toContain('L3')
    expect(result.rules).not.toContain('L5')
  })

  it('「〜のためですか？」は問いなので断定と見なさない', () => {
    expect(checkLeak('それは非同期のためですか？', { stage: 'hypothesize' }).rules).not.toContain(
      'L1',
    )
  })

  it('「何が原因だと考えられますか？」は Lv3 の正当な設問として通す', () => {
    // ここを漏洩と見なすと、仮説の段階が毎回テンプレートに落ちる
    for (const q of [
      '何が原因だと考えられますか？',
      'それが原因なら、他の箇所も壊れないでしょうか。',
      '現象は見えなくなりますが、原因は残るでしょうか。',
    ]) {
      expect(checkLeak(q, { stage: 'hypothesize' }).rules, q).not.toContain('L1')
    }
  })

  it('同じ語でも言い切れば検出する（問うことと言うことを区別する）', () => {
    expect(checkLeak('何が原因かはもう分かっています。原因は初期化漏れです。').rules).toContain(
      'L1',
    )
  })
})

describe('checkLeakInParts', () => {
  it('選択肢のラベルも検査対象にする（本文が無害でも正解に答えが書かれうる）', () => {
    const result = checkLeakInParts(
      ['どこを見ますか？', '原因は items の未初期化です', null],
      { stage: 'observe' },
    )
    expect(result.leaked).toBe(true)
    expect(result.rules).toContain('L1')
  })
})

describe('significantTerms', () => {
  it('助詞・一般語を落として特徴語だけを残す', () => {
    const terms = significantTerms(ROOT_CAUSE)
    expect(terms).toContain('props')
    expect(terms).toContain('items')
    expect(terms).toContain('undefined')
    expect(terms).not.toContain('エラー')
  })
})
