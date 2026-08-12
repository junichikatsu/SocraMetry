// @ts-check
/**
 * セッション結果（FR-09 / evaluation-model.md）。スレッドの最後に 1 枚の
 * カードとして積む。
 *
 * **総合点だけを出さない**（NFR-F1）。算出式と軸ごとの内訳を必ず添える。
 * 説明できない数値を評価に使わせない、という要件はここで担保している。
 */
import { append, el, table } from './dom.js'
import { renderLegend, renderRadar } from './radar.js'
import { GATE_LABEL, STAGES, stageName } from './stages.js'

/**
 * Gate A では 5 軸が全部同値になる（evaluation-model.md §4.6 / 実測 70×5）。
 * 設問を 1 問も解いていないため、軸ごとに差がつく材料が存在しない。
 *
 * **案 B を採る**（#27 で決定）。値は出すが「参考値」と明示し、
 * 成長率の算出からは除く。表示が揃うこと自体に意味があり、
 * かつ「数値の意味が場合によって変わることを隠さない」ことが NFR-F1 の要求でもある。
 */
export const isReferenceOnly = (reachedGate) => reachedGate === 'A'

const REFERENCE_NOTE =
  '自力で解決したため設問を 1 問も解いておらず、軸ごとに差がつく材料がありません。' +
  'この 5 軸は参考値で、成長率の算出には使いません（evaluation-model.md §4.6）。'

/** @param {import('@socrametry/shared').ReportPublic} report */
export function reportCard(report) {
  const nodes = []
  const reference = isReferenceOnly(report.reachedGate)

  // ── 到達 ────────────────────────────────────────────────────────────
  nodes.push(
    el('p', 'msg__text', report.reachedGate
      ? GATE_LABEL[report.reachedGate]
      : '未解決のまま終了しました'),
  )

  // ── 学び ────────────────────────────────────────────────────────────
  nodes.push(
    section('一般化された学び', report.generalizedLesson),
    section('つまずいた点', report.stumblingPoint),
  )

  if (report.nextTimeSteps.length > 0) {
    const box = el('div', 'callout callout--calm')
    box.appendChild(el('p', 'callout__label', '次に同じ場面が来たら：'))
    const list = el('ol', 'steps')
    for (const step of report.nextTimeSteps) list.appendChild(el('li', undefined, step))
    box.appendChild(list)
    nodes.push(box)
  }

  // ── 5 軸 ────────────────────────────────────────────────────────────
  const axes = STAGES.map((stage) => ({
    name: stage.name,
    ability: stage.ability,
    value: report.score[stage.key],
  }))

  const radarHost = el('div', 'radar')
  renderRadar(radarHost, axes, { referenceOnly: reference })
  const legendHost = el('ul', 'legend')
  renderLegend(legendHost, axes)

  nodes.push(el('p', 'msg__lead', reference ? '5 軸スコア（参考値）' : '5 軸スコア'))
  if (reference) nodes.push(el('p', 'card__note', REFERENCE_NOTE))
  nodes.push(radarHost, legendHost)

  // ── 総合 ────────────────────────────────────────────────────────────
  const previous = report.score.previousTotal
  const total =
    `総合 ${report.score.total}（到達係数 ${report.score.gateFactor}）` +
    (previous === null || previous === undefined ? '' : ` / 前回 ${previous}`) +
    (report.score.comparable ? '' : ' ※実務モードのため横比較には使いません')
  nodes.push(el('p', 'msg__text', total))

  // ── 算出根拠（NFR-F1: 必ず出す）────────────────────────────────────
  nodes.push(section('算出式', report.scoreExplanation.formula))
  nodes.push(
    table(
      ['軸', 'base', 'ヒント係数', '難易度係数', '結果', '備考'],
      report.scoreExplanation.breakdown.map((line) => [
        stageName(line.axis),
        line.base,
        line.hintPenalty,
        line.difficultyFactor,
        line.result === null ? '対象外' : line.result,
        line.note ?? '',
      ]),
    ),
  )

  // ── 経路 ────────────────────────────────────────────────────────────
  if (report.path.length === 0) {
    nodes.push(el('p', 'card__note', '設問には進みませんでした。'))
  } else {
    nodes.push(
      table(
        ['段階', '試行', 'ヒント', '所要'],
        report.path.map((step) => [
          stageName(step.stage),
          `${step.attempts} 回`,
          `Lv${step.hintLevel}`,
          `${Math.round(step.elapsedMs / 1000)} 秒`,
        ]),
      ),
    )
  }

  // ── 答え ────────────────────────────────────────────────────────────
  // **ここが答えを出してよい唯一の場所**（DoD #2 / api-spec.md §7）。
  // 完了後のレポートにしか `revealedAnswer` は載らない
  if (report.revealedAnswer) {
    nodes.push(section('原因（答え合わせ）', report.revealedAnswer))
  }

  return nodes
}

/** 開示（Gate C / FR-08） */
export function revealNodes(reveal) {
  const nodes = [section('原因', reveal.rootCause)]
  if (reveal.evidence.length > 0) {
    const box = el('div', 'callout callout--calm')
    box.appendChild(el('p', 'callout__label', 'そう言える根拠'))
    const list = el('ul', 'steps')
    for (const line of reveal.evidence) list.appendChild(el('li', undefined, line))
    box.appendChild(list)
    nodes.push(box)
  }
  nodes.push(section('直し方', reveal.fixDirection), section('再発を防ぐには', reveal.prevention))
  return nodes
}

/**
 * 実測コスト（F11）。**モデル出し分けが効いていること**を数字で見せる部分。
 * 高品質は 1〜2 回、安価は 10 回以上、という偏りがそのまま出る。
 */
export function costNodes(cost) {
  if (!cost.enabled) return [el('p', 'card__note', cost.note ?? '')]
  if (cost.calls.length === 0) {
    return [
      el('p', 'card__note', 'LLM の呼び出し記録がありません（MOCK モードでは記録しません）。'),
    ]
  }

  const s = cost.summary
  const summary =
    `${s.callCount} 回（高品質 ${s.quality} / 安価 ${s.cheap}） — ` +
    `入力 ${s.promptTokens} tok / 出力 ${s.completionTokens} tok — ` +
    `約 ${s.costUsd.toFixed(4)} USD（約 ${s.costJpy.toFixed(1)} 円）` +
    (s.unknownPrice > 0 ? ` ※単価不明のモデルが ${s.unknownPrice} 件あり合計に含みません` : '')

  return [
    el('p', 'card__note', summary),
    table(
      ['役割', 'モデル', '階層', '入力', '出力', '秒', 'USD'],
      cost.calls.map((call) => [
        call.role,
        call.model,
        call.tier,
        call.promptTokens,
        call.completionTokens,
        (call.latencyMs / 1000).toFixed(1),
        call.estimatedCostUsd === null ? '単価不明' : call.estimatedCostUsd.toFixed(5),
      ]),
    ),
  ]
}

function section(label, body) {
  const wrap = el('div')
  append(wrap, el('p', 'msg__lead', label), el('p', 'msg__text', body))
  return wrap
}
