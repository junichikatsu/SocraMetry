import type { Stage } from '@socrametry/shared'

/**
 * LeakGuard — 答え漏洩の検出（FR-08 / socratic-engine.md §5）。
 *
 * **LLM を使わない決定的なルールで実装する。**
 * LLM に「漏れてないか確認して」と聞く方式は、検査自体が確率的になるため採らない
 * （requirements.md §2.7「あえて AI を使わないこと」）。
 *
 * 検出時の挙動は呼び出し側（packages/llm）が持つ:
 *   1. 制約を強めたプロンプトで **1 回だけ**再生成
 *   2. それでも検出されたら定型テンプレートへフォールバック
 */

export type LeakRuleId = 'L1' | 'L2' | 'L3' | 'L4' | 'L5'

export type LeakCheckOptions = {
  /** 出題段階。`fix`(Lv5) は修正方法を扱う段階なので L3 / L5 を適用しない */
  stage?: Stage
  /** 内部診断の結論。語彙一致（L4）の照合元。渡さない場合 L4 は評価されない */
  rootCause?: string
}

export type LeakCheckResult = {
  leaked: boolean
  rules: LeakRuleId[]
}

/** L1: 断定表現。「原因は〜」と言ってしまうのが最も多い漏れ方 */
const ASSERTION_PATTERNS: readonly RegExp[] = [
  /原因は/,
  /が原因/,
  /のせいで/,
  /を直せば/,
  /すれば(?:解決|直り|動き)/,
  /だからです/,
  // 「〜ためです」は断定。「〜ためですか？」は問いなので除く
  /ためです(?!か)/,
  /ことが原因/,
  /実際には/,
]

/** L3: 修正動詞。Lv1〜4 で修正手順を渡してしまう漏れ方 */
const FIX_VERB_PATTERNS: readonly RegExp[] = [
  /(?:追加|変更|削除|置き換え|修正|直し|対応)(?:して|し)(?:ください|みてください)/,
  /を(?:追加|導入|挿入)すれば/,
  /に(?:変更|修正)すれば/,
]

/** L5: 段階違反。修正手法そのものが Lv1〜4 の文面に出ている */
const FIX_TECHNIQUE_PATTERNS: readonly RegExp[] = [
  /オプショナルチェ[ーイ]ン/,
  /\?\?/,
  /初期値を/,
  /デフォルト値を/,
  /ガード(?:節|句)/,
  /null\s*チェック/i,
  /try\s*\/?\s*catch/i,
  /early\s*return/i,
]

/**
 * 文末が疑問形かどうか。
 *
 * **L1（断定表現）を文単位で判定し、疑問文は除外する。**
 * 「何が原因だと考えられますか？」は Lv3（仮説）の正当な設問であり、
 * これを漏洩と見なすと、その段階の生成が毎回テンプレートに落ちてしまう。
 * 漏洩なのは「〜が原因です」と**言い切る**ことであって、問うことではない。
 *
 * 疑問形に見せかけた漏洩（「items が空だったからではないですか？」）は
 * L4（診断文との語彙一致）で拾う。役割を分けている。
 */
const INTERROGATIVE = /(?:か|の|？|\?)[。．！!、\s]*$/

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。．！!？?\n])/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

function hasAssertion(text: string): boolean {
  const sentences = splitSentences(text)
  const targets = sentences.length > 0 ? sentences : [text]
  return targets.some(
    (sentence) =>
      !INTERROGATIVE.test(sentence) && ASSERTION_PATTERNS.some((p) => p.test(sentence)),
  )
}

/**
 * 語彙一致（L4）で無視する語。
 * 助詞・一般語を残すと、どの生成文でも一致してしまい検査が機能しなくなる。
 */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'from',
  'error',
  'value',
  'code',
  'line',
  'this',
  'たち',
  'こと',
  'もの',
  'ため',
  'とき',
  'よう',
  'それ',
  'これ',
  'あの',
  'する',
  'なる',
  'ある',
  'いる',
  'れる',
  'られ',
  'てい',
  'です',
  'ます',
  'から',
  'また',
  'エラー',
  'コード',
  'ファイル',
  '場合',
  '内容',
  '状態',
  '処理',
  '実行',
])

/**
 * 特徴的な語を抽出する。
 * ラテン文字は 3 文字以上、日本語（漢字・カタカナ）は 2 文字以上を語として扱う。
 * ひらがなだけの連なりは助詞・活用語尾になりやすいので拾わない。
 */
export function significantTerms(text: string): string[] {
  const latin = text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? []
  const japanese = text.match(/[゠-ヿ一-龯][゠-ヿ一-龯]+/g) ?? []
  const terms = [...latin, ...japanese].filter((t) => !STOPWORDS.has(t))
  return [...new Set(terms)]
}

/**
 * L4: `rootCause` の語彙が生成文に一致していないか。
 *
 * 単語 1 個の一致では判定しない。エラーテキストに出てくる識別子は
 * 診断文にも設問にも当然現れるため、それを漏洩と見なすと常に再生成になる。
 *
 * | 条件 | 判定 |
 * |---|---|
 * | 特徴語が 2 個以下で、**そのすべてが一致** | 漏洩 |
 * | 特徴語が 3 個以上、かつ半分以上が一致 | 漏洩 |
 * | 診断文中で**連続する 3 語**がすべて出現 | 漏洩 |
 *
 * **特徴語が 2 個以下の場合を別扱いにしている。**
 * 下の 2 条件はどちらも 3 語を前提にしており（`present.length >= 3` は成立せず、
 * 3 語窓のループは `i + 2 < terms.length` で 1 回も回らない）、
 * 「初期化漏れ」のような簡潔な診断文でこそ検査が効かなくなっていた。
 * 語数が少ないほど 1 語の情報量は大きいので、全語一致を漏洩と見なす。
 */
function matchesRootCauseVocabulary(text: string, rootCause: string): boolean {
  const haystack = text.toLowerCase()
  const terms = significantTerms(rootCause)
  if (terms.length === 0) return false

  if (terms.length <= 2) return terms.every((t) => haystack.includes(t))

  const present = terms.filter((t) => haystack.includes(t))
  if (present.length >= 3 && present.length / terms.length >= 0.5) return true

  for (let i = 0; i + 2 < terms.length; i += 1) {
    const window = terms.slice(i, i + 3)
    if (window.every((t) => haystack.includes(t))) return true
  }
  return false
}

/**
 * 生成文が答えを漏らしていないか検査する。
 *
 * Gate C の開示文（`RevealPublic`）には通さない。**あちらは漏らすのが仕事**であり、
 * 検査対象は Gate A・B でユーザーに返す文面（ヒント・設問・選択肢・フィードバック）に限る。
 */
export function checkLeak(text: string, options: LeakCheckOptions = {}): LeakCheckResult {
  const rules: LeakRuleId[] = []
  const isFixStage = options.stage === 'fix'

  if (hasAssertion(text)) rules.push('L1')
  // コードブロックは Lv5 の選択肢のみ許す（socratic-engine.md §5 L2）
  if (text.includes('```') && !isFixStage) rules.push('L2')
  if (!isFixStage && FIX_VERB_PATTERNS.some((p) => p.test(text))) rules.push('L3')
  if (options.rootCause && matchesRootCauseVocabulary(text, options.rootCause)) rules.push('L4')
  if (!isFixStage && FIX_TECHNIQUE_PATTERNS.some((p) => p.test(text))) rules.push('L5')

  return { leaked: rules.length > 0, rules }
}

/**
 * 設問全体（本文 + 選択肢 + フィードバック）をまとめて検査する。
 *
 * **選択肢のラベルも検査対象**であることが重要。本文が無害でも、
 * 正解の選択肢に答えが書かれていれば漏洩は成立する。
 */
export function checkLeakInParts(
  parts: readonly (string | undefined | null)[],
  options: LeakCheckOptions = {},
): LeakCheckResult {
  const rules = new Set<LeakRuleId>()
  for (const part of parts) {
    if (!part) continue
    for (const rule of checkLeak(part, options).rules) rules.add(rule)
  }
  return { leaked: rules.size > 0, rules: [...rules] }
}
