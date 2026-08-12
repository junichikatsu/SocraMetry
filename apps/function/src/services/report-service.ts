import {
  calculateScore,
  indexOfStage,
  penaltyLevelOf,
  weakestAxis,
  type StageOutcome,
} from '@socrametry/core'
import {
  opsRepo,
  ownerIdOf,
  reportRepo,
  secretRepo,
  sessionRepo,
  type ReportItem,
  type SessionItem,
} from '@socrametry/datastore'
import {
  FALLBACK_REPORT,
  generateReport,
  LlmError,
  STAGE_LABELS,
  type LlmCallMeta,
} from '@socrametry/llm'
import type {
  AuthContext,
  ListSessionsQuery,
  MeStatsPublic,
  ReportPublic,
  ScoreAxes,
  SessionSummaryPublic,
  Stage,
  StagePathPublic,
} from '@socrametry/shared'
import { STAGES } from '@socrametry/shared'
import { opsLogEnabled } from '../config'
import { logSessionCost, recordLlmCalls, totalTokens } from '../middleware/cost-log'
import { errors } from '../middleware/error-handler'
import { toSessionSummary } from './presenters'

/**
 * 振り返りレポートと個人統計（FR-23 / FR-24 / api-spec.md §3.8〜3.10）。
 *
 * **v0.1 は `member_stats`（ADR-011 / v0.2）を持たない。**
 * 個人ダッシュボードは `reports` の 1 クエリ（data-model.md A4）から都度集計する。
 * 事前計算が必要になるのは組織ダッシュボード（メンバー 20 名 × 40 件 = 800 アクセス）
 * であり、自分 1 人分なら 1 クエリで足りるため。
 */

const RECENT_WINDOW = 5
const TREND_LIMIT = 20

// ─────────────────────────────────────────────────────────────────────────────
//  GET /v1/sessions/:id/report
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **冪等であることが最重要**（api-spec.md §4）。
 * `reports` に既にあれば生成せず返す。二重生成するとスコアが上書きされ、
 * v0.2 で `member_stats` を入れたときに二重加算で評価データが壊れる。
 */
export async function getOrCreateReport(
  auth: AuthContext,
  sessionId: string,
): Promise<ReportPublic> {
  const owner = ownerIdOf(auth)
  const session = await sessionRepo.getSession(owner, sessionId)
  if (!session) throw errors.sessionNotFound()
  if (session.status !== 'completed') {
    throw errors.sessionCompleted('セッションが完了してからレポートを表示できます')
  }

  const existing = await reportRepo.getReport(owner, sessionId)
  if (existing) return toReportPublic(existing)

  const diagnosis = await secretRepo.getDiagnosis(sessionId)
  const path = pathOf(session)

  let narrative = {
    stumblingPoint: FALLBACK_REPORT.stumblingPoint,
    generalizedLesson: FALLBACK_REPORT.generalizedLesson,
    nextTimeSteps: [...FALLBACK_REPORT.nextTimeSteps],
  }
  const calls: LlmCallMeta[] = []
  try {
    const generated = await generateReport({
      errorText: session.errorText,
      rootCause: diagnosis?.rootCause ?? null,
      reachedGate: session.reachedGate ?? 'unresolved',
      path,
      retrospectionAnswer: retrospectionLabel(session),
    })
    calls.push(...generated.calls)
    narrative = {
      stumblingPoint: generated.data.stumblingPoint,
      generalizedLesson: generated.data.generalizedLesson,
      nextTimeSteps: generated.data.nextTimeSteps,
    }
  } catch (cause) {
    if (!(cause instanceof LlmError)) throw cause
    // レポート生成に失敗しても**スコアは出す**。スコアは純関数で LLM に依存しない（NFR-Q4）
    calls.push(...cause.calls)
    console.log(
      JSON.stringify({
        level: 'WARN',
        event: 'report.generation_failed',
        sessionId,
        reason: cause.reason,
        attempts: cause.calls.map((call) => ({ model: call.model, error: call.error })),
      }),
    )
  }

  const previousTotal = await previousTotalScore(auth, sessionId)
  const { score, explanation } = calculateScore({
    outcomes: outcomesOf(session),
    reachedGate: session.reachedGate,
    // 出題する段階数。対象外の軸を 0 点にしない（scope-v0.1 削る順序 #4）
    totalStages: session.totalStages,
    previousTotal,
    // 実務モードは横比較に使わない（NFR-F2）。データ構造で守る
    comparable: session.mode === 'assessment',
  })

  const report: ReportItem = {
    ownerId: owner,
    sessionId,
    summary: session.errorText.split('\n')[0]?.slice(0, 120) ?? '',
    language: session.language,
    status: session.status,
    mode: session.mode,
    problemId: session.problemId,
    reachedGate: session.reachedGate,
    reachedStage: lastReachedStage(session),
    difficulty: session.difficulty,
    path,
    stumblingPoint: narrative.stumblingPoint,
    generalizedLesson: narrative.generalizedLesson,
    nextTimeSteps: narrative.nextTimeSteps,
    // 完了後にのみ返る唯一の答えフィールド（data-model.md §3.3）
    revealedAnswer: diagnosis?.rootCause ?? null,
    score,
    scoreExplanation: explanation,
    comparable: session.mode === 'assessment',
    correctRate: correctRateOf(session),
    totalElapsedMs: totalElapsedOf(session),
    createdAt: Date.now(),
  }

  await reportRepo.putReport(report)

  if (calls.length > 0) {
    session.tokenUsed += totalTokens(calls)
    await recordLlmCalls(sessionId, calls)
    await sessionRepo.putSession(session)
  }
  // 実測コスト表（F11 / cost-model.md §5.4）の 1 行になる
  logSessionCost({ sessionId, reachedGate: session.reachedGate, calls })

  return toReportPublic(report)
}

/**
 * 前回スコア。**直近 2 件だけ引く**（1 アクセス）。
 * 成長率（FR-26 / v0.2）はまだ算出しないが、
 * 「前回比」は 1 件見れば出せるので v0.1 でも返す。
 */
async function previousTotalScore(auth: AuthContext, currentSessionId: string): Promise<number | null> {
  const reports = await reportRepo.listReports(ownerIdOf(auth), 2)
  const previous = reports.find((r) => r.sessionId !== currentSessionId)
  return previous?.score.total ?? null
}

/** 出題された段階の道筋。未出題の段階は載せない（実際に辿っていないため） */
function pathOf(session: SessionItem): StagePathPublic[] {
  return [...session.stageResults]
    .sort((a, b) => indexOfStage(a.stage) - indexOfStage(b.stage))
    .map((r) => ({
      stage: r.stage,
      attempts: r.attempts,
      // 表示も減点レベルに合わせる（自動提示の Lv1 を「使ったヒント」に数えない）
      hintLevel: penaltyLevelOf(r.hintLevel),
      elapsedMs: r.elapsedMs,
    }))
}

function outcomesOf(session: SessionItem): StageOutcome[] {
  const byStage = new Map(session.stageResults.map((r) => [r.stage, r]))
  return STAGES.map((stage) => {
    const result = byStage.get(stage)
    if (!result) {
      return {
        stage,
        attempts: 0,
        solved: false,
        // 未出題の段階には、セッション終了時点のヒントレベルを当てる
        hintLevel: penaltyLevelOf(session.hintLevel),
        elapsedMs: 0,
        asked: false,
      }
    }
    return {
      stage,
      attempts: result.attempts,
      solved: result.solved,
      hintLevel: penaltyLevelOf(result.hintLevel),
      elapsedMs: result.elapsedMs,
      asked: true,
    }
  })
}

function lastReachedStage(session: SessionItem): Stage | null {
  const solved = session.stageResults.filter((r) => r.solved)
  const last = solved[solved.length - 1]
  return last?.stage ?? null
}

function correctRateOf(session: SessionItem): number | null {
  const answered = session.turns.filter((t) => t.kind === 'question' && t.answeredAt !== undefined)
  if (answered.length === 0) return null
  const correct = answered.filter((t) => t.isCorrect === true).length
  return correct / answered.length
}

/**
 * セッションに向き合っていた時間。
 *
 * **中断していた時間（`awayMs`）は引く。** 引かないと「昨日始めて今日終えた」が
 * 20 時間として記録され、学習時間の集計（FR-24）が意味を失う。
 *
 * > **v0.1 の途中で意味が変わった値である。** 中断の記録を持つ前に作られた
 * > レポートはカレンダー時間のまま入っている。セッション数が少なく、そもそも
 * > 横比較に耐えない段階なので（evaluation-model.md §3.5）許容しているが、
 * > 混在していることは data-model.md に書いてある。
 */
function totalElapsedOf(session: SessionItem): number {
  if (session.completedAt) {
    return Math.max(0, session.completedAt - session.startedAt - session.awayMs)
  }
  // 未完了なら設問ごとの実測を足す。こちらは元から中断の影響を受けない
  return session.turns.reduce((sum, t) => sum + (t.elapsedMs ?? 0), 0)
}

function retrospectionLabel(session: SessionItem): string | null {
  const selected = session.retrospection?.selectedOptionId
  if (!selected) return session.retrospection?.note ?? null
  const labels: Record<string, string> = {
    a: 'エラーメッセージの読み取り',
    b: '変更点の洗い出し',
    c: '原因の推論',
    d: '仮説の確かめ方',
  }
  return labels[selected] ?? null
}

function toReportPublic(report: ReportItem): ReportPublic {
  return {
    sessionId: report.sessionId,
    mode: report.mode,
    reachedGate: report.reachedGate,
    path: report.path,
    stumblingPoint: report.stumblingPoint,
    generalizedLesson: report.generalizedLesson,
    nextTimeSteps: report.nextTimeSteps,
    revealedAnswer: report.revealedAnswer,
    score: report.score,
    // **必須フィールド**。算出根拠を返さないレポートを作らない（NFR-F1）
    scoreExplanation: report.scoreExplanation,
    createdAt: report.createdAt,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /v1/me/sessions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 履歴一覧（FR-14 / api-spec.md §3.9）。
 *
 * スコアを併記するため `sessions` と `reports` の 2 クエリを撃つ。
 * セッションごとにレポートを引くと N+1 になり、E4（アクセス枠）を食う。
 */
export async function listMySessions(
  auth: AuthContext,
  query: ListSessionsQuery,
): Promise<{ sessions: SessionSummaryPublic[]; nextStartKey: string | null }> {
  const owner = ownerIdOf(auth)
  const [page, reports] = await Promise.all([
    sessionRepo.listSessions(owner, {
      limit: query.limit,
      ...(query.startKey === undefined ? {} : { startKey: query.startKey }),
    }),
    reportRepo.listReports(owner, Math.max(query.limit, 20)),
  ])

  const scoreBySession = new Map(reports.map((r) => [r.sessionId, r.score.total]))
  return {
    sessions: page.sessions.map((s) => toSessionSummary(s, scoreBySession.get(s.sessionId) ?? null)),
    nextStartKey: page.nextStartKey,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /v1/me/stats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 個人ダッシュボード（FR-24）。`reports` の 1 クエリから集計する。
 *
 * 成長率（FR-26）と `timeIndex` は v0.2。
 * **セッション数が溜まらないと意味のある値が出ない**ため、v0.1 では出さない
 * （scope-v0.1.md §5）。「0% 成長」と表示されるより、無い方が正確である。
 */
export async function getMyStats(auth: AuthContext): Promise<MeStatsPublic> {
  const reports = await reportRepo.listReports(ownerIdOf(auth), 100)

  const gateCounts = { A: 0, B: 0, C: 0, unresolved: 0 }
  for (const report of reports) {
    if (report.reachedGate) gateCounts[report.reachedGate] += 1
    else gateCounts.unresolved += 1
  }

  const completed = gateCounts.A + gateCounts.B + gateCounts.C
  const ratio = (n: number) => (completed === 0 ? 0 : n / completed)

  const recent = reports.slice(0, RECENT_WINDOW)
  const recentAxes = recent.length === 0 ? null : averageAxes(recent)
  const correctRates = reports
    .map((r) => r.correctRate)
    .filter((r): r is number => r !== null && r !== undefined)

  return {
    sessionCount: reports.length,
    totalElapsedMs: reports.reduce((sum, r) => sum + (r.totalElapsedMs ?? 0), 0),
    gateDistribution: {
      A: ratio(gateCounts.A),
      B: ratio(gateCounts.B),
      C: ratio(gateCounts.C),
      // **未完了は分母に混ぜない。** ヒントだけで解決して戻らなかった人
      // （最良の結末）も未完了になるため、自力解決率を歪める（evaluation-model.md §2.2）
      unresolved: reports.length === 0 ? 0 : gateCounts.unresolved / reports.length,
    },
    selfReachRate: ratio(gateCounts.A + gateCounts.B),
    recentAxes,
    correctRate:
      correctRates.length === 0
        ? null
        : correctRates.reduce((a, b) => a + b, 0) / correctRates.length,
    weakestAxis: recentAxes ? weakestAxis(recentAxes) : null,
    trend: reports.slice(0, TREND_LIMIT).map((r) => ({
      sessionId: r.sessionId,
      total: r.score.total,
      gate: r.reachedGate,
      at: r.createdAt,
    })),
  }
}

/**
 * 直近セッションの 5 軸平均。
 *
 * **出題対象外（null）の軸は平均に混ぜない。** 段階数を絞った運用では
 * 検証・修正が出題されないことがあり、それを 0 として平均すると
 * 「使えば使うほど下がる軸」ができてしまう。
 * 一度も採点されていない軸は `null` のままにする。
 */
function averageAxes(reports: readonly ReportItem[]): ScoreAxes {
  const axes: ScoreAxes = { observe: null, localize: null, hypothesize: null, verify: null, fix: null }
  for (const stage of STAGES) {
    const values = reports
      .map((report) => report.score[stage])
      .filter((value): value is number => value !== null && value !== undefined)
    if (values.length === 0) continue
    axes[stage] = Math.round(values.reduce((a, b) => a + b, 0) / values.length)
  }
  return axes
}

/** 育成の示唆に使う軸のラベル（evaluation-model.md §5.2） */
export function axisLabel(stage: Stage): string {
  return STAGE_LABELS[stage].name
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /v1/sessions/:id/cost
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 1 セッションの実測コスト（F11 / cost-model.md §4）。
 *
 * **api-spec.md には無いエンドポイント。** 実測コスト表（§5.4）を埋めるには
 * `ops_logs` を読む手段が要り、それが無いと実行環境のログを人が見るしかない。
 * デモ台本 #6「コストログを見せる」も画面から出せないままになる。
 *
 * `ops_logs` のメインキーは `sessionId` で `ownerId` を含まないため、
 * **先に `sessions` を読んで所有者を確認してから**でなければ呼んではならない。
 */
export async function getSessionCost(auth: AuthContext, sessionId: string) {
  const session = await sessionRepo.getSession(ownerIdOf(auth), sessionId)
  if (!session) throw errors.sessionNotFound()

  if (!opsLogEnabled()) {
    return {
      sessionId,
      enabled: false,
      reachedGate: session.reachedGate,
      calls: [],
      summary: emptySummary(),
      note: 'OPS_LOG_ENABLED が false のため、コストは実行環境の標準ログにのみ出力されています',
    }
  }

  const logs = await opsRepo.listOpsLogs(sessionId, 200)
  const byRole: Record<string, number> = {}
  const summary = logs.reduce(
    (acc, log) => {
      byRole[log.role] = (byRole[log.role] ?? 0) + (log.estimatedCostUsd ?? 0)
      return {
        promptTokens: acc.promptTokens + log.promptTokens,
        completionTokens: acc.completionTokens + log.completionTokens,
        costUsd: acc.costUsd + (log.estimatedCostUsd ?? 0),
        costJpy: acc.costJpy + (log.estimatedCostJpy ?? 0),
        quality: acc.quality + (log.tier === 'quality' ? 1 : 0),
        cheap: acc.cheap + (log.tier === 'cheap' ? 1 : 0),
        // 単価表に無いモデルは合計に混ぜず件数だけ数える（0 円と誤解させない）
        unknownPrice: acc.unknownPrice + (log.estimatedCostUsd === null ? 1 : 0),
        leakGuardHits: acc.leakGuardHits + (log.leakGuardHit ? 1 : 0),
        errors: acc.errors + (log.error === null ? 0 : 1),
        latencyMs: acc.latencyMs + log.latencyMs,
      }
    },
    emptySummary(),
  )

  return {
    sessionId,
    enabled: true,
    reachedGate: session.reachedGate,
    calls: logs,
    summary: { ...summary, callCount: logs.length, breakdownUsd: byRole },
    note: null,
  }
}

function emptySummary() {
  return {
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    costJpy: 0,
    quality: 0,
    cheap: 0,
    unknownPrice: 0,
    leakGuardHits: 0,
    errors: 0,
    latencyMs: 0,
  }
}
