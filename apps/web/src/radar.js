// @ts-check
/**
 * 5 軸スコアのレーダー（#27 / evaluation-model.md §2.2）。
 *
 * **SVG を手書きする。ライブラリを入れない。** 五角形と折れ線だけで、
 * チャートライブラリが解く問題（軸の自動計算・凡例・ツールチップ）が存在しない。
 * バンドラは入れたが（ADR-013 改訂）、それはマスキングを共有するためであって、
 * 依存を増やしてよいという判断ではない。
 */
import { clear, el } from './dom.js'

const NS = 'http://www.w3.org/2000/svg'

const SIZE = 300
const CENTER = SIZE / 2
const RADIUS = 104
/** 目盛りの本数（20 / 40 / 60 / 80 / 100） */
const RINGS = 5

function node(tag, attrs) {
  const n = document.createElementNS(NS, tag)
  for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, String(value))
  return n
}

/** i 番目の軸の座標。真上（-90°）から時計回り */
function point(index, count, ratio) {
  const angle = (Math.PI * 2 * index) / count - Math.PI / 2
  return {
    x: CENTER + Math.cos(angle) * RADIUS * ratio,
    y: CENTER + Math.sin(angle) * RADIUS * ratio,
  }
}

function polygonPoints(count, ratios) {
  return ratios
    .map((ratio, i) => {
      const p = point(i, count, ratio)
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`
    })
    .join(' ')
}

/**
 * @param {HTMLElement} host
 * @param {{name: string, value: number|null}[]} axes
 * @param {{ referenceOnly?: boolean }} [options]
 *   `referenceOnly` は Gate A のときに立てる。**値は出すが参考値だと明示する**
 *   （evaluation-model.md §4.6 の案 B）。線を破線にして、見た目でも他と区別する
 */
export function renderRadar(host, axes, options = {}) {
  clear(host)

  const count = axes.length
  const svg = node('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, role: 'img' })
  const title = node('title', {})
  title.textContent = options.referenceOnly ? '5 軸スコア（参考値）' : '5 軸スコア'
  svg.appendChild(title)

  // 目盛りの五角形
  for (let ring = 1; ring <= RINGS; ring += 1) {
    svg.appendChild(
      node('polygon', {
        points: polygonPoints(count, new Array(count).fill(ring / RINGS)),
        fill: 'none',
        stroke: ring === RINGS ? '#cbd5e1' : '#eef2f7',
        'stroke-width': 1,
      }),
    )
  }

  // 中心から各頂点への軸線
  for (let i = 0; i < count; i += 1) {
    const p = point(i, count, 1)
    svg.appendChild(
      node('line', { x1: CENTER, y1: CENTER, x2: p.x, y2: p.y, stroke: '#e2e8f0', 'stroke-width': 1 }),
    )
  }

  /**
   * `null`（出題対象外）は 0 点ではない。**0 として描くと「できなかった」に見える。**
   * 中心に落とさず、その軸だけ線を引かない扱いにする。
   */
  const drawable = axes.every((a) => a.value !== null && a.value !== undefined)

  if (drawable) {
    const ratios = axes.map((a) => Math.max(0, Math.min(100, Number(a.value))) / 100)
    svg.appendChild(
      node('polygon', {
        points: polygonPoints(count, ratios),
        fill: options.referenceOnly ? 'rgba(148,163,184,.18)' : 'rgba(238,103,147,.20)',
        stroke: options.referenceOnly ? '#94a3b8' : '#ee6793',
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        ...(options.referenceOnly ? { 'stroke-dasharray': '5 4' } : {}),
      }),
    )
    ratios.forEach((ratio, i) => {
      const p = point(i, count, ratio)
      svg.appendChild(
        node('circle', {
          cx: p.x.toFixed(1),
          cy: p.y.toFixed(1),
          r: 3.5,
          fill: options.referenceOnly ? '#94a3b8' : '#ee6793',
        }),
      )
    })
  }

  // 軸名
  axes.forEach((axis, i) => {
    const p = point(i, count, 1.19)
    const label = node('text', {
      x: p.x.toFixed(1),
      y: p.y.toFixed(1),
      'text-anchor': p.x > CENTER + 6 ? 'start' : p.x < CENTER - 6 ? 'end' : 'middle',
      'dominant-baseline': 'middle',
      fill: '#64748b',
      'font-size': 12,
      'font-weight': 700,
    })
    label.textContent = axis.name
    svg.appendChild(label)
  })

  host.appendChild(svg)

  if (!drawable) {
    host.appendChild(
      el(
        'p',
        'card__note',
        '出題対象外の段階があるため、レーダーは描けません。下の一覧をご覧ください。',
      ),
    )
  }
}

/**
 * @param {HTMLElement} host
 * @param {{name: string, ability: string, value: number|null}[]} axes
 */
export function renderLegend(host, axes) {
  clear(host)
  for (const axis of axes) {
    const li = el('li', 'legend__item')
    li.appendChild(el('span', 'legend__dot'))
    const text = el('span')
    text.appendChild(el('span', undefined, axis.name))
    text.appendChild(el('span', 'legend__ability', ` — ${axis.ability}`))
    li.appendChild(text)
    li.appendChild(
      el('span', 'legend__value', axis.value === null || axis.value === undefined ? '対象外' : String(axis.value)),
    )
    host.appendChild(li)
  }
}
