// @ts-check
/**
 * 個人ダッシュボード（FR-24 / `GET /v1/me/stats`）。
 *
 * モックにある週間推移とチームランキングは**出していない。**
 * v0.1 の API はセッション単位の記録までしか返さず（組織・チームの概念が無い）、
 * ダミーで埋めると「動いている」と誤読される。v0.2 の項目として名前だけ残す。
 */
import { byId, clear, row } from './dom.js'
import { renderLegend, renderRadar } from './radar.js'
import { GATE_LABEL, STAGES, stageName } from './stages.js'
import { isReferenceOnly } from './report.js'

/** @param {import('@socrametry/shared').MeStatsPublic} stats */
export function renderStats(stats) {
  const hours = stats.totalElapsedMs / 3_600_000
  byId('stat-sessions').textContent = String(stats.sessionCount)
  byId('stat-sessions-sub').textContent =
    stats.sessionCount === 0 ? 'まだ記録がありません' : `累計 ${hours.toFixed(1)} 時間`

  const g = stats.gateDistribution
  byId('stat-gates').textContent = `${g.A} / ${g.B} / ${g.C}`

  byId('stat-avg').textContent =
    stats.correctRate === null ? '—' : `${Math.round(stats.correctRate * 100)}%`
  byId('stat-avg-sub').textContent =
    stats.correctRate === null ? '設問に進んだ記録がありません' : '設問の正答率'

  const last = stats.trend.at(-1)
  byId('stat-last').textContent = last ? String(last.total) : '—'
  byId('stat-last-sub').textContent = last
    ? (GATE_LABEL[last.gate] ?? '未解決')
    : '完了したセッションがありません'

  // ── レーダー ───────────────────────────────────────────────────────
  const host = byId('radar')
  const legend = byId('radar-legend')
  const caption = byId('radar-caption')

  if (!stats.recentAxes) {
    clear(host)
    clear(legend)
    caption.textContent = '完了したセッションがまだありません。'
    return
  }

  // 直近のセッションが Gate A なら、そのレーダーは参考値（§4.6 / 案 B）
  const reference = isReferenceOnly(last?.gate ?? null)
  const axes = STAGES.map((stage) => ({
    name: stage.name,
    ability: stage.ability,
    value: stats.recentAxes[stage.key],
  }))

  caption.textContent = reference
    ? '直近のセッション（Gate A 到達のため参考値）。' +
      '設問を解いていないので軸ごとの差は出ません（evaluation-model.md §4.6）。'
    : `直近のセッション${
        stats.weakestAxis ? ` — 伸ばすべきは「${stageName(stats.weakestAxis)}」` : ''
      }`

  renderRadar(host, axes, { referenceOnly: reference })
  renderLegend(legend, axes)
}

const STATUS_LABEL = { active: '進行中', completed: '完了', abandoned: '中断' }

/** @param {import('@socrametry/shared').SessionSummaryPublic[]} sessions */
export function renderHistory(sessions) {
  const node = byId('history-table')
  clear(node)

  if (sessions.length === 0) {
    node.appendChild(row(['まだセッションがありません']))
    return
  }

  node.appendChild(row(['エラー', '言語', '到達', 'スコア', '状態', '開始'], true))
  for (const s of sessions) {
    node.appendChild(
      row([
        s.summary,
        s.language ?? '—',
        s.reachedGate ?? '—',
        s.totalScore === null ? '—' : s.totalScore,
        STATUS_LABEL[s.status] ?? s.status,
        new Date(s.startedAt).toLocaleString('ja-JP'),
      ]),
    )
  }
}
