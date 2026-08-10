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

  const request = {
    model,
    max_tokens: maxTokensFor(params.role),
    temperature: temperatureFor(params.role),
    messages: [
      { role: 'system' as const, content: params.system },
      { role: 'user' as const, content: params.user },
    ],
  }

  /**
   * `response_format` を**受け付けないモデルがある。**
   * OrcaRouter は複数プロバイダをまたぐゲートウェイなので、
   * OpenAI 互換とはいえ対応状況が揃っていない。
   *
   * 400 が返ったら**このパラメータを外して 1 回だけ**やり直す。
   * 生成前に弾かれた失敗はトークンを消費しないため、退避モデルへ移るより安い。
   * JSON の抽出はどちらの経路でも `extractJson` が受け持つ。
   */
  let completion
  let response
  try {
    const withFormat = await client(params.role)
      .chat.completions.create({ ...request, response_format: { type: 'json_object' } })
      .withResponse()
    completion = withFormat.data
    response = withFormat.response
  } catch (cause) {
    if (!isBadRequest(cause)) throw cause
    const plain = await client(params.role).chat.completions.create(request).withResponse()
    completion = plain.data
    response = plain.response
  }

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

  const parsed = extractJson(choice?.message?.content ?? '')
  if (parsed === undefined) throw new LlmError(params.role, 'invalid_output', 'not json')

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

/** 生成前に弾かれたか（パラメータ非対応など）。トークンを消費していない */
function isBadRequest(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'status' in cause && cause.status === 400
}

/**
 * 応答から JSON を取り出す。
 *
 * **素の `JSON.parse` では実モデルに耐えない。**
 * `response_format` を指定しても、あるいは指定できないモデルでは、
 * ```` ```json ```` で囲む・前置きの一文を添える、といった応答が現れる。
 * これを「生成失敗」にすると、正しい内容が入っているのに定型テンプレートへ落ち、
 * 体験が劣化するうえ LLM 料金だけが発生する。
 *
 * ただし**寛容にするのは取り出し方だけ**で、中身の検証は Zod が行う。
 * 構造が違う出力はここを通っても弾かれる。
 */
export function extractJson(content: string): unknown {
  const candidates: string[] = []
  const trimmed = content.trim()
  candidates.push(trimmed)

  // ```json ... ``` / ``` ... ``` を剥がす
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fenced?.[1]) candidates.push(fenced[1].trim())

  // 前後に文が付いている場合に備え、最初の { から最後の } までを試す
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1))

  for (const candidate of candidates) {
    if (candidate === '') continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      // 配列や数値だけの応答は、このアプリのスキーマでは必ず不正
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
    } catch {
      // 次の候補を試す
    }
  }
  return undefined
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
