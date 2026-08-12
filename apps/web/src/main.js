// @ts-check
/*
  SocraMetry — 画面（#27）。MOCK/ のデザインに沿う。

  フレームワークなし。バンドラだけを入れている（ADR-013 改訂）。
  入れた理由は**マスキングのプレビューでサーバと同じ純関数を使うため**だけで、
  DOM 操作は素の API のままにしてある。

  層はそのまま引き継いでいる。
    1. api.js     … API 呼び出しと生ログ。**仕様そのもの**なので触らない
    2. main.js    … 3 ゲートの進行。API の呼び順が読める形にしてある
    3. thread/report/dashboard/radar … 描画

  ★ textContent のみを使う。innerHTML は lint で禁止している（security.md §7）。
*/
import { api, ApiError, apiWithRetry } from './api.js'
import { byId, el } from './dom.js'
import { renderHistory, renderStats } from './dashboard.js'
import { retryLabel } from './format.js'
import * as maskPreview from './mask-preview.js'
import { costNodes, reportCard, revealNodes } from './report.js'
import { FRAMEWORKS, LANGUAGES, stageName } from './stages.js'
import * as thread from './thread.js'

/** 画面の状態。1 セッション分だけ持てばよいので単純な object にしている */
const state = {
  /** @type {null | import('@socrametry/shared').MePublic} */
  me: null,
  /** @type {null | import('@socrametry/shared').SessionPublic} */
  session: null,
  /** @type {null | import('@socrametry/shared').SessionActions} */
  actions: null,
  /** @type {null | import('@socrametry/shared').QuestionPublic} */
  question: null,
  questionShownAt: 0,
  hints: [],
  /** 'compose'（エラー投稿） | 'conclusion'（原因宣言） | 'locked' */
  composerMode: 'compose',
  /** 最後にキーを叩いた時刻。自動遷移の抑止に使う（socratic-engine.md §7 判断 3） */
  lastTypedAt: 0,
}

// ═══ 表示ヘルパ ════════════════════════════════════════════════════════════

function showError(err) {
  let message = err instanceof ApiError ? `${err.message}（${err.code}）` : String(err)

  if (err instanceof ApiError) {
    /**
     * **サーバは待ち時間を計算して `Retry-After` に入れている。**
     * それを出さずに「しばらく待ってから」とだけ言うと、待てば済むのか
     * 設定を見直すべきなのかが利用者に判断できない。
     */
    const wait = retryLabel(err.retryAfterSec)
    if (wait) message += `\n${wait}`
    if (err.detail) message += `\n${JSON.stringify(err.detail, null, 2)}`
  }

  const target = state.me ? byId('error') : byId('login-error')
  target.textContent = message
  target.hidden = false
}

function clearError() {
  for (const id of ['error', 'login-error']) {
    byId(id).textContent = ''
    byId(id).hidden = true
  }
}

/**
 * 送信中はボタンを無効化し、スレッドに「先輩が考えている」を出す（ADR-007）。
 * **防御はサーバの冪等性**（security.md §6）。見た目は誤解を減らすためのもの。
 */
async function withThinking(button, fn) {
  if (button) button.disabled = true
  const spinner = thread.thinking()
  try {
    await fn()
    clearError()
  } catch (err) {
    showError(err)
  } finally {
    spinner.remove()
    if (button) button.disabled = false
  }
}

/** スレッドの外（ログイン画面）で使う。こちらは「考えている」表示を出さない */
async function withBusy(button, fn) {
  if (button) button.disabled = true
  try {
    await fn()
    clearError()
  } catch (err) {
    showError(err)
  } finally {
    if (button) button.disabled = false
  }
}

function selectView(name) {
  for (const view of ['chat', 'dashboard', 'history']) {
    byId(`view-${view}`).hidden = view !== name
  }
  for (const item of document.querySelectorAll('.nav__item')) {
    item.classList.toggle('is-active', item.getAttribute('data-view') === name)
  }
}

// ═══ 入力欄 ════════════════════════════════════════════════════════════════

const COMPOSER = {
  compose: {
    placeholder: 'デバッグ対象のコード、エラーログ、または仮説を入力してください…',
    hint: 'エラーの本文を貼り付けてください。送信前にマスキングの結果を表示します。',
  },
  conclusion: {
    placeholder: '原因が分かったら、自分の言葉で書いてください…',
    /**
     * **「設問には戻しません」とは書かない。** Q-15 は「戻さない」ことが要件で、
     * 「戻さないと宣言する」ことではない。戻される可能性があったこと自体が
     * 利用者にとっては初耳で、書いた瞬間に不安を作る側に回る。
     */
    hint: '原因が分かったら宣言してください。まだ見えないなら、ヒントを増やすか設問に進めます。',
  },
  locked: { placeholder: 'このセッションは完了しています', hint: '' },
}

function setComposerMode(mode) {
  state.composerMode = mode
  const input = /** @type {HTMLTextAreaElement} */ (byId('composer-input'))
  input.placeholder = COMPOSER[mode].placeholder
  input.disabled = mode === 'locked'
  input.value = ''
  byId('composer-hint').textContent = COMPOSER[mode].hint
  byId('btn-send').hidden = mode === 'locked'
  // 言語・FW はセッションの属性なので、エラー投稿のときだけ出す
  byId('form-compose').querySelectorAll('.select').forEach((n) => {
    /** @type {HTMLElement} */ (n).hidden = mode !== 'compose'
  })
  maskPreview.reset()
  updateComposer()
}

function updateComposer() {
  const input = /** @type {HTMLTextAreaElement} */ (byId('composer-input'))
  byId('composer-count').textContent = String(input.value.length)
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 190)}px`
  // 送信前マスキングプレビュー（security.md §3 A）。**貼り付けた瞬間に出す**
  maskPreview.render(input.value)
}

// ═══ セッション状態 ════════════════════════════════════════════════════════

function applySession(data) {
  if (data.session) state.session = data.session
  if (data.actions) state.actions = data.actions
  scheduleAutoAdvance()
}

/** 上部のチップにゲートと段階を出す */
function renderTopbar() {
  const chip = byId('topbar-chip')
  const s = state.session
  if (!s) {
    chip.textContent = 'ソクラテス対話セッション'
    return
  }
  const stage = s.currentStage ? ` — ${stageName(s.currentStage)}（${s.stageIndex}/${s.totalStages}）` : ''
  chip.textContent = `Gate ${s.gate}${stage} / ヒント Lv${s.hintLevel}`
}

/** セッションが無いときの既定。**何も押せない**を明示的な値として持つ */
/** @type {import('@socrametry/shared').SessionActions} */
const NO_ACTIONS = {
  canRequestHint: false,
  canAdvanceToQuestions: false,
  canDeclareConclusion: false,
  canReveal: false,
}

/**
 * Gate A・B で出す行動ボタン。
 * **可否の判定はサーバの `actions` に従う。** クライアントに条件式を置くと、
 * ゲート遷移規則が 2 箇所に分かれて必ずずれる（socratic-engine.md §7）。
 */
function gateActions() {
  const a = state.actions ?? NO_ACTIONS
  const specs = []
  if (a.canRequestHint) {
    specs.push({ label: 'ヒントをもう一段', onClick: () => withThinking(null, requestHint) })
  }
  if (a.canAdvanceToQuestions) {
    specs.push({ label: '設問に進む', onClick: () => withThinking(null, () => advance(true)) })
  }
  if (a.canReveal) {
    specs.push({ label: '解説を読む', onClick: () => withThinking(null, reveal) })
  }
  // 押せるものが 1 つも無いなら、空の枠を置かない
  return specs.length === 0 ? null : thread.actionBar(specs)
}

// ═══ 時間経過による Gate A → B（#20 / FR-07）══════════════════════════════

/**
 * Lambda は定期実行を持てないため、**タイマーの置き場所はここしかない。**
 * 発火条件そのものはサーバが持っている（`core` の `autoAdvanceAt`）。
 * ここが受け取るのは残り時間（`session.autoAdvanceInMs`）だけ。
 */
let autoAdvanceTimer = null

/** 入力中は時間条件を適用しない（socratic-engine.md §7 判断 3） */
const TYPING_GRACE_MS = 20_000
/** 何秒前から予告を出すか */
const NOTICE_MS = 30_000

function clearAutoAdvance() {
  if (autoAdvanceTimer !== null) clearTimeout(autoAdvanceTimer)
  autoAdvanceTimer = null
  byId('thread').querySelectorAll('.countdown').forEach((n) => n.remove())
}

function scheduleAutoAdvance() {
  clearAutoAdvance()
  const remaining = state.session?.autoAdvanceInMs
  if (remaining === null || remaining === undefined) return

  if (remaining > NOTICE_MS) {
    // 予告の時刻まで待ってから、予告を出して残りを計り直す
    autoAdvanceTimer = setTimeout(() => armNotice(NOTICE_MS), remaining - NOTICE_MS)
    return
  }
  armNotice(remaining)
}

/**
 * 予告を出してから発火まで待つ。**黙って遷移させない。**
 * 不可逆な遷移（api-spec.md §3.4）なので、来ることが見えている必要がある。
 */
function armNotice(delay) {
  byId('thread').appendChild(
    el(
      'p',
      'countdown',
      'しばらく操作がないため、まもなく設問に移ります' +
        '（Gate A の評価はここまでになります）。入力を始めれば止まります。',
    ),
  )
  autoAdvanceTimer = setTimeout(() => fireAutoAdvance(), Math.max(0, delay))
}

function fireAutoAdvance() {
  // 入力中なら見送る。書いている最中に設問へ送られるのが最悪の体験
  if (Date.now() - state.lastTypedAt < TYPING_GRACE_MS) {
    autoAdvanceTimer = setTimeout(() => fireAutoAdvance(), TYPING_GRACE_MS)
    return
  }
  const input = /** @type {HTMLTextAreaElement} */ (byId('composer-input'))
  if (input.value.trim() !== '') {
    autoAdvanceTimer = setTimeout(() => fireAutoAdvance(), TYPING_GRACE_MS)
    return
  }
  clearAutoAdvance()
  thread.bot({ texts: ['時間が経ちましたので、設問に移ります。'] })
  withThinking(null, () => advance(false)).catch(() => {})
}

// ═══ flow ══════════════════════════════════════════════════════════════════

async function startSession() {
  const form = /** @type {HTMLFormElement} */ (byId('form-compose'))
  const input = /** @type {HTMLTextAreaElement} */ (byId('composer-input'))

  const raw = input.value.trim()
  if (raw === '') return

  /**
   * **マスク済みテキストだけを送る**（security.md §3）。
   * サーバ側でも同じ関数を再実行する（冪等）。正はサーバ側。
   */
  const errorText = maskPreview.mask(raw).text

  const values = { errorText }
  for (const key of ['language', 'framework']) {
    const value = /** @type {HTMLSelectElement} */ (form.querySelector(`[name="${key}"]`)).value
    if (value !== '') values[key] = value
  }

  thread.user({ who: state.me?.displayName ?? 'あなた', code: errorText })
  input.value = ''
  maskPreview.reset()
  updateComposer()

  const { data } = await api('POST', '/v1/sessions', { mode: 'live', ...values })
  state.hints = [data.hint]
  state.question = null
  applySession(data)
  renderTopbar()
  setComposerMode('conclusion')

  thread.bot({
    lead: 'エラーを直視し、学びを得る準備ができましたね。',
    texts: ['まず、着眼点だけをお渡しします。答えは言いません。'],
    nodes: [thread.hintList(state.hints), gateActions()],
  })

  /**
   * **診断はここで投げっぱなしにする**（ADR-006）。
   * 利用者がヒントを読んでいる 20〜60 秒の間に、裏で完了する。
   * 完了を待たないので、失敗しても導線は止まらない。**ここで待つと NFR-P1 を満たせない。**
   */
  api('POST', `/v1/sessions/${data.session.id}/diagnose`)
    .then((res) => {
      if (state.session?.id === data.session.id) {
        state.session.diagnosisStatus = res.data.diagnosisStatus
      }
    })
    .catch(() => {
      if (state.session) state.session.diagnosisStatus = 'failed'
    })
}

async function requestHint() {
  const { data } = await api('POST', `/v1/sessions/${state.session.id}/hints`)
  state.hints.push(data.hint)
  applySession(data)
  renderTopbar()
  thread.bot({
    texts: ['もう一段だけ、見る場所を絞ります。'],
    nodes: [thread.hintList([data.hint]), gateActions()],
  })
}

/**
 * Gate A → B。
 * @param {boolean} confirmFirst 利用者の操作なら確認する（api-spec.md §3.4）。
 *        **不可逆な遷移**で、以降 Gate A の評価は得られない
 */
async function advance(confirmFirst) {
  if (confirmFirst) {
    const ok = window.confirm(
      '設問に進むと Gate A には戻れません（自力解決としての評価は得られません）。進みますか？',
    )
    if (!ok) return
  }

  clearAutoAdvance()
  const { data } = await apiWithRetry(
    'POST',
    `/v1/sessions/${state.session.id}/advance`,
    undefined,
    () => {},
  )
  applySession(data)
  renderTopbar()
  if (data.question) showQuestion(data.question)
}

function showQuestion(question) {
  state.question = question
  state.questionShownAt = Date.now()
  thread.bot({
    texts: [`${stageName(question.stage)} — ${question.seqInStage} 問目`],
    callout: { label: '選択問題（Gate B）', body: question.body },
    nodes: [
      thread.optionList(question.options, (id) => {
        withThinking(null, () => answer(id))
      }),
      gateActions(),
    ],
  })
}

async function answer(optionId) {
  const elapsedMs = Date.now() - state.questionShownAt
  const { data } = await apiWithRetry(
    'POST',
    `/v1/sessions/${state.session.id}/answers`,
    { questionId: state.question.id, selectedOptionId: optionId, elapsedMs },
    () => {},
  )
  applySession(data)
  renderTopbar()

  thread.bot({
    lead: data.result.isCorrect ? '正解です。' : '惜しい。しかし、推測で片づけてはいけません。',
    texts: [data.result.feedback],
  })

  if (data.nextQuestion) {
    showQuestion(data.nextQuestion)
    return
  }

  // 全段階を通過。**ここで完了にはならない。** 原因宣言と Gate C が残っている
  thread.bot({
    texts: ['設問はここまでです。原因が分かったなら宣言してください。'],
    nodes: [gateActions()],
  })
}

async function declareConclusion() {
  const input = /** @type {HTMLTextAreaElement} */ (byId('composer-input'))
  const raw = input.value.trim()
  if (raw === '') return

  // 原因宣言も LLM に届く。**マスクしてから送る**（security.md §3）
  const body = maskPreview.mask(raw).text
  thread.user({ who: state.me?.displayName ?? 'あなた', text: body })
  input.value = ''
  maskPreview.reset()
  updateComposer()

  const { data } = await apiWithRetry(
    'POST',
    `/v1/sessions/${state.session.id}/conclusion`,
    { body },
    () => {},
  )
  applySession(data)
  renderTopbar()

  if (data.conclusion.verdict === 'reached') {
    thread.bot({ lead: '見事です。正確に本質を捉えています。', texts: [data.conclusion.feedback] })
    await loadReport()
    return
  }

  /**
   * 到達しなかった場合（`not_reached` と `verdict: null` のどちらも）。
   *
   * **サーバの `feedback` が、その場面での次の一手を既に書いている。**
   * 短すぎる入力なら「もう少し具体的に書いてください」、「わかりません」なら
   * 「設問に戻って絞り込むか、解説を読むかを選べます」といった具合に、
   * 理由ごとに文面が変わる（`session-service.ts` の原因宣言の分岐）。
   *
   * **画面はそこに言い足さない。** 以前はここで「設問に戻すことはしません」と
   * 出していたが、これは Q-15 の設計判断（「わかりません」を `not_reached` に
   * せず設問へ送り返さない）をそのまま利用者に向けて書いてしまったもので、
   * 利用者にとっては「戻される可能性があった」こと自体が初耳になる。
   * しかも隣に「設問に進む」ボタンが並ぶため、字面として矛盾していた。
   *
   * 出すのは他の場面と同じ**サーバの `actions` に従う行動ボタン**だけにする。
   * Q-15 は「戻さない」ことが要件であって、「戻さないと宣言する」ことではない。
   */
  thread.bot({
    texts: [data.conclusion.feedback],
    nodes: [gateActions()],
  })
  // 書き直せるようにする。入力欄は原因宣言モードのまま空いている
  byId('composer-input').focus()
}

async function reveal() {
  const { data } = await api('POST', `/v1/sessions/${state.session.id}/reveal`)
  applySession(data)
  renderTopbar()

  thread.bot({ lead: 'ここまでの経過をふまえて、原因をお伝えします。', nodes: revealNodes(data.reveal) })

  thread.bot({
    callout: { label: '振り返り', body: data.retrospection.question, calm: true },
    nodes: [
      thread.optionList(data.retrospection.options, (id) => {
        withThinking(null, () => retrospect(id))
      }),
    ],
  })
}

async function retrospect(optionId) {
  const { data } = await api('POST', `/v1/sessions/${state.session.id}/retrospect`, {
    selectedOptionId: optionId,
  })
  applySession(data)
  await loadReport()
}

async function loadReport() {
  clearAutoAdvance()
  setComposerMode('locked')

  const { data } = await api('GET', `/v1/sessions/${state.session.id}/report`)
  const bubble = thread.bot({ lead: 'セッションの結果です。', nodes: reportCard(data) })
  renderTopbar()

  // コストと集計は本体ではないので、失敗してもレポートの表示を止めない
  api('GET', `/v1/sessions/${state.session.id}/cost`)
    .then((res) => {
      const box = el('details', 'card')
      const summary = el('summary', 'card__title', 'この 1 セッションの実測コスト')
      box.appendChild(summary)
      for (const node of costNodes(res.data)) box.appendChild(node)
      bubble.appendChild(box)
    })
    .catch(() => {})

  loadStats().catch(() => {})
  loadHistory().catch(() => {})

  thread.bot({
    texts: ['お疲れさまでした。次のエラーに進めます。'],
    nodes: [thread.actionBar([{ label: '新しいセッションを始める', primary: true, onClick: newSession }])],
  })
}

async function loadHistory() {
  const { data } = await api('GET', '/v1/me/sessions')
  renderHistory(data.sessions)
}

async function loadStats() {
  const { data } = await api('GET', '/v1/me/stats')
  renderStats(data)
}

function newSession() {
  clearAutoAdvance()
  state.session = null
  state.actions = null
  state.question = null
  state.hints = []
  thread.reset()
  renderTopbar()
  setComposerMode('compose')
  selectView('chat')
  greet()
}

function greet() {
  thread.bot({
    lead: 'ようこそ、SocraMetry へ。あなたの参加を、心から歓迎します。',
    texts: [
      'ここは「答え」を渡す場所ではありません。あなた自身の思考を鍛え、' +
        'エラーの本質を見抜く力を磨く場です。私は問いを投げかけます。安易な正解は差し出しません。',
    ],
    callout: {
      label: 'はじめの一歩',
      body:
        'デバッグ対象のコード、エラーログ、または仮説を入力してください。\n' +
        '甘えは不要です。あなたが本気なら、私も本気で向き合います。',
    },
  })
}

// ═══ 認証 ══════════════════════════════════════════════════════════════════

async function afterLogin(me) {
  state.me = me
  byId('me-name').textContent = me.displayName
  byId('me-mail').textContent = me.email
  byId('login').hidden = true
  byId('app').hidden = false
  clearError()
  newSession()
  await Promise.all([loadHistory().catch(() => {}), loadStats().catch(() => {})])
}

function showLogin() {
  state.me = null
  state.session = null
  clearAutoAdvance()
  byId('app').hidden = true
  byId('login').hidden = false
}

/**
 * ログインと新規登録の切替。
 *
 * **招待コードと表示名はログイン側に置かない。** モックは 1 枚に 3 項目を並べているが、
 * `POST /v1/auth/login` はメールとパスワードしか受け取らない（`loginRequestSchema`）。
 * 送られない項目を出すと「入れたのに効かない欄」になる。招待コードが要るのは登録時だけ。
 */
function selectTab(which) {
  const isLogin = which === 'login'
  byId('tab-login').setAttribute('aria-selected', String(isLogin))
  byId('tab-signup').setAttribute('aria-selected', String(!isLogin))
  byId('form-login').hidden = !isLogin
  byId('form-signup').hidden = isLogin
  byId('login-title').textContent = isLogin ? 'アカウントにログイン' : 'アカウントを作成'
  byId('login-note').textContent = isLogin
    ? 'トレーニングセッションを開始するには資格情報を入力してください'
    : '招待コードをお持ちの方が登録できます'
  clearError()
}

function valuesOf(form) {
  const result = {}
  for (const [key, value] of new FormData(form).entries()) result[key] = String(value)
  return result
}

// ═══ 起動と配線 ════════════════════════════════════════════════════════════

/**
 * @param {HTMLElement} node
 * @param {readonly string[]} values
 */
function fillSelect(node, values) {
  for (const value of ['', ...values]) {
    const option = /** @type {HTMLOptionElement} */ (
      el('option', undefined, value === '' ? '指定しない' : value)
    )
    option.value = value
    node.appendChild(option)
  }
}

function onSubmit(id, handler) {
  byId(id).addEventListener('submit', (event) => {
    event.preventDefault()
    const button = /** @type {HTMLButtonElement|null} */ (
      byId(id).querySelector('button[type="submit"]')
    )
    withBusy(button, () => handler(byId(id)))
  })
}

fillSelect(byId('select-language'), LANGUAGES)
fillSelect(byId('select-framework'), FRAMEWORKS)
maskPreview.setupMaskPreview()

byId('tab-login').addEventListener('click', () => selectTab('login'))
byId('tab-signup').addEventListener('click', () => selectTab('signup'))

onSubmit('form-login', async (form) => {
  const { data } = await api('POST', '/v1/auth/login', valuesOf(form))
  form.reset()
  await afterLogin(data.me)
})

onSubmit('form-signup', async (form) => {
  const { data } = await api('POST', '/v1/auth/signup', valuesOf(form))
  form.reset()
  await afterLogin(data.me)
})

byId('form-compose').addEventListener('submit', (event) => {
  event.preventDefault()
  const send = /** @type {HTMLButtonElement} */ (byId('btn-send'))
  withThinking(send, state.composerMode === 'compose' ? startSession : declareConclusion)
})

const composerInput = byId('composer-input')
composerInput.addEventListener('input', () => {
  state.lastTypedAt = Date.now()
  updateComposer()
})
// Enter で送信、Shift+Enter で改行。エラーログを貼る場面が多いので改行を優先しない
composerInput.addEventListener('keydown', (event) => {
  const ev = /** @type {KeyboardEvent} */ (event)
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault()
    byId('form-compose').dispatchEvent(new Event('submit', { cancelable: true }))
  }
})

for (const item of document.querySelectorAll('.nav__item[data-view]')) {
  item.addEventListener('click', () => {
    const view = item.getAttribute('data-view')
    selectView(view)
    if (view === 'dashboard') loadStats().catch(() => {})
    if (view === 'history') loadHistory().catch(() => {})
  })
}

byId('nav-chat').addEventListener('click', () => {
  if (!state.session) {
    newSession()
    return
  }
  // 進行中のセッションを黙って捨てない。中断すると Gate A の評価は戻らない
  if (state.session.status === 'active') {
    const ok = window.confirm('進行中のセッションがあります。新しく始めますか？')
    if (!ok) return
  }
  newSession()
})

byId('btn-reload-history').addEventListener('click', () => loadHistory().catch(showError))

byId('btn-logout').addEventListener('click', async () => {
  try {
    await api('POST', '/v1/auth/logout')
  } catch {
    // ログアウトは失敗しても画面は戻す
  }
  showLogin()
  selectTab('login')
})

async function loadHealth() {
  const chip = byId('health-chip')
  try {
    const { data } = await api('GET', '/v1/health')
    // MOCK モードであることを画面に明示する（ADR-014）
    byId('mock-badge').hidden = data.mockMode !== true
    chip.textContent = `AI: オンライン（${data.version} / ${String(data.commit).slice(0, 7)}）`
    if (data.configOk === false) {
      chip.textContent = 'AI: 設定不足'
      chip.className = 'chip chip--bad'
      showError(
        new ApiError(500, {
          error: {
            code: 'CONFIG_INCOMPLETE',
            message: `サーバの環境変数が ${data.configMissing} 件不足しています`,
            detail: null,
          },
        }),
      )
    }
  } catch {
    chip.textContent = 'AI: 接続できません'
    chip.className = 'chip chip--bad'
  }
}

async function boot() {
  selectTab('login')
  try {
    const { data } = await api('GET', '/v1/me')
    await afterLogin(data.me)
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'UNAUTHENTICATED') showError(err)
    showLogin()
  }
  loadHealth()
}

boot()
