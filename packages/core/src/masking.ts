/**
 * 秘匿情報のマスキング（FR-11 / NFR-S2 / security.md §3）。
 *
 * **LLM を使わない。** LLM に送る *前* に処理する必要があるため、そもそも使えない。
 * 正規表現による決定的な処理に限られる（requirements.md §2.7）。
 *
 * **冪等である**ことを前提にしている。クライアント側でも同じ関数を通す二段構成のため
 * （security.md §3）、サーバ側で再実行しても結果が変わってはならない。
 * 置換後の文字列（`[REDACTED_KEY]` / `<path>/…`）がどのルールにも再マッチしないよう作っている。
 *
 * **過剰にマスクしてよい**（実装原則 #4）。誤ってマスクした場合の損害
 * （診断精度がわずかに落ちる）より、漏らした場合の損害の方が大きい。
 */

export type MaskKind = 'jwt' | 'token' | 'credentials' | 'key' | 'path' | 'email' | 'name'

export type MaskOptions = {
  /**
   * 除外語リスト（社名・製品名）。完全一致で `[REDACTED_NAME]` に置換する。
   * 環境変数 `MASK_WORDS` から渡す。v0.2 では組織辞書（FR-41）に昇格する。
   */
  maskWords?: readonly string[]
}

export type MaskResult = {
  text: string
  /** 種別ごとの置換件数。**本文はログに出さない**ため、件数だけを運用ログに使う */
  hits: Partial<Record<MaskKind, number>>
}

/** 正規表現の特殊文字を無効化する（除外語をリテラルとして扱うため） */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 絶対パスは**ファイル名より前をすべて**伏せる（security.md §3）。
 *
 * ユーザー名部だけを置換する方式では、中間ディレクトリに残る顧客名・
 * プロジェクト名がそのまま LLM へ送られる（例: `/Users/tanaka/projects/acme-corp/...`）。
 * スタックトレースは本製品のコア入力であるため、混入経路として最も確実になる。
 *
 * **強く伏せても診断精度は落ちない。** 診断に効くのはエラーメッセージ・
 * ファイル名・行番号であり、ディレクトリ階層ではない。
 */
function collapsePath(matched: string, separator: '/' | '\\'): string {
  const trimmed = matched.endsWith(separator) ? matched.slice(0, -1) : matched
  const lastIndex = trimmed.lastIndexOf(separator)
  const file = lastIndex >= 0 ? trimmed.slice(lastIndex + 1) : ''
  return `<path>/${file}`
}

/** パスの終端とみなす文字。引用符や閉じ括弧まで飲み込むと周囲の文が壊れる */
const PATH_BODY = String.raw`[^\s"'\`,;()\[\]{}<>]*`

type Rule = {
  kind: MaskKind
  pattern: RegExp
  replace: (matched: string) => string
}

/**
 * 適用順に意味がある。
 * 1. JWT / Bearer / 接続文字列を先に潰す。接続文字列の資格情報部を残したまま
 *    メールアドレスの規則を当てると `pass@host.com` が誤検出される
 * 2. パスはメールより先。パスに `@` は通常含まれない
 */
const RULES: readonly Rule[] = [
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
    replace: () => '[REDACTED_JWT]',
  },
  {
    kind: 'token',
    pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]{8,}={0,2}/gi,
    replace: () => 'Bearer [REDACTED_TOKEN]',
  },
  {
    // postgres://user:pass@host のような接続文字列の資格情報部
    kind: 'credentials',
    pattern: /\b([a-z][a-z0-9+.-]*):\/\/[^\s/@:]+:[^\s/@]+@/gi,
    replace: (m) => `${m.slice(0, m.indexOf(':'))}://[REDACTED_CREDENTIALS]@`,
  },
  { kind: 'key', pattern: /\bsk-[A-Za-z0-9_-]{12,}/g, replace: () => '[REDACTED_KEY]' },
  { kind: 'key', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: () => '[REDACTED_KEY]' },
  { kind: 'key', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: () => '[REDACTED_KEY]' },
  { kind: 'key', pattern: /\bglpat-[A-Za-z0-9_-]{16,}/g, replace: () => '[REDACTED_KEY]' },
  { kind: 'key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => '[REDACTED_KEY]' },
  { kind: 'key', pattern: /\bAIza[0-9A-Za-z_-]{20,}/g, replace: () => '[REDACTED_KEY]' },
  { kind: 'key', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: () => '[REDACTED_KEY]' },
  {
    kind: 'path',
    pattern: new RegExp(String.raw`\/(?:Users|home|root)\/${PATH_BODY}`, 'g'),
    replace: (m) => collapsePath(m, '/'),
  },
  {
    kind: 'path',
    pattern: new RegExp(String.raw`[A-Za-z]:\\(?:Users|home)\\${PATH_BODY}`, 'gi'),
    replace: (m) => collapsePath(m, '\\'),
  },
  {
    kind: 'email',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
    replace: () => '[REDACTED_EMAIL]',
  },
]

/**
 * マスキングを適用し、置換件数つきで返す。
 *
 * @param text 利用者が入力したテキスト（エラーテキスト / コード断片 / 直前の変更 /
 *             原因宣言 / 振り返りの回答）。**判断基準は「その入力が LLM に届くか」**
 */
export function maskDetail(text: string, options: MaskOptions = {}): MaskResult {
  const hits: Partial<Record<MaskKind, number>> = {}
  let out = text

  for (const rule of RULES) {
    let count = 0
    out = out.replace(rule.pattern, (matched) => {
      count += 1
      return rule.replace(matched)
    })
    if (count > 0) hits[rule.kind] = (hits[rule.kind] ?? 0) + count
  }

  // 除外語リストは最後。前段の置換結果（`[REDACTED_*]`）に語が含まれることはない
  for (const word of options.maskWords ?? []) {
    const normalized = word.trim()
    if (normalized === '') continue
    let count = 0
    out = out.replace(new RegExp(escapeRegExp(normalized), 'gi'), () => {
      count += 1
      return '[REDACTED_NAME]'
    })
    if (count > 0) hits.name = (hits.name ?? 0) + count
  }

  return { text: out, hits }
}

/** 置換件数が要らない呼び出し側のための薄いラッパ */
export function maskText(text: string, options: MaskOptions = {}): string {
  return maskDetail(text, options).text
}

/**
 * `MASK_WORDS` の解析。カンマ区切り。
 * 空要素を落とすのは、`a,,b` のような設定ミスで**全文が置換される**事故を防ぐため
 * （空文字の正規表現はすべての位置にマッチする）。
 */
export function parseMaskWords(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((w) => w.trim())
    .filter((w) => w !== '')
}
