import type { Verdict } from '@socrametry/shared'

/**
 * 到達判定とフィードバックの整合を検査する。
 *
 * 実 LLM で次の応答が返った。
 *
 * ```
 * verdict : reached                                    ← 到達した
 * feedback: 「…を捉えられています。APIレスポンスの形式変更に伴う影響を考えると、
 *            より深い原因を探る必要があります。」        ← 到達していない人への文面
 * ```
 *
 * **デモの山場（自分で原因を宣言して当たる場面）で、当たったのに
 * 「まだ足りない」と表示される。** scope-v0.1.md §6 の見せ場 #4
 * 「自力で到達する快感」が、この一文で消える。
 *
 * 原因は Judge のプロンプトで、`partial` / `not_reached` 向けの指示を先に 2 文置き、
 * `reached` 向けを最後に 1 行だけ書いていたこと。プロンプトは直したが、
 * **判定と文面の整合という壊れてはいけない部分を、確率的な指示だけに委ねない。**
 */

/** 「まだ足りない」と読める促し表現。`reached` では出てはいけない */
const URGING = [
  'もう一度',
  'まだ',
  'さらに',
  'より深',
  'もう一段',
  '探る必要',
  '掘り下げ',
  '考えてみ',
  '見直し',
  '足りな',
]

/** 文末が問いかけか。`reached` を問いで締めると「違うのか」と読める */
const INTERROGATIVE = /(?:か|の)[?？]?\s*[。．]?\s*$/

export type VerdictShapeResult = {
  /** 判定と文面が食い違っていれば true */
  inconsistent: boolean
  rules: string[]
}

export function checkVerdictConsistency(
  verdict: Verdict | null,
  feedback: string,
): VerdictShapeResult {
  const rules: string[] = []

  // 検査するのは `reached` だけ。partial / not_reached で促すのは正しい挙動
  if (verdict === 'reached') {
    const body = feedback.trim()
    if (URGING.some((word) => body.includes(word))) rules.push('V1')
    if (INTERROGATIVE.test(body)) rules.push('V2')
  }

  return { inconsistent: rules.length > 0, rules }
}

/**
 * 検査に落ちたときの差し替え文。
 *
 * **判定を変えずに文面だけを安全側へ倒す。** 到達しているのに
 * 到達していない文面を出すより、当たり障りのない肯定の方が害が小さい。
 */
export const REACHED_FALLBACK_FEEDBACK =
  'その通りです。原因の構造を捉えられています。'
