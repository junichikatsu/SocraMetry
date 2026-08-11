import { describe, expect, it } from 'vitest'
import { checkQuestionShape } from './question-shape'

const options = (...labels: string[]) =>
  labels.map((label, index) => ({ id: 'abcde'[index] ?? 'e', label }))

describe('checkQuestionShape — 出題として成立しない形', () => {
  /** 実 LLM が実際に生成した設問。答えを知らない出題者には正解を決められない */
  it('真偽の二択（はい / いいえ）を検出する', () => {
    const result = checkQuestionShape(
      '最近の変更に関連して、アプリが参照する API キーの情報は正しいですか？',
      options(
        'はい、ローテーション後の情報が正しく更新されていると思う',
        'いいえ、ヘッダー生成ロジックに問題があるかもしれない',
        'いいえ、認証方式が変更された可能性がある',
      ),
    )
    expect(result.invalid).toBe(true)
    expect(result.rules).toContain('Q1')
  })

  it('設問文が真偽を問い、選択肢にも真偽語がある場合を検出する', () => {
    const result = checkQuestionShape(
      'その値は正しく設定されていますか？',
      options('はい、設定されています', '設定ファイルの該当行', 'ログの出力先'),
    )
    expect(result.rules).toContain('Q2')
  })

  it('選択肢の重複を検出する（正解が一意に決まらない）', () => {
    const result = checkQuestionShape(
      'どこを見ますか？',
      options('スタックトレース最上位の行', 'スタックトレース最上位の行', 'README'),
    )
    expect(result.rules).toContain('Q3')
  })
})

describe('checkQuestionShape — 通してよい形', () => {
  it('観点を選ばせる設問は通る', () => {
    const result = checkQuestionShape(
      'トークンを取得している箇所を確認するには、どの部分を見ればよいでしょうか？',
      options(
        '環境変数名やシークレットストアのキー名、設定ファイル',
        'Authorization ヘッダー生成ロジック',
        'API のエンドポイント設定',
      ),
    )
    expect(result.invalid).toBe(false)
  })

  it('事実を読み取らせる設問は通る', () => {
    const result = checkQuestionShape(
      'このエラーメッセージは、何が undefined だったと言っていますか？',
      options('map という名前の変数', 'map を呼び出そうとした対象'),
    )
    expect(result.invalid).toBe(false)
  })

  /** 1 つだけ「はい」で始まるのは、たまたまその語で始まっただけのことがある */
  it('真偽語で始まる選択肢が 1 つだけなら通す（過検出を避ける）', () => {
    const result = checkQuestionShape(
      '次に確認するとよいのはどれですか？',
      options('はいた例外のスタックトレース', '設定ファイルの該当行', 'ログの出力先'),
    )
    expect(result.rules).not.toContain('Q1')
  })
})
