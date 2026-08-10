/**
 * 原因宣言の前処理（socratic-engine.md §4.3 / 未決 Q-15）。
 *
 * **「わかりません」をそのまま 3 値判定に通すと `not_reached` になり、設問に戻される。**
 * デモやブースで最初に踏まれる導線であり、そこで一番不自然な動きになる。
 * **Judge を呼ぶ前に分岐させる。**
 *
 * LLM を呼ばずに判定できる分岐をここで済ませることは、コスト面でも効く
 * （1 回の Judge 呼び出しを丸ごと省ける）。
 */

/** これ未満は「まだ書けていない」と扱い、判定に回さない */
export const MIN_CONCLUSION_LENGTH = 10

export type ConclusionPrecheck =
  /** 空 / 短すぎる。入力を促す（判定に回さない） */
  | { kind: 'too_short'; minLength: number }
  /**
   * 「わかりません」等。**`not_reached` にもしない。**
   * 「設問に戻る」「解説を読む」の 2 択を提示する
   */
  | { kind: 'dont_know' }
  /** 通常。Judge で 3 値判定を行う */
  | { kind: 'judge'; body: string }

/**
 * 「わからない」の表明。
 * 「〜がわからない」（例:「items がどこから来るのかわからない」）は
 * **考えた形跡がある記述**なので拾わない。全体がこの表明だけの場合に限定する。
 */
const DONT_KNOW_PATTERNS: readonly RegExp[] = [
  /^(?:わかりません|分かりません|わからない|分からない|不明|わかんない|知りません)$/,
  /^(?:no\s*idea|dunno|idk|unknown)$/i,
  /^[?？!！。、\s]*$/,
]

export function precheckConclusion(
  body: string,
  minLength: number = MIN_CONCLUSION_LENGTH,
): ConclusionPrecheck {
  // 判定に使うのは記号と空白を除いた本文。「？？？」を有効な宣言として扱わない
  const trimmed = body.trim()
  const normalized = trimmed.replace(/[\s。、．，!！?？]+/g, '')

  if (DONT_KNOW_PATTERNS.some((p) => p.test(trimmed) || p.test(normalized))) {
    return { kind: 'dont_know' }
  }
  if (normalized.length < minLength) {
    return { kind: 'too_short', minLength }
  }
  return { kind: 'judge', body: trimmed }
}
