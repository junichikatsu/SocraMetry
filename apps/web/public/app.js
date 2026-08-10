// @ts-check
/*
  ⚠️ 暫定実装。**正式なデザインのフロントエンドで置き換える前提**です。

  フレームワークなし・ビルド工程なし（ADR-013）。fetch と DOM 操作のみ。
  1 枚の HTML の中で状態が進む（ページ遷移をしない）。

  置き換え時に流用できるよう、次の 3 層に分けてあります。
    1. api()      … API 呼び出しと生ログ。**ここは仕様そのものなので流用できる**
    2. flow 関数  … 3 ゲートの進行。API の呼び順が読める形にしてある
    3. render 関数… DOM 組み立て。置き換えで捨てる部分

  ★ textContent のみを使う。innerHTML は lint で禁止している。
    フレームワークの自動エスケープがないため、LLM の出力とユーザー入力を
    そのまま DOM に入れると XSS になる（security.md §7 / ADR-013）。
*/
;(() => {
  'use strict'

  /**
   * API は相対パスで呼ぶ（ADR-012: 同一オリジン配信）。
   * HTTP トリガーのパス配下に置かれるため、ルート相対ではなく
   * **現在のパスを基準**にする。`/v1/...` を直に叩くとトリガーの外に出る。
   */
  const API_BASE = location.pathname.endsWith('/')
    ? location.pathname.slice(0, -1)
    : location.pathname

  const LANGUAGES = [
    'typescript', 'javascript', 'python', 'java', 'go', 'ruby', 'php',
    'csharp', 'rust', 'kotlin', 'swift', 'sql', 'shell', 'other',
  ]
  const FRAMEWORKS = [
    'nextjs', 'react', 'vue', 'nuxt', 'node', 'express', 'hono', 'nestjs',
    'django', 'flask', 'fastapi', 'rails', 'spring', 'laravel', 'dotnet', 'none', 'other',
  ]

  /** 段階の日本語名（socratic-engine.md §3 / evaluation-model.md §2.1） */
  const STAGES = [
    { key: 'observe', name: '観察', ability: 'エラーを正確に読めるか' },
    { key: 'localize', name: '切り分け', ability: '問題箇所を絞れるか' },
    { key: 'hypothesize', name: '仮説', ability: '原因を推論できるか' },
    { key: 'verify', name: '検証', ability: '仮説を確かめられるか' },
    { key: 'fix', name: '修正', ability: '再発しない直し方を選べるか' },
  ]
  const stageName = (key) => STAGES.find((s) => s.key === key)?.name ?? key

  /** ADR-007: ローディングを進捗バーではなく「先輩が考えている」表現にする */
  const THINKING = [
    'ふむ…ログを見せてもらっています。',
    'なるほど。少し確認させてください。',
    'では、一つ聞かせてください。',
    'ちょっと待ってください、いま見ています。',
  ]

  const $ = (id) => document.getElementById(id)
  const el = {}
  for (const id of [
    'auth', 'compose', 'session', 'history', 'error', 'thinking', 'me-chip',
    'mock-badge', 'build-info', 'tab-login', 'tab-signup', 'form-login', 'form-signup',
    'form-compose', 'count-error', 'select-language', 'select-framework',
    'stage-list', 'diagnosis-state', 'gate-a', 'hint-list', 'btn-hint', 'btn-advance',
    'btn-declare-a', 'gate-b', 'question-stage', 'question-body', 'option-list',
    'answer-feedback', 'btn-hint-b', 'btn-declare-b', 'btn-reveal',
    'conclusion', 'form-conclusion', 'conclusion-feedback', 'conclusion-choices',
    'btn-conclusion-cancel', 'btn-back-to-questions', 'btn-reveal-2',
    'gate-c', 'reveal-cause', 'reveal-evidence', 'reveal-fix', 'reveal-prevention',
    'retrospection', 'retro-question', 'retro-options',
    'report', 'report-gate', 'report-lesson', 'report-stumbling', 'report-steps',
    'score-axes', 'score-total', 'score-formula', 'score-breakdown', 'report-path',
    'report-answer', 'cost-summary', 'cost-table',
    'btn-new-session', 'history-table', 'btn-reload-history',
    'btn-logout', 'wire', 'wire-list', 'btn-clear-wire',
  ]) {
    el[id] = $(id)
  }

  /** 画面の状態。1 セッション分だけ持てばよいので単純な object にしている */
  const state = {
    me: null,
    session: null,
    actions: null,
    question: null,
    questionShownAt: 0,
    hints: [],
  }

  // ═══ 1. API 呼び出し ════════════════════════════════════════════════════

  class ApiError extends Error {
    constructor(status, body) {
      const error = body && body.error ? body.error : null
      super((error && error.message) || `通信に失敗しました (HTTP ${status})`)
      this.status = status
      this.code = (error && error.code) || 'NETWORK_ERROR'
      this.detail = error ? error.detail : null
    }
  }

  const wire = []

  function recordWire(entry) {
    wire.unshift(entry)
    if (wire.length > 30) wire.pop()
    renderWire()
  }

  /**
   * `2xx` 以外は例外にする。ただし `202` は**エラーではなく待機**なので
   * 正常系として返す（api-spec.md §3.5）。
   */
  async function api(method, path, body) {
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
   * `202 Accepted` が返る間、同じリクエストを再送する（ADR-006）。
   * 回答は既に記録済みなので、再送しても二重にならない（サーバ側の冪等性）。
   */
  async function apiWithRetry(method, path, body, maxRetries = 6) {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const result = await api(method, path, body)
      const pending = result.data && result.data.pending
      if (result.status !== 202 || !pending) return result
      showThinking()
      await sleep(pending.retryAfterMs || 3000)
    }
    throw new ApiError(504, {
      error: { code: 'DIAGNOSIS_TIMEOUT', message: '診断に時間がかかっています。もう一度お試しください', detail: null },
    })
  }

  // ═══ 表示ヘルパ ══════════════════════════════════════════════════════════

  function showError(err) {
    let message = err instanceof ApiError ? `${err.message}（${err.code}）` : String(err)
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

  function showThinking() {
    el.thinking.textContent = THINKING[Math.floor(Math.random() * THINKING.length)]
    el.thinking.hidden = false
  }

  function hideThinking() {
    el.thinking.hidden = true
  }

  /** 送信中はボタンを無効化する。**防御はサーバの冪等性**（security.md §6） */
  async function withBusy(button, fn) {
    if (button) button.disabled = true
    showThinking()
    try {
      await fn()
      clearError()
    } catch (err) {
      showError(err)
    } finally {
      hideThinking()
      if (button) button.disabled = false
    }
  }

  function show(section) {
    for (const name of ['auth', 'compose', 'session', 'history']) {
      el[name].hidden = name !== section
    }
    if (section === 'session') el.history.hidden = true
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild)
  }

  function text(tag, content, className) {
    const node = document.createElement(tag)
    node.textContent = content
    if (className) node.className = className
    return node
  }

  function row(cells, isHead) {
    const tr = document.createElement('tr')
    for (const cell of cells) tr.appendChild(text(isHead ? 'th' : 'td', String(cell)))
    return tr
  }

  // ═══ 3. render ═══════════════════════════════════════════════════════════

  function renderWire() {
    clear(el['wire-list'])
    for (const entry of wire) {
      const li = document.createElement('li')
      const head = text('div', `${entry.status} ${entry.method} ${entry.path} — ${entry.ms}ms`, 'wire__head')
      if (entry.status >= 400 || entry.status === 0) head.classList.add('wire__head--bad')
      if (entry.status === 202) head.classList.add('wire__head--wait')
      li.appendChild(head)
      li.appendChild(text('pre', entry.body, 'wire__json'))
      el['wire-list'].appendChild(li)
    }
  }

  function renderGateProgress() {
    const session = state.session
    for (const node of document.querySelectorAll('.gate')) {
      const gate = node.getAttribute('data-gate')
      node.classList.toggle('gate--current', session && session.gate === gate)
      node.classList.toggle(
        'gate--done',
        Boolean(session) && ['A', 'B', 'C'].indexOf(gate) < ['A', 'B', 'C'].indexOf(session.gate),
      )
    }

    const list = el['stage-list']
    list.hidden = !session || session.gate !== 'B'
    if (list.hidden) return
    clear(list)
    for (const stage of STAGES.slice(0, session.totalStages)) {
      const li = text('li', stageName(stage.key), 'stages__item')
      if (stage.key === session.currentStage) li.classList.add('stages__item--current')
      list.appendChild(li)
    }
  }

  function renderDiagnosis() {
    const status = state.session ? state.session.diagnosisStatus : null
    const label = {
      pending: '先輩がログを読んでいます…（この間も設問には答えられます）',
      ready: '見立てが済んでいます。',
      failed: '見立てが取れませんでした。汎用の問いに切り替えて続けます。',
    }
    el['diagnosis-state'].textContent = status ? label[status] || '' : ''
  }

  function renderHints() {
    clear(el['hint-list'])
    for (const hint of state.hints) {
      const li = document.createElement('li')
      li.appendChild(text('span', `Lv${hint.level}`, 'hints__level'))
      li.appendChild(text('span', hint.body, 'hints__body'))
      el['hint-list'].appendChild(li)
    }
  }

  function renderActions() {
    const a = state.actions || {}
    el['btn-hint'].disabled = !a.canRequestHint
    el['btn-hint-b'].disabled = !a.canRequestHint
    el['btn-advance'].disabled = !a.canAdvanceToQuestions
    el['btn-declare-a'].disabled = !a.canDeclareConclusion
    el['btn-declare-b'].disabled = !a.canDeclareConclusion
    el['btn-reveal'].hidden = !a.canReveal
  }

  function renderQuestion(question) {
    state.question = question
    state.questionShownAt = Date.now()
    el['question-stage'].textContent = `${stageName(question.stage)} — ${question.seqInStage} 問目`
    el['question-body'].textContent = question.body
    el['answer-feedback'].hidden = true

    clear(el['option-list'])
    for (const option of question.options) {
      const button = text('button', `${option.id.toUpperCase()}. ${option.label}`, 'option')
      button.type = 'button'
      button.addEventListener('click', () => answer(option.id, button))
      el['option-list'].appendChild(button)
    }
  }

  function renderReveal(reveal, retrospection) {
    el['reveal-cause'].textContent = reveal.rootCause
    clear(el['reveal-evidence'])
    for (const line of reveal.evidence) el['reveal-evidence'].appendChild(text('li', line))
    el['reveal-fix'].textContent = reveal.fixDirection
    el['reveal-prevention'].textContent = reveal.prevention

    el['retro-question'].textContent = retrospection.question
    clear(el['retro-options'])
    for (const option of retrospection.options) {
      const button = text('button', `${option.id.toUpperCase()}. ${option.label}`, 'option')
      button.type = 'button'
      button.addEventListener('click', () => retrospect(option.id, button))
      el['retro-options'].appendChild(button)
    }
  }

  function renderReport(report) {
    const gateLabel = { A: 'Gate A — ヒントだけで自力到達（★★★）', B: 'Gate B — 設問の誘導で到達（★★）', C: 'Gate C — 解説で理解（★）' }
    el['report-gate'].textContent = gateLabel[report.reachedGate] || '未解決'

    el['report-lesson'].textContent = report.generalizedLesson
    el['report-stumbling'].textContent = report.stumblingPoint

    clear(el['report-steps'])
    for (const step of report.nextTimeSteps) el['report-steps'].appendChild(text('li', step))

    // 5 軸は棒で見せる。レーダー（SVG 手書き）は正式なフロントで作る
    clear(el['score-axes'])
    for (const stage of STAGES) {
      const value = report.score[stage.key]
      const wrap = document.createElement('div')
      wrap.className = 'axis'
      wrap.appendChild(text('span', stage.name, 'axis__name'))
      const bar = document.createElement('div')
      bar.className = 'axis__bar'
      const fill = document.createElement('div')
      fill.className = 'axis__fill'
      fill.style.width = `${Math.max(0, Math.min(100, value))}%`
      bar.appendChild(fill)
      wrap.appendChild(bar)
      wrap.appendChild(text('span', String(value), 'axis__value'))
      el['score-axes'].appendChild(wrap)
    }

    const previous = report.score.previousTotal
    el['score-total'].textContent =
      `総合 ${report.score.total}` +
      `（到達係数 ${report.score.gateFactor}）` +
      (previous === null || previous === undefined ? '' : ` / 前回 ${previous}`) +
      (report.score.comparable ? '' : ' ※実務モードのため横比較には使いません')

    // NFR-F1: 算出根拠を必ず見せる。説明できない数値を評価に使わせない
    el['score-formula'].textContent = report.scoreExplanation.formula
    clear(el['score-breakdown'])
    el['score-breakdown'].appendChild(row(['軸', 'base', 'ヒント係数', '難易度係数', '結果', '備考'], true))
    for (const line of report.scoreExplanation.breakdown) {
      el['score-breakdown'].appendChild(
        row([stageName(line.axis), line.base, line.hintPenalty, line.difficultyFactor, line.result, line.note || '']),
      )
    }

    clear(el['report-path'])
    if (report.path.length === 0) {
      el['report-path'].appendChild(row(['設問には進みませんでした'], false))
    } else {
      el['report-path'].appendChild(row(['段階', '試行', 'ヒント', '所要'], true))
      for (const step of report.path) {
        el['report-path'].appendChild(
          row([stageName(step.stage), `${step.attempts} 回`, `Lv${step.hintLevel}`, `${Math.round(step.elapsedMs / 1000)} 秒`]),
        )
      }
    }

    el['report-answer'].textContent = report.revealedAnswer || '（診断結果がないため表示できません）'
  }

  /**
   * 実測コスト（F11）。**モデル出し分けが効いていること**を数字で見せる部分。
   * 高品質は 1〜2 回、安価は 10 回以上、という偏りがそのまま出る。
   */
  function renderCost(cost) {
    clear(el['cost-table'])

    if (!cost.enabled) {
      el['cost-summary'].textContent = cost.note || ''
      return
    }
    if (cost.calls.length === 0) {
      el['cost-summary'].textContent =
        'LLM の呼び出し記録がありません（MOCK モードで実行した場合は記録しません）。'
      return
    }

    const s = cost.summary
    el['cost-summary'].textContent =
      `${s.callCount} 回（高品質 ${s.quality} / 安価 ${s.cheap}）` +
      ` — 入力 ${s.promptTokens} tok / 出力 ${s.completionTokens} tok` +
      ` — 約 ${s.costUsd.toFixed(4)} USD（約 ${s.costJpy.toFixed(1)} 円）` +
      (s.unknownPrice > 0 ? ` ※単価不明のモデルが ${s.unknownPrice} 件あり合計に含みません` : '')

    el['cost-table'].appendChild(row(['役割', 'モデル', '階層', '入力', '出力', '秒', 'USD'], true))
    for (const call of cost.calls) {
      el['cost-table'].appendChild(
        row([
          call.role,
          call.model,
          call.tier,
          call.promptTokens,
          call.completionTokens,
          (call.latencyMs / 1000).toFixed(1),
          call.estimatedCostUsd === null ? '単価不明' : call.estimatedCostUsd.toFixed(5),
        ]),
      )
    }
  }

  function renderHistory(sessions) {
    clear(el['history-table'])
    if (sessions.length === 0) {
      el['history-table'].appendChild(row(['まだセッションがありません'], false))
      return
    }
    el['history-table'].appendChild(row(['エラー', '到達', 'スコア', '状態'], true))
    for (const s of sessions) {
      el['history-table'].appendChild(
        row([s.summary, s.reachedGate || '—', s.totalScore === null ? '—' : s.totalScore, s.status]),
      )
    }
  }

  function setGateView(which) {
    el['gate-a'].hidden = which !== 'A'
    el['gate-b'].hidden = which !== 'B'
    el['gate-c'].hidden = which !== 'C'
    el['report'].hidden = which !== 'report'
    el['conclusion'].hidden = true
  }

  // ═══ 2. flow ═════════════════════════════════════════════════════════════

  function applySession(data) {
    if (data.session) state.session = data.session
    if (data.actions) state.actions = data.actions
    renderGateProgress()
    renderDiagnosis()
    renderActions()
  }

  async function startSession(form) {
    const values = {}
    for (const [key, value] of new FormData(form).entries()) {
      const trimmed = String(value).trim()
      if (trimmed !== '') values[key] = trimmed
    }

    const { data } = await api('POST', '/v1/sessions', { mode: 'live', ...values })
    state.hints = [data.hint]
    applySession(data)
    show('session')
    setGateView('A')
    renderHints()
    form.reset()
    updateCount()

    /**
     * **診断はここで投げっぱなしにする**（ADR-006）。
     * 利用者がヒントを読んでいる 20〜60 秒の間に、裏で完了する。
     * 完了を待たないので、失敗しても導線は止まらない。
     */
    api('POST', `/v1/sessions/${data.session.id}/diagnose`)
      .then((res) => {
        if (state.session && state.session.id === data.session.id) {
          state.session.diagnosisStatus = res.data.diagnosisStatus
          renderDiagnosis()
        }
      })
      .catch(() => {
        if (state.session) {
          state.session.diagnosisStatus = 'failed'
          renderDiagnosis()
        }
      })
  }

  async function requestHint() {
    const { data } = await api('POST', `/v1/sessions/${state.session.id}/hints`)
    state.hints.push(data.hint)
    applySession(data)
    renderHints()
    if (state.session.gate === 'B') {
      // Gate B ではヒントを設問の下に出す。段階が進んでも履歴として残す
      el['answer-feedback'].textContent = `ヒント Lv${data.hint.level}: ${data.hint.body}`
      el['answer-feedback'].hidden = false
    }
  }

  async function advance() {
    // 不可逆な遷移なので確認する（api-spec.md §3.4）
    const ok = window.confirm(
      '設問に進むと Gate A には戻れません（自力解決としての評価は得られません）。進みますか？',
    )
    if (!ok) return

    const { data } = await apiWithRetry('POST', `/v1/sessions/${state.session.id}/advance`)
    applySession(data)
    if (data.question) {
      setGateView('B')
      renderQuestion(data.question)
    }
  }

  async function answer(optionId, button) {
    await withBusy(button, async () => {
      const elapsedMs = Date.now() - state.questionShownAt
      const { data } = await apiWithRetry('POST', `/v1/sessions/${state.session.id}/answers`, {
        questionId: state.question.id,
        selectedOptionId: optionId,
        elapsedMs,
      })
      applySession(data)

      el['answer-feedback'].textContent =
        (data.result.isCorrect ? '◯ ' : '△ ') + data.result.feedback
      el['answer-feedback'].hidden = false

      if (data.nextQuestion) {
        renderQuestion(data.nextQuestion)
        el['answer-feedback'].hidden = false
      } else {
        // 全段階を通過。ここで完了にはならない。原因宣言と Gate C が残っている
        clear(el['option-list'])
        el['question-stage'].textContent = '設問はここまでです'
        el['question-body'].textContent =
          '原因が分かったなら宣言してください。まだ見えないなら解説を読めます。'
      }
    })
  }

  function openConclusion() {
    el['conclusion'].hidden = false
    el['conclusion-feedback'].hidden = true
    el['conclusion-choices'].hidden = true
    el['form-conclusion'].hidden = false
    el['form-conclusion'].querySelector('textarea').focus()
  }

  async function declareConclusion(form) {
    const body = new FormData(form).get('body')
    const { data } = await apiWithRetry('POST', `/v1/sessions/${state.session.id}/conclusion`, {
      body: String(body),
    })
    applySession(data)

    el['conclusion-feedback'].textContent = data.conclusion.feedback
    el['conclusion-feedback'].hidden = false

    if (data.conclusion.verdict === 'reached') {
      form.reset()
      el['form-conclusion'].hidden = true
      await loadReport()
      return
    }

    /**
     * `verdict: null`（「わかりません」など）は**設問に戻さない**（Q-15）。
     * 2 択を出して利用者に選ばせる。
     */
    el['conclusion-choices'].hidden = data.conclusion.verdict !== null
    el['btn-reveal-2'].hidden = !(state.actions && state.actions.canReveal)
  }

  async function reveal() {
    const { data } = await api('POST', `/v1/sessions/${state.session.id}/reveal`)
    applySession(data)
    setGateView('C')
    renderReveal(data.reveal, data.retrospection)
  }

  async function retrospect(optionId, button) {
    await withBusy(button, async () => {
      const { data } = await api('POST', `/v1/sessions/${state.session.id}/retrospect`, {
        selectedOptionId: optionId,
      })
      applySession(data)
      await loadReport()
    })
  }

  async function loadReport() {
    const { data } = await api('GET', `/v1/sessions/${state.session.id}/report`)
    setGateView('report')
    renderReport(data)

    // コストと履歴は本体ではないので、失敗してもレポートの表示を止めない
    api('GET', `/v1/sessions/${state.session.id}/cost`)
      .then((res) => renderCost(res.data))
      .catch(() => {
        el['cost-summary'].textContent = 'コストの記録を取得できませんでした。'
      })
    loadHistory().catch(() => {})
    el.history.hidden = false
  }

  async function loadHistory() {
    const { data } = await api('GET', '/v1/me/sessions')
    renderHistory(data.sessions)
  }

  async function afterLogin(me) {
    state.me = me
    el['me-chip'].textContent = `${me.displayName} さん`
    el['me-chip'].hidden = false
    show('compose')
    el.history.hidden = false
    await loadHistory().catch(() => {})
  }

  // ═══ 起動と配線 ═══════════════════════════════════════════════════════════

  function fillSelect(node, values) {
    node.appendChild(text('option', '（指定しない）'))
    for (const value of values) {
      const option = text('option', value)
      option.value = value
      node.appendChild(option)
    }
    node.firstChild.value = ''
  }

  function updateCount() {
    const textarea = el['form-compose'].querySelector('textarea[name="errorText"]')
    el['count-error'].textContent = String(textarea.value.length)
  }

  function selectTab(which) {
    const isLogin = which === 'login'
    el['tab-login'].setAttribute('aria-selected', String(isLogin))
    el['tab-signup'].setAttribute('aria-selected', String(!isLogin))
    el['form-login'].hidden = !isLogin
    el['form-signup'].hidden = isLogin
    clearError()
  }

  function valuesOf(form) {
    const result = {}
    for (const [key, value] of new FormData(form).entries()) result[key] = String(value)
    return result
  }

  function onSubmit(form, handler) {
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const button = form.querySelector('button[type="submit"]')
      withBusy(button, () => handler(form, button))
    })
  }

  fillSelect(el['select-language'], LANGUAGES)
  fillSelect(el['select-framework'], FRAMEWORKS)

  el['tab-login'].addEventListener('click', () => selectTab('login'))
  el['tab-signup'].addEventListener('click', () => selectTab('signup'))

  onSubmit(el['form-login'], async (form) => {
    const { data } = await api('POST', '/v1/auth/login', valuesOf(form))
    form.reset()
    await afterLogin(data.me)
  })

  onSubmit(el['form-signup'], async (form) => {
    const { data } = await api('POST', '/v1/auth/signup', valuesOf(form))
    form.reset()
    await afterLogin(data.me)
  })

  onSubmit(el['form-compose'], startSession)
  onSubmit(el['form-conclusion'], declareConclusion)

  el['form-compose']
    .querySelector('textarea[name="errorText"]')
    .addEventListener('input', updateCount)

  el['btn-hint'].addEventListener('click', () => withBusy(el['btn-hint'], requestHint))
  el['btn-hint-b'].addEventListener('click', () => withBusy(el['btn-hint-b'], requestHint))
  el['btn-advance'].addEventListener('click', () => withBusy(el['btn-advance'], advance))
  el['btn-declare-a'].addEventListener('click', openConclusion)
  el['btn-declare-b'].addEventListener('click', openConclusion)
  el['btn-conclusion-cancel'].addEventListener('click', () => {
    el['conclusion'].hidden = true
  })
  el['btn-back-to-questions'].addEventListener('click', () => {
    el['conclusion'].hidden = true
  })
  el['btn-reveal'].addEventListener('click', () => withBusy(el['btn-reveal'], reveal))
  el['btn-reveal-2'].addEventListener('click', () => withBusy(el['btn-reveal-2'], reveal))

  el['btn-new-session'].addEventListener('click', () => {
    state.session = null
    state.hints = []
    setGateView(null)
    show('compose')
    el.history.hidden = false
  })

  el['btn-reload-history'].addEventListener('click', () =>
    withBusy(el['btn-reload-history'], loadHistory),
  )

  el['btn-logout'].addEventListener('click', () =>
    withBusy(el['btn-logout'], async () => {
      await api('POST', '/v1/auth/logout')
      state.me = null
      state.session = null
      el['me-chip'].hidden = true
      el.history.hidden = true
      show('auth')
      selectTab('login')
    }),
  )

  el['btn-clear-wire'].addEventListener('click', () => {
    wire.length = 0
    renderWire()
  })

  async function loadHealth() {
    try {
      const { data } = await api('GET', '/v1/health')
      // MOCK モードであることを画面に明示する（ADR-014）
      el['mock-badge'].hidden = data.mockMode !== true
      el['build-info'].textContent = `version ${data.version} / commit ${String(data.commit).slice(0, 7)}`
      if (data.configOk === false) {
        showError(new ApiError(500, {
          error: {
            code: 'CONFIG_INCOMPLETE',
            message: `サーバの環境変数が ${data.configMissing} 件不足しています`,
            detail: null,
          },
        }))
      }
    } catch {
      // ヘルスチェックの失敗で画面を止めない
    }
  }

  async function restoreSession() {
    try {
      const { data } = await api('GET', '/v1/me')
      await afterLogin(data.me)
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'UNAUTHENTICATED') showError(err)
      show('auth')
    }
  }

  loadHealth()
  restoreSession()
})()
