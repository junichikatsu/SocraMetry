import {
  STAGES,
  type Gate,
  type ScoreExplanationPublic,
  type ScorePublic,
  type Stage,
} from '@socrametry/shared'

/**
 * スコア算出（FR-21 / evaluation-model.md §3）。
 *
 * **純関数。LLM もデータストアも呼ばない**（NFR-Q4）。
 * 評価に使う数値が実行のたびに変わってはならないため、
 * 同じセッションデータからは常に同じスコアが出る。
 *
 * ```
 * stage_score   = base × hint_penalty × difficulty_factor
 * session_score = Σ(stage_score × weight) × gate_factor
 * ```
 */

/** 1 問目で正解 = 100 / 2 問目 = 70 / 3 問目 = 40 / 未正解 = 0 */
export const ATTEMPT_BASE = [100, 70, 40] as const

/** ヒント Lv0 = 1.00 / Lv1 = 0.85 / Lv2 = 0.70 / Lv3 = 0.55 */
export const HINT_PENALTIES = [1.0, 0.85, 0.7, 0.55] as const

/** 切り分けと仮説が重い。実務で最も差がつく軸（evaluation-model.md §2.1） */
export const STAGE_WEIGHTS: Record<Stage, number> = {
  observe: 0.15,
  localize: 0.25,
  hypothesize: 0.25,
  verify: 0.2,
  fix: 0.15,
}

/**
 * 到達ゲートによる補正。**差をあえて小さくしている**（1.00 → 0.75）。
 * ここを 1.0 → 0.3 のように大きくすると、詰まった人が開示を避けて業務を止める
 * （evaluation-model.md §4.1 歪み #1 / NFR-F4）。
 *
 * 0.75 が「小さい差」と言えるかは、5 軸スコアが実際にどのレンジに出るかに依存する。
 * **Day 4 の実測で判断する**（未決 Q-4）。設定値なので直すのは 1 行。
 */
export const GATE_FACTORS: Record<Gate, number> = { A: 1.0, B: 0.9, C: 0.75 }

/** easy = 0.9 / medium = 1.0 / hard = 1.15（evaluation-model.md §4.3） */
export const DIFFICULTY_FACTORS = { easy: 0.9, medium: 1.0, hard: 1.15 } as const

/**
 * v0.1 で使う難易度係数は **1.0 固定**。
 *
 * 難易度正規化（FR-25）は演習問題（FR-34）が前提であり v0.2。
 * 実務モードの難易度は Diagnoser の推定値しかなく、
 * **推定値でスコアを補正すると「LLM の気分で点が動く」ことになり NFR-Q4 に反する。**
 * 係数の仕組みだけ入れておき、値は v0.2 で問題集の難易度を使う。
 */
export const V01_DIFFICULTY_FACTOR = 1.0

export type StageOutcome = {
  stage: Stage
  /** 出題数（= 試行回数）。未出題なら 0 */
  attempts: number
  /** その段階を正解で通過したか */
  solved: boolean
  /** その段階に取り組んだ時点のヒントレベル */
  hintLevel: number
  elapsedMs: number
  /** 出題されたか。Gate A で解決した場合はすべて false になる */
  asked: boolean
}

export type ScoreInput = {
  /** 5 軸すべてを渡す（未出題の段階も `asked: false` で含める） */
  outcomes: readonly StageOutcome[]
  reachedGate: Gate | null
  difficultyFactor?: number
  previousTotal?: number | null
  /** 横比較に使ってよいか。実務モードは常に false（NFR-F2） */
  comparable?: boolean
}

function baseFromAttempts(attempts: number, solved: boolean): number {
  if (!solved) return 0
  return ATTEMPT_BASE[Math.min(Math.max(attempts, 1), ATTEMPT_BASE.length) - 1] ?? 0
}

/**
 * ヒントレベルを**減点レベル**に変換する。
 *
 * Gate A の Lv1 は**セッション開始時に自動提示される**（socratic-engine.md §6）。
 * 全員に無条件で出るものを減点すると、全員が一律に下がるだけで情報量がない。
 * そのため減点は**利用者が自分の意思で開放した分**（Lv2 以降）から数える。
 *
 * この扱いは api-spec.md の 2 つの例を同時に満たす形でもある。
 * §3.1 はセッション作成時の `hintLevel` を 1 と書き、
 * §3.8 のレポート例は同じ状況の `observe` を `hintLevel: 0` と書いている。
 */
export function penaltyLevelOf(rawHintLevel: number): number {
  return Math.max(0, rawHintLevel - 1)
}

function hintPenalty(hintLevel: number): number {
  const index = Math.min(Math.max(hintLevel, 0), HINT_PENALTIES.length - 1)
  return HINT_PENALTIES[index] ?? 1.0
}

/**
 * 未出題の段階に得点を与えてよいか。
 *
 * **設計書に明示がなく、実装で決めた点。**（→ README / PR で明記）
 * 算出式をそのまま適用すると、**Gate A で自力解決した利用者の総合点が 0 になる。**
 * Gate A は「最上位評価（gate_factor 1.00）」と定義されている
 * （evaluation-model.md §2.2）ため、これは要件と矛盾する。
 *
 * そこで **自力で到達した場合（reachedGate が A / B）は、未出題の段階を
 * 「1 問目で正解した」と同等に扱う。** 原因に自力で到達できたのなら、
 * その道筋（観察→切り分け→仮説→検証→修正）は辿れているという解釈である。
 * ヒント使用分の減点は適用するため、ヒントに頼った人は満点にはならない。
 *
 * 逆に Gate C（開示を受けた）と未解決では、未出題の段階は 0 のままとする。
 */
function creditsUnaskedStages(reachedGate: Gate | null): boolean {
  return reachedGate === 'A' || reachedGate === 'B'
}

export function calculateScore(input: ScoreInput): {
  score: ScorePublic
  explanation: ScoreExplanationPublic
} {
  const difficultyFactor = input.difficultyFactor ?? V01_DIFFICULTY_FACTOR
  const gateFactor = GATE_FACTORS[input.reachedGate ?? 'C']
  const creditUnasked = creditsUnaskedStages(input.reachedGate)

  const byStage = new Map(input.outcomes.map((o) => [o.stage, o]))
  const axes: Record<Stage, number> = {
    observe: 0,
    localize: 0,
    hypothesize: 0,
    verify: 0,
    fix: 0,
  }
  const breakdown: ScoreExplanationPublic['breakdown'] = []
  let weighted = 0

  for (const stage of STAGES) {
    const outcome = byStage.get(stage)
    const asked = outcome?.asked ?? false
    const hintLevel = outcome?.hintLevel ?? 0

    let base: number
    let note: string | undefined
    if (asked) {
      base = baseFromAttempts(outcome?.attempts ?? 1, outcome?.solved ?? false)
    } else if (creditUnasked) {
      base = ATTEMPT_BASE[0]
      note = '出題前に自力で原因に到達したため、1 問目で正解した場合と同等に扱っています'
    } else {
      base = 0
      note = 'この段階には到達していません'
    }

    const penalty = hintPenalty(hintLevel)
    const stageScore = Math.round(base * penalty * difficultyFactor)
    const weight = STAGE_WEIGHTS[stage]

    axes[stage] = stageScore
    weighted += stageScore * weight
    breakdown.push({
      axis: stage,
      base,
      hintPenalty: penalty,
      difficultyFactor,
      weight,
      result: stageScore,
      ...(note === undefined ? {} : { note }),
    })
  }

  const total = Math.round(weighted * gateFactor)

  return {
    score: {
      ...axes,
      total,
      gateFactor,
      difficultyFactor,
      // 演習モードのみ算出できる（evaluation-model.md §3.3）。v0.1 は常に null
      timeIndex: null,
      previousTotal: input.previousTotal ?? null,
      comparable: input.comparable ?? false,
    },
    explanation: {
      formula: 'Σ(stage_score × weight) × gate_factor  /  stage_score = base × hint_penalty × difficulty_factor',
      docUrl: 'docs/evaluation-model.md#3-スコアの算出',
      breakdown,
    },
  }
}

/** 5 軸のうち最も低い軸。育成の示唆に使う（evaluation-model.md §5.2） */
export function weakestAxis(axes: Record<Stage, number>): Stage {
  return STAGES.reduce((worst, stage) => (axes[stage] < axes[worst] ? stage : worst), STAGES[0])
}
