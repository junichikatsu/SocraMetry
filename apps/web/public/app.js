// @ts-check
/*
  v0.1 の暫定フロントエンド。**登録とログインだけ**を扱う。
  フレームワークなし・ビルド工程なし（ADR-013）。fetch と DOM 操作のみ。

  ★ LLM の出力とユーザー入力を DOM に入れるときは textContent を使う。
    innerHTML は使わない。React のような自動エスケープがないため
    （security.md §7 / ADR-013）。
*/
;(() => {
  'use strict'

  /**
   * API は相対パスで呼ぶ。**関数から同一オリジンで配信している**ため、
   * ベース URL の環境変数も CORS 設定も要らない（ADR-012）。
   *
   * ただし HTTP トリガーのパス（例 `/socrametry`）配下に置かれるため、
   * ルート相対（`/v1/...`）ではなく**現在のディレクトリからの相対**にする。
   * `/v1/...` にすると `https://host/v1/...` を叩いてトリガーの外に出てしまう。
   */
  const API_BASE = new URL('.', location.href).pathname.replace(/\/$/, '')

  const $ = (id) => document.getElementById(id)

  const el = {
    auth: $('auth'),
    me: $('me'),
    error: $('error'),
    mockBadge: $('mock-badge'),
    buildInfo: $('build-info'),
    tabLogin: $('tab-login'),
    tabSignup: $('tab-signup'),
    formLogin: $('form-login'),
    formSignup: $('form-signup'),
    meName: $('me-name'),
    meEmail: $('me-email'),
    meId: $('me-id'),
    btnHistory: $('btn-history'),
    btnLogout: $('btn-logout'),
    historyResult: $('history-result'),
  }

  // ── API 呼び出し ───────────────────────────────────────────────────────

  /** サーバが返すエラー（`{ error: { code, message, detail } }`）を保持する */
  class ApiError extends Error {
    constructor(status, body) {
      const error = body && body.error ? body.error : null
      super((error && error.message) || `通信に失敗しました (HTTP ${status})`)
      this.status = status
      this.code = (error && error.code) || 'UNKNOWN'
      this.detail = error ? error.detail : null
    }
  }

  async function api(method, path, body) {
    let res
    try {
      res = await fetch(API_BASE + path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      // 通信そのものが失敗した場合も画面を止めない（FR-17）
      throw new ApiError(0, null)
    }

    // 204 や空応答でも落ちないようにする
    const text = await res.text()
    let parsed = null
    try {
      parsed = text === '' ? null : JSON.parse(text)
    } catch {
      parsed = null
    }

    if (!res.ok) throw new ApiError(res.status, parsed)
    return parsed
  }

  // ── 表示 ───────────────────────────────────────────────────────────────

  function showError(err) {
    let message = err instanceof ApiError ? `${err.message}（${err.code}）` : String(err)
    // 503 の operation など、原因の切り分けに要る情報はそのまま見せる
    if (err instanceof ApiError && err.detail) {
      message += `\n${JSON.stringify(err.detail, null, 2)}`
    }
    el.error.textContent = message
    el.error.hidden = false
  }

  function clearError() {
    el.error.textContent = ''
    el.error.hidden = true
  }

  function showAuth() {
    el.auth.hidden = false
    el.me.hidden = true
  }

  function showMe(me) {
    el.meName.textContent = me.displayName
    el.meEmail.textContent = me.email
    el.meId.textContent = me.userId
    el.auth.hidden = true
    el.me.hidden = false
    el.historyResult.hidden = true
  }

  /** 送信中はボタンを無効にする。二重送信の最終防御はサーバ側の冪等性 */
  async function withBusy(button, fn) {
    button.disabled = true
    try {
      await fn()
    } catch (err) {
      showError(err)
    } finally {
      button.disabled = false
    }
  }

  function selectTab(which) {
    const isLogin = which === 'login'
    el.tabLogin.setAttribute('aria-selected', String(isLogin))
    el.tabSignup.setAttribute('aria-selected', String(!isLogin))
    el.formLogin.hidden = !isLogin
    el.formSignup.hidden = isLogin
    clearError()
  }

  function valuesOf(form) {
    const data = new FormData(form)
    const result = {}
    for (const [key, value] of data.entries()) result[key] = String(value)
    return result
  }

  // ── 起動 ───────────────────────────────────────────────────────────────

  async function loadHealth() {
    try {
      const health = await api('GET', '/v1/health')
      // MOCK モードであることを明示する（ADR-014）
      el.mockBadge.hidden = health.mockMode !== true
      el.buildInfo.textContent = `version ${health.version} / commit ${String(health.commit).slice(0, 7)}`
      if (health.configOk === false) {
        showError(
          new ApiError(500, {
            error: {
              code: 'CONFIG_INCOMPLETE',
              message: `サーバの環境変数が ${health.configMissing} 件不足しています`,
              detail: null,
            },
          }),
        )
      }
    } catch {
      // ヘルスチェックの失敗で画面を止めない。ログインは試させる
    }
  }

  async function restoreSession() {
    try {
      const { me } = await api('GET', '/v1/me')
      showMe(me)
    } catch (err) {
      // 未ログインは異常ではないのでエラー表示しない
      if (!(err instanceof ApiError) || err.code !== 'UNAUTHENTICATED') showError(err)
      showAuth()
    }
  }

  el.tabLogin.addEventListener('click', () => selectTab('login'))
  el.tabSignup.addEventListener('click', () => selectTab('signup'))

  el.formLogin.addEventListener('submit', (event) => {
    event.preventDefault()
    const button = el.formLogin.querySelector('button[type="submit"]')
    withBusy(button, async () => {
      clearError()
      const { me } = await api('POST', '/v1/auth/login', valuesOf(el.formLogin))
      el.formLogin.reset()
      showMe(me)
    })
  })

  el.formSignup.addEventListener('submit', (event) => {
    event.preventDefault()
    const button = el.formSignup.querySelector('button[type="submit"]')
    withBusy(button, async () => {
      clearError()
      const { me } = await api('POST', '/v1/auth/signup', valuesOf(el.formSignup))
      el.formSignup.reset()
      showMe(me)
    })
  })

  el.btnLogout.addEventListener('click', () => {
    withBusy(el.btnLogout, async () => {
      clearError()
      await api('POST', '/v1/auth/logout')
      showAuth()
      selectTab('login')
    })
  })

  /**
   * 履歴の取得。**データストアへの読み書きが実際に動いているか**を
   * 画面から確認できるようにするためのボタン（curl を叩かずに済むように）。
   */
  el.btnHistory.addEventListener('click', () => {
    withBusy(el.btnHistory, async () => {
      clearError()
      const result = await api('GET', '/v1/me/sessions')
      const count = result.sessions.length
      el.historyResult.textContent =
        count === 0
          ? 'セッションはまだありません（データストアの読み出しは成功しています）。'
          : `${count} 件のセッションがあります。最新: ${result.sessions[0].summary}`
      el.historyResult.hidden = false
    })
  })

  loadHealth()
  restoreSession()
})()
