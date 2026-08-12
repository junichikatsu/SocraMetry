// @ts-check
/**
 * DOM の組み立てヘルパ。
 *
 * ★ `textContent` しか使わない。`innerHTML` / `outerHTML` は lint で禁止している
 *   （security.md §7）。自動エスケープを持つフレームワークがない構成なので、
 *   LLM の出力と利用者の入力をそのまま HTML として入れると XSS になる。
 *   **要素は必ずここを通して作る**ことで、生成箇所を 1 ファイルに閉じ込める。
 */

/** @param {string} id */
export const byId = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

/** @param {Node} node */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [content]
 */
export function el(tag, className, content) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (content !== undefined) node.textContent = content
  return node
}

/** @param {Node} parent @param {...(Node|null|undefined|false)} children */
export function append(parent, ...children) {
  for (const child of children) if (child) parent.appendChild(child)
  return parent
}

/**
 * ボタン。`type="button"` を明示するのは、フォームの中に置いたときに
 * 暗黙の submit にならないようにするため
 * @param {string} label @param {string} className @param {() => void} onClick
 */
export function button(label, className, onClick) {
  const node = /** @type {HTMLButtonElement} */ (el('button', className, label))
  node.type = 'button'
  node.addEventListener('click', onClick)
  return node
}

/** @param {(string|number)[]} cells @param {boolean} [isHead] */
export function row(cells, isHead) {
  const tr = el('tr')
  for (const cell of cells) tr.appendChild(el(isHead ? 'th' : 'td', undefined, String(cell)))
  return tr
}

/** `<table>` を丸ごと作る。ヘッダなしの 1 行だけの表も同じ形で書ける */
export function table(head, rows) {
  const node = el('table', 'table')
  if (head) node.appendChild(row(head, true))
  for (const cells of rows) node.appendChild(row(cells))
  const wrap = el('div', 'table-wrap')
  wrap.appendChild(node)
  return wrap
}

/** 時刻の 24 時間表記（モックのメッセージ右上） */
export function clockLabel(ms) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
