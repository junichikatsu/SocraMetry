import OpenAI from 'openai'
import type { LlmRole } from '@socrametry/shared'
import type { ZodType } from 'zod'
import {
  fallbackModel,
  maxTokensFor,
  modelFor,
  orcaApiKey,
  orcaBaseUrl,
  temperatureFor,
  usdJpyRate,
} from './models'
import { estimateCostJpy, estimateCostUsd, tierOf } from './pricing'

/**
 * OrcaRouter クライアント（architecture.md §3）。
 *
 * OrcaRouter は OpenAI 互換なので、**公式 `openai` SDK の `baseURL` を差し替える**だけで
 * プロバイダをまたいだモデル出し分けができる。クライアントは 1 つのままでよい。
 *
 * `ORCAROUTER_API_KEY` はクラウド実行環境の環境変数にのみ存在し、
 * フロントエンドには絶対に置かない（NFR-S1 / security.md §2.1）。
 */

/** 1 回の LLM 呼び出しの記録。そのままコストログになる（cost-model.md §4.1） */
export type LlmCallMeta = {
  role: LlmRole
  model: string
  tier: string
  promptTokens: number
  completionTokens: number
  latencyMs: number
  estimatedCostUsd: number | null
  estimatedCostJpy: number | null
  orcaHeaders: Record<string, string>
  /** 退避モデルで再試行したか（NFR-O1） */
  fallbackUsed: boolean
  /** LeakGuard による再生成だったか。呼び出し側が後から立てる */
  leakGuardHit: boolean
  mocked: boolean
  error: string | null
}

export type LlmResult<T> = {
  data: T
  /** 再生成やフォールバックで複数回になりうるため配列 */
  calls: LlmCallMeta[]
}

/**
 * LLM 呼び出しの失敗。ルート層で `503 LLM_UNAVAILABLE` に写す。
 * **入力内容をメッセージに含めない**（security.md §2.3）。
 */
export class LlmError extends Error {
  constructor(
    readonly role: LlmRole,
    readonly reason: 'unconfigured' | 'request_failed' | 'invalid_output',
    readonly detail?: string,
  ) {
    super(`llm ${role} failed: ${reason}`)
    this.name = 'LlmError'
  }
}

let injected: OpenAI | null = null
let cached: OpenAI | null = null

/** テストから差し替える */
export function setOrcaClient(client: OpenAI | null): void {
  injected = client
  cached = null
}

function client(role: LlmRole): OpenAI {
  if (injected) return injected
  if (cached) return cached
  const apiKey = orcaApiKey()
  if (apiKey === '') throw new LlmError(role, 'unconfigured', 'ORCAROUTER_API_KEY')
  cached = new OpenAI({ apiKey, baseURL: orcaBaseUrl() })
  return cached
}

/** `X-Orca-*` ヘッダはどのプロバイダに流れたかの記録（NFR-O2） */
function pickOrcaHeaders(headers: Headers | undefined): Record<string, string> {
  const picked: Record<string, string> = {}
  if (!headers) return picked
  headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith('x-orca-')) picked[key.toLowerCase()] = value
  })
  return picked
}

type JsonCallParams<T> = {
  role: LlmRole
  system: string
  user: string
  schema: ZodType<T>
  /** モデルを明示指定する場合（フォールバック用） */
  model?: string
}

async function callOnce<T>(
  params: JsonCallParams<T>,
  model: string,
  fallbackUsed: boolean,
): Promise<{ data: T; meta: LlmCallMeta }> {
  const startedAt = Date.now()
  const baseMeta = {
    role: params.role,
    model,
    tier: tierOf(model),
    fallbackUsed,
    leakGuardHit: false,
    mocked: false,
  }

  const { data: completion, response } = await client(params.role)
    .chat.completions.create({
      model,
      max_tokens: maxTokensFor(params.role),
      temperature: temperatureFor(params.role),
      // 構造化出力。文章ではなく JSON を要求することで、
      // パースの失敗を「生成失敗」として扱えるようにする
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
    })
    .withResponse()

  const latencyMs = Date.now() - startedAt
  const promptTokens = completion.usage?.prompt_tokens ?? 0
  const completionTokens = completion.usage?.completion_tokens ?? 0
  const costUsd = estimateCostUsd(model, promptTokens, completionTokens)

  const meta: LlmCallMeta = {
    ...baseMeta,
    promptTokens,
    completionTokens,
    latencyMs,
    estimatedCostUsd: costUsd,
    estimatedCostJpy: estimateCostJpy(costUsd, usdJpyRate()),
    orcaHeaders: pickOrcaHeaders(response?.headers),
    error: null,
  }

  const choice = completion.choices[0]
  // 上限に達した出力は**使わない**（途中で切れた JSON を無理に通さない / cost-model.md §3）
  if (choice?.finish_reason === 'length') {
    throw new LlmError(params.role, 'invalid_output', 'max_tokens reached')
  }

  const content = choice?.message?.content ?? ''
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new LlmError(params.role, 'invalid_output', 'not json')
  }

  const validated = params.schema.safeParse(parsed)
  if (!validated.success) {
    throw new LlmError(params.role, 'invalid_output', 'schema mismatch')
  }

  return { data: validated.data, meta }
}

/**
 * 構造化 JSON を 1 回取得する。失敗したら**退避モデルで 1 回だけ**再試行する（NFR-O1）。
 *
 * 2 回以上は試さない。LLM の待ち時間はそのまま実行環境の実行時間として計上され、
 * タイムアウトに直結するため（NFR-P5 / NFR-C5）。
 */
export async function callJson<T>(params: JsonCallParams<T>): Promise<LlmResult<T>> {
  const primary = params.model ?? modelFor(params.role)
  if (primary === '') throw new LlmError(params.role, 'unconfigured', 'model id')

  const calls: LlmCallMeta[] = []
  try {
    const { data, meta } = await callOnce(params, primary, false)
    calls.push(meta)
    return { data, calls }
  } catch (primaryError) {
    const fallback = fallbackModel()
    calls.push(failedMeta(params.role, primary, false, primaryError))
    if (!fallback || fallback === primary) throw asLlmError(params.role, primaryError)

    try {
      const { data, meta } = await callOnce(params, fallback, true)
      calls.push(meta)
      return { data, calls }
    } catch (fallbackError) {
      calls.push(failedMeta(params.role, fallback, true, fallbackError))
      throw asLlmError(params.role, fallbackError)
    }
  }
}

function failedMeta(
  role: LlmRole,
  model: string,
  fallbackUsed: boolean,
  cause: unknown,
): LlmCallMeta {
  return {
    role,
    model,
    tier: tierOf(model),
    promptTokens: 0,
    completionTokens: 0,
    latencyMs: 0,
    estimatedCostUsd: null,
    estimatedCostJpy: null,
    orcaHeaders: {},
    fallbackUsed,
    leakGuardHit: false,
    mocked: false,
    // 例外のメッセージには入力が乗りうるため、種別だけを残す
    error: cause instanceof LlmError ? cause.reason : 'request_failed',
  }
}

function asLlmError(role: LlmRole, cause: unknown): LlmError {
  if (cause instanceof LlmError) return cause
  return new LlmError(role, 'request_failed')
}

/** MOCK モードの記録。実 LLM を呼んでいないことをログでも判別できるようにする */
export function mockMeta(role: LlmRole): LlmCallMeta {
  return {
    role,
    model: 'mock',
    tier: 'mock',
    promptTokens: 0,
    completionTokens: 0,
    latencyMs: 0,
    estimatedCostUsd: 0,
    estimatedCostJpy: 0,
    orcaHeaders: {},
    fallbackUsed: false,
    leakGuardHit: false,
    mocked: true,
    error: null,
  }
}
