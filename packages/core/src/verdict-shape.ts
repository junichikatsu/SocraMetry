import type { Verdict } from '@socrametry/shared'
import { checkLeak, type LeakRuleId } from './leak-guard'

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
export const REACHED_FALLBACK_FEEDBACK = 'その通りです。原因の構造を捉えられています。'

/** 判定ごとの安全な差し替え文。**いずれも原因を明かさない** */
export const SAFE_FEEDBACK: Record<Verdict, string> = {
  reached: REACHED_FALLBACK_FEEDBACK,
  partial: 'その現象が起きるのはどんなときでしょうか。もう一段だけ掘ってみましょう。',
  not_reached: '別の可能性もありそうです。エラーメッセージの該当箇所をもう一度見てみてください。',
}

/**
 * 到達判定のフィードバックに答えが漏れていないかを検査する（FR-08）。
 *
 * **判定によって適用するルールを変える。** 同じ検査を一律にかけると壊れる。
 *
 * | 判定 | 適用するルール | 理由 |
 * |---|---|---|
 * | `partial` / `not_reached` | **すべて** | セッションは続く。ここで原因が出ると、そのまま宣言し直して最上位評価を取れてしまう |
 * | `reached` | L2 / L3 / L5 のみ | **利用者は既に自力で原因を言い当てている。** 何を捉えられたかを言語化する文面は、診断文と語彙が重なって当然であり、L1（断定）と L4（語彙一致）が必ず発火する。一律にかけると**成功体験のたびに定型文へ潰れる** |
 *
 * `reached` でも L2（コードブロック）・L3（修正動詞）・L5（修正手法）は残す。
 * 称賛の文面に修正手順が入る理由がなく、入っていれば Gate C の内容の先出しにあたる。
 */
export function checkFeedbackLeak(
  verdict: Verdict | null,
  feedback: string,
  rootCause: string,
): { leaked: boolean; rules: LeakRuleId[] } {
  const result = checkLeak(feedback, { rootCause })
  const rules =
    verdict === 'reached'
      ? result.rules.filter((rule) => rule === 'L2' || rule === 'L3' || rule === 'L5')
      : result.rules
  return { leaked: rules.length > 0, rules }
}
