// @ts-check
/**
 * 貼られたエラーログの表示（#27）。
 *
 * **この画面は「エラーを正確に読めるか」を測っている**（evaluation-model.md の観察軸）。
 * 読む対象がスクロールで消えるのは筋が通らないので、スレッドの上に固定して出す。
 * 先輩役が「スタックトレースをもう一度読み返してください」と言う場面が実際にあり、
 * そのときに対象が画面外にあると成立しない。
 *
 * 色分けはライブラリを入れずに行う（ADR-013）。やっているのは行の分類だけで、
 * 構文解析はしない。**間違って分類しても意味は変わらない**程度に留めてある。
 */
import { clear, el } from './dom.js'

/**
 * スタックトレースの 1 行か。言語ごとに書式が違うので、代表的なものだけ拾う。
 * **拾えなくても普通の行として出るだけ**なので、網羅より誤検出しないことを優先する。
 */
const FRAME_PATTERNS = [
  /*
    JavaScript / TypeScript / Java / C#。

    **`at ` で始まることだけを条件にしない。** それだと
    「at the same time, the pool was exhausted」のような英文まで拾ってしまう。
    スタックトレースには必ず**場所**が付く（`(file:line:col)` / `:12:5` / `line 42`）
    ので、そこまで含めて条件にする。
  */
  /^\s*at\s+\S.*(?:\(.*\)|:\d+(?::\d+)?|\bline\s+\d+)/,
  /^\s*File\s+".*",\s*line\s+\d+/, //   Python
  /^\s*from\s+\S+:\d+/, //              Ruby
  /^#\d+\s+\S/, //                      PHP
  /^\s+\S+\.go:\d+/, //                 Go
  /^\s*\.{3}\s*\d+\s+more$/, //         Java の "... 12 more"
]

/** 例外の連鎖。ここから先は別の例外なので、区切りとして見せる */
const CAUSE_PATTERNS = [
  /^\s*Caused by:/i,
  /^\s*The above exception was the direct cause/i,
  /^\s*During handling of the above exception/i,
  /^\s*Suppressed:/i,
]

/** マスキング済みの箇所。**何が伏せられたかが目で分かる**ようにする（security.md §3） */
const REDACTED = /\[REDACTED_[A-Z]+\]|<path>\//g

/**
 * 行の種別。表示のためだけの分類で、判定にも保存にも使わない。
 * @typedef {'message' | 'frame' | 'cause' | 'plain'} LineKind
 *
 * @param {string} line
 * @param {boolean} isFirstMeaningful 空行を除いた最初の行か（＝例外名と本文）
 * @returns {LineKind}
 */
export function classifyLine(line, isFirstMeaningful) {
  if (CAUSE_PATTERNS.some((p) => p.test(line))) return 'cause'
  if (FRAME_PATTERNS.some((p) => p.test(line))) return 'frame'
  if (isFirstMeaningful) return 'message'
  return 'plain'
}

/**
 * マスキング箇所で行を分割する。
 * @param {string} line
 * @returns {{ text: string, redacted: boolean }[]}
 */
export function segments(line) {
  const out = []
  let last = 0
  REDACTED.lastIndex = 0
  for (const match of line.matchAll(REDACTED)) {
    const at = match.index ?? 0
    if (at > last) out.push({ text: line.slice(last, at), redacted: false })
    out.push({ text: match[0], redacted: true })
    last = at + match[0].length
  }
  if (last < line.length) out.push({ text: line.slice(last), redacted: false })
  return out.length === 0 ? [{ text: line, redacted: false }] : out
}

/**
 * 行ごとの分類つきに直す。**改行の正規化もここで行う**（CRLF が混ざると
 * 行番号がずれ、`at ...` の判定も落ちる）。
 * @param {string} text
 */
export function toLines(text) {
  const raw = text.replace(/\r\n?/g, '\n').split('\n')
  let seenMeaningful = false
  return raw.map((line) => {
    const meaningful = line.trim() !== ''
    const isFirst = meaningful && !seenMeaningful
    if (meaningful) seenMeaningful = true
    return { text: line, kind: classifyLine(line, isFirst) }
  })
}

/**
 * `<ol>` に描く。**行番号は `<ol>` に出させる**ことで、
 * 本文をコピーしたときに番号が付いてこない。
 *
 * @param {HTMLElement} host `<ol>`
 * @param {string} text
 */
export function renderErrorLog(host, text) {
  clear(host)
  for (const line of toLines(text)) {
    const li = el('li', `errorlog__line errorlog__line--${line.kind}`)
    for (const seg of segments(line.text)) {
      li.appendChild(
        seg.redacted ? el('span', 'errorlog__redacted', seg.text) : el('span', undefined, seg.text),
      )
    }
    // 空行でも行の高さを保つ（行番号がずれて見えるため）
    if (line.text === '') li.appendChild(el('span', undefined, ' '))
    host.appendChild(li)
  }
}

/**
 * 見出しに出す要約。**畳んだままでも全体の大きさが分かる**ようにする。
 * 「3 行しか見えていないが、実際は 40 行ある」が伝わらないと、
 * 全文を開く判断ができない。
 */
export function summarize(text) {
  const lines = toLines(text)
  const frames = lines.filter((l) => l.kind === 'frame').length
  const parts = [`${lines.length} 行`]
  if (frames > 0) parts.push(`スタックトレース ${frames} 行`)
  return parts.join(' / ')
}
