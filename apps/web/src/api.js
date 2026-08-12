// @ts-check
/**
 * API 呼び出し。**呼び出し規約そのもの**なので、画面の作り替えでは触らない層。
 * 暫定画面（PR #13）からそのまま引き継いでいる。
 */

/**
 * API は相対パスで呼ぶ（ADR-012: 同一オリジン配信）。
 * HTTP トリガーのパス配下に置かれるため、ルート相対ではなく
 * **現在のパスを基準**にする。`/v1/...` を直に叩くとトリガーの外に出る。
 */
const API_BASE = location.pathname.endsWith('/')
  ? location.pathname.slice(0, -1)
  : location.pathname

export class ApiError extends Error {
  constructor(status, body) {
    const error = body && body.error ? body.error : null
    super((error && error.message) || `通信に失敗しました (HTTP ${status})`)
    this.status = status
    this.code = (error && error.code) || 'NETWORK_ERROR'
    this.detail = error ? error.detail : null
  }
}

/** 直近の通信ログ。生レスポンスパネル用。**本文は画面から出さない** */
export const wire = []

/** @type {null | (() => void)} */
let onWire = null

/** @param {() => void} fn */
export function setWireListener(fn) {
  onWire = fn
}

function recordWire(entry) {
  wire.unshift(entry)
  if (wire.length > 30) wire.pop()
  onWire?.()
}

/**
 * `2xx` 以外は例外にする。ただし `202` は**エラーではなく待機**なので
 * 正常系として返す（api-spec.md §3.5）。
 */
export async function api(method, path, body) {
  const startedAt = Date.now()
  let res
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    recordWire({ method, path, status: 0, ms: Date.now() - startedAt, body: '(通信失敗)' })
    throw new ApiError(0, null)
  }

  const text = await res.text()
  let parsed = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = null
  }

  recordWire({
    method,
    path,
    status: res.status,
    ms: Date.now() - startedAt,
    body: parsed === null ? text.slice(0, 2000) : JSON.stringify(parsed, null, 2),
  })

  if (!res.ok) throw new ApiError(res.status, parsed)
  return { status: res.status, data: parsed }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `202 Accepted` が返る間、同じリクエストを再送する（ADR-006 / api-spec.md §3.5）。
 * 回答は既に記録済みなので、再送しても二重にならない（サーバ側の冪等性）。
 *
 * @param {() => void} [onWait] 待機に入るたびに呼ばれる。画面側で
 *        「先輩が考えている」表示を出し続けるために使う（ADR-007）
 */
export async function apiWithRetry(method, path, body, onWait, maxRetries = 6) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const result = await api(method, path, body)
    const pending = result.data && result.data.pending
    if (result.status !== 202 || !pending) return result
    onWait?.()
    await sleep(pending.retryAfterMs || 3000)
  }
  throw new ApiError(504, {
    error: {
      code: 'DIAGNOSIS_TIMEOUT',
      message: '診断に時間がかかっています。もう一度お試しください',
      detail: null,
    },
  })
}
