import { checkLeak, checkLeakInParts } from '@socrametry/core'
import {
  fallbackHint,
  FALLBACK_HINTS,
  FALLBACK_QUESTIONS,
  MOCK_DIAGNOSIS,
  MOCK_HINT,
  MOCK_QUESTIONS,
  MOCK_REPORT,
} from '@socrametry/llm'
import { STAGES } from '@socrametry/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateGuardedHint, generateGuardedQuestion, guardDiagnosisHints } from './guarded-llm'

/**
 * 固定応答とフォールバックが LeakGuard を通ることを保証する。
 *
 * **ここが引っかかると MOCK モードの導線が毎回テンプレートに落ちる。**
 * 「MOCK では通るのに本番では違う」という最もデバッグしづらい差が生まれるため、
 * 固定文面を変えたときにテストで気づける状態にしておく。
 *
 * `apps/function` に置いているのは、`core`（LeakGuard）と `llm`（固定応答）の
 * 両方に依存するのはこの層だけだから（architecture.md「依存の向き」）。
 */

beforeAll(() => {
  process.env['MOCK_MODE'] = 'true'
})

afterAll(() => {
  delete process.env['MOCK_MODE']
})

function partsOf(q: (typeof MOCK_QUESTIONS)[keyof typeof MOCK_QUESTIONS]): string[] {
  return [q.question, ...q.options.map((o) => o.label), q.rationaleIfCorrect, ...Object.values(q.rationaleIfWrong)]
}

describe('MOCK の固定応答（ADR-014）', () => {
  it('Gate A のヒントは答えを漏らさない', () => {
    expect(checkLeak(MOCK_HINT).leaked).toBe(false)
    for (const hint of MOCK_DIAGNOSIS.gateAHints) {
      expect(checkLeak(hint, { rootCause: MOCK_DIAGNOSIS.rootCause }).leaked, hint).toBe(false)
    }
  })

  it('全段階の固定設問が LeakGuard を通る（診断文の語彙とも重ならない）', () => {
    for (const stage of STAGES) {
      const result = checkLeakInParts(partsOf(MOCK_QUESTIONS[stage]), {
        stage,
        rootCause: MOCK_DIAGNOSIS.rootCause,
      })
      expect(result.rules, `${stage}: ${result.rules.join(',')}`).toEqual([])
    }
  })

  it('固定設問の正解 ID が選択肢に存在する（回答不能な設問を作らない）', () => {
    for (const stage of STAGES) {
      const q = MOCK_QUESTIONS[stage]
      expect(q.options.some((o) => o.id === q.correctOptionId), stage).toBe(true)
    }
  })

  it('レポートの固定文は Gate C 後の文面なので検査対象外（答えに触れてよい）', () => {
    expect(MOCK_REPORT.generalizedLesson).toBeTruthy()
  })
})

describe('定型フォールバック（socratic-engine.md §5）', () => {
  it('すべての段階のテンプレートが LeakGuard を通る', () => {
    for (const stage of STAGES) {
      const result = checkLeakInParts(partsOf(FALLBACK_QUESTIONS[stage]), {
        stage,
        rootCause: MOCK_DIAGNOSIS.rootCause,
      })
      expect(result.rules, `${stage}: ${result.rules.join(',')}`).toEqual([])
    }
  })

  it('定型ヒントも答えを漏らさない', () => {
    for (const hint of FALLBACK_HINTS) {
      expect(checkLeak(hint).leaked, hint).toBe(false)
    }
  })
})

describe('generateGuardedQuestion', () => {
  it('MOCK モードでは固定設問がそのまま通る（再生成もフォールバックもしない）', async () => {
    const result = await generateGuardedQuestion({
      input: {
        stage: 'observe',
        seqInStage: 1,
        difficulty: 'medium',
        errorText: 'TypeError: Cannot read properties of undefined',
        focusHint: null,
        distractorThemes: [],
        previousQuestions: [],
      },
      rootCause: MOCK_DIAGNOSIS.rootCause,
    })

    expect(result.fallbackUsed).toBe(false)
    expect(result.leakGuardRetries).toBe(0)
    expect(result.question.question).toBe(MOCK_QUESTIONS.observe.question)
    expect(result.calls[0]?.mocked).toBe(true)
  })

  it('漏洩する診断文が渡された場合は定型テンプレートへ退避する', async () => {
    // 選択肢のラベルと語彙が完全に重なる rootCause を渡し、L4 を意図的に踏ませる。
    // **選択肢も検査対象**であることの確認も兼ねている
    const result = await generateGuardedQuestion({
      input: {
        stage: 'observe',
        seqInStage: 1,
        difficulty: 'medium',
        errorText: 'TypeError',
        focusHint: null,
        distractorThemes: [],
        previousQuestions: [],
      },
      rootCause: MOCK_QUESTIONS.observe.options[0]?.label ?? '',
    })

    expect(result.fallbackUsed).toBe(true)
    expect(result.question.question).toBe(FALLBACK_QUESTIONS.observe.question)
    // 再生成は 1 回だけ。3 回目は試さない（確率に頼らない）
    expect(result.calls).toHaveLength(2)
    expect(result.calls.every((c) => c.leakGuardHit)).toBe(true)
  })
})

describe('generateGuardedHint', () => {
  it('MOCK モードでは固定ヒントを返す', async () => {
    const result = await generateGuardedHint({ errorText: 'TypeError', language: 'typescript' })
    expect(result.fallbackUsed).toBe(false)
    expect(result.body).toBe(MOCK_HINT)
  })
})

/**
 * `gateAHints` は `rootCause` を生成したのと同じ呼び出しの出力で、
 * しかも Diagnoser のプロンプトは冒頭で「原因をはっきり書いてください」と伝えている。
 * `openHint()` はこれを検査なしで返すため、保存時に落とさないと
 * **答えがそのまま Gate A で配信される。**
 */
describe('guardDiagnosisHints', () => {
  it('漏れていないヒントはそのまま通す', () => {
    const result = guardDiagnosisHints(MOCK_DIAGNOSIS.gateAHints, MOCK_DIAGNOSIS.rootCause)
    expect(result).toEqual(MOCK_DIAGNOSIS.gateAHints)
  })

  it('原因を書いてしまったヒントだけを定型ヒントに落とす', () => {
    const hints = [
      'エラーメッセージの後半に注目してみてください。',
      // 診断文をほぼそのまま書いてしまった Lv2
      'props の items が API 応答前の初回レンダリング時に undefined になっています。',
      '「X of undefined」は X を持っているはずの入れ物が空だったことを意味します。',
    ]
    const result = guardDiagnosisHints(hints, MOCK_DIAGNOSIS.rootCause)

    expect(result[0]).toBe(hints[0])
    expect(result[1]).toBe(fallbackHint(2))
    expect(result[2]).toBe(hints[2])
  })

  it('断定表現のヒントも落とす', () => {
    const result = guardDiagnosisHints(
      ['原因は初期化漏れです。'],
      MOCK_DIAGNOSIS.rootCause,
    )
    expect(result[0]).toBe(fallbackHint(1))
  })

  it('レベル表記の除去も同時に行う', () => {
    const result = guardDiagnosisHints(
      ['Lv2: スタックトレース最上位の行を見てください。'],
      MOCK_DIAGNOSIS.rootCause,
    )
    expect(result[0]).toBe('スタックトレース最上位の行を見てください。')
  })

  it('落とした先の定型ヒントは検査を通る（差し替えた結果がまた落ちない）', () => {
    for (const level of [1, 2, 3]) {
      const result = guardDiagnosisHints([fallbackHint(level)], MOCK_DIAGNOSIS.rootCause)
      expect(result[0], `Lv${level}`).toBe(fallbackHint(level))
    }
  })
})
