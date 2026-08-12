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
import { byId, clear, el } from './dom.js'
import { renderHistory, renderStats } from './dashboard.js'
import { renderErrorLog, summarize } from './error-log.js'
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
  /** COMPOSER のキー。compose / waiting / observing / declare / locked */
  composerMode: 'compose',
  /** エラー送信からセッション作成までの間、入力を保持する（PR #33 の文脈追加） */
  pending: null,
  /** 「原因が分かった」の深掘り促しを出したか。トグル往復で繰り返さない */
  declarePromptShown: false,
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

/**
 * 入力欄の状態（PR #33 の画面設計）。
 *
 * セッション中の入力欄は**既定で閉じる。** 自由入力の置き場所は原因宣言だけで、
 * それは「原因が分かった」を押すという**宣言の意思表示**から始まる。
 * 常に開いていると、Gate B の設問への回答をここに書く人が必ず出る
 * （回答は選択肢を押すもので、入力欄はどこにも繋がっていない）。
 */
const COMPOSER = {
  compose: {
    placeholder: 'デバッグ対象のコード、エラーログ、または仮説を入力してください…',
    hint: 'エラーの本文を貼り付けてください。送信前にマスキングの結果を表示します。',
    active: true,
  },
  /** エラー送信後、文脈の追加を選んでいる間。まだセッションは無い */
  waiting: { placeholder: '', hint: '', active: false },
  /** セッション中の既定。宣言の意思表示があるまで閉じる */
  observing: {
    placeholder: '「原因が分かった」を押すと、ここに原因を書けます',
    hint: '',
    active: false,
  },
  /** 「原因が分かった」を押した後 */
  declare: {
    placeholder: '原因が分かったら、自分の言葉で書いてください…',
    /**
     * **「設問には戻しません」とは書かない。** Q-15 は「戻さない」ことが要件で、
     * 「戻さないと宣言する」ことではない。戻される可能性があったこと自体が
     * 利用者にとっては初耳で、書いた瞬間に不安を作る側に回る。
     */
    hint: 'どの時点で・何が・なぜ起きたか、が分かる形だと判定しやすいです。',
    active: true,
  },
  locked: { placeholder: 'このセッションは完了しています', hint: '', active: false },
}

function setComposerMode(mode) {
  state.composerMode = mode
  const input = /** @type {HTMLTextAreaElement} */ (byId('composer-input'))
  input.placeholder = COMPOSER[mode].placeholder
  input.disabled = !COMPOSER[mode].active
  input.value = ''
  byId('composer-hint').textContent = COMPOSER[mode].hint
  const send = /** @type {HTMLButtonElement} */ (byId('btn-send'))
  send.disabled = !COMPOSER[mode].active
  // 言語・FW はセッションの属性なので、エラー投稿のときだけ出す
  byId('form-compose').querySelectorAll('.select').forEach((n) => {
    /** @type {HTMLElement} */ (n).hidden = mode !== 'compose'
  })
  maskPreview.reset()
  updateComposer()
  renderGateActions()
}

function updateComposer() {
  const input = /** @type {HTMLTextAreaElement} */ (byId('composer-input'))
  byId('composer-count').textContent = String(input.value.length)
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 190)}px`
  // 送信前マスキングプレビュー（security.md §3 A）。**貼り付けた瞬間に出す**
  maskPreview.render(input.value)
}

// ═══ 貼ったエラーの固定表示 ════════════════════════════════════════════════

/**
 * **スクロールで消えないところに置く。**
 * この画面は「エラーを正確に読めるか」を測っている（evaluation-model.md の観察軸）。
 * 先輩役が「スタックトレースをもう一度読み返してください」と言う場面があり、
 * そのときに対象が画面外にあると成立しない。
 *
 * 既定は 3 行ぶんだけ見せる。**畳んでも隠さない**のは、
 * 完全に隠すと常時表示にした意味（対象を見ながら考える）が無くなるため。
 */
function showErrorLog(text) {
  const panel = byId('errorlog')
  renderErrorLog(byId('errorlog-body'), text)
  byId('errorlog-summary').textContent = summarize(text)
  panel.dataset['open'] = 'false'
  byId('errorlog-toggle').setAttribute('aria-expanded', 'false')
  byId('errorlog-toggle').querySelector('.errorlog__action').textContent = '全文'
  panel.hidden = false
}

function hideErrorLog() {
  byId('errorlog').hidden = true
  clear(byId('errorlog-body'))
}

function toggleErrorLog() {
  const panel = byId('errorlog')
  const open = panel.dataset['open'] !== 'true'
  panel.dataset['open'] = String(open)
  byId('errorlog-toggle').setAttribute('aria-expanded', String(open))
  byId('errorlog-toggle').querySelector('.errorlog__action').textContent = open
    ? '折りたたむ'
    : '全文'
}

// ═══ セッション状態 ════════════════════════════════════════════════════════

function applySession(data) {
  if (data.session) state.session = data.session
  if (data.actions) state.actions = data.actions
  scheduleAutoAdvance()
  renderGateActions()
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
 * 進行の操作（入力欄の上に固定 / PR #33 の画面設計）。
 *
 * **どれを押せるかはサーバの `actions` に従う。** クライアントに条件式を置くと、
 * ゲート遷移規則が 2 箇所に分かれて必ずずれる（socratic-engine.md §7）。
 * スレッド内に置いていた頃は、会話が進むたびに古いボタンが残り続けた。
 * 固定の 1 か所を毎回作り直す形なら、その問題自体が消える。
 */
function renderGateActions() {
  const bar = byId('gate-actions')
  const active = state.session?.status === 'active'
  const a = active ? (state.actions ?? NO_ACTIONS) : NO_ACTIONS
  const declaring = state.composerMode === 'declare'

  // セッションが無い間（文脈の追加を選んでいる間も）はバーごと出さない
  bar.hidden = !active
  if (!active) return

  const show = (id, on) => {
    /** @type {HTMLButtonElement} */ (byId(id)).hidden = !on
  }
  const enable = (id, on) => {
    /** @type {HTMLButtonElement} */ (byId(id)).disabled = !on
  }

  show('btn-hint', a.canRequestHint)
  show('btn-advance', a.canAdvanceToQuestions)
  show('btn-reveal', a.canReveal)
  show('btn-declare', a.canDeclareConclusion)

  // 宣言モード中は他の操作を止める（PR #33: もう一度押すと元に戻る）
  enable('btn-hint', !declaring)
  enable('btn-advance', !declaring)
  enable('btn-reveal', !declaring)
  byId('btn-declare').setAttribute('aria-pressed', String(declaring))

  /**
   * Gate B で解説がまだ読めないとき、**どうすれば読めるようになるか**を出す。
   *
   * Gate B → C の条件（FR-07）に利用者の明示要求は含まれておらず、
   * 条件を満たすまで進めないこと自体は要件どおりなので変えない。
   * 代わりに、黙って何も出さないのをやめる。何も出ないのは「詰まった」に見える。
   * **Gate A では出さない**（Gate A から Gate C へは意図的に繋いでいない）。
   * 文面はサーバの GATE_NOT_UNLOCKED と揃える。
   */
  const note = byId('gate-note')
  const showNote = state.session?.gate === 'B' && !a.canReveal
  note.hidden = !showNote
  note.textContent = showNote
    ? '設問を進めるか、少し時間が経つと解説を読めるようになります。'
    : ''
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

/**
 * エラー送信（PR #33: chat-screen-add-context）。**ここではまだセッションを作らない。**
 *
 * 送信後に「確認するコード情報や状況を追加しますか？」を挟む。
 * コード断片・直前にした変更は `POST /v1/sessions` の `codeSnippet` /
 * `recentChange` で、**セッション作成後に渡す口が無い。**
 * したがって、この選択が終わるまで作成を遅らせる。
 * この時点で離脱した場合は何も作られていない（レート制限の枠も使わない）。
 */
function submitError() {
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
  state.pending = values

  /**
   * スレッドには**先頭行だけ**を出す。全文は上の固定パネルに常時出ているので、
   * ここで同じものを繰り返すと、最初のヒントが画面外に押し出される。
   */
  const lines = errorText.split(/\r\n?|\n/).filter((l) => l.trim() !== '')
  thread.user({
    who: state.me?.displayName ?? 'あなた',
    text: 'このエラーで詰まっています。',
    code: lines[0] ?? errorText,
    note: `全文（${summarize(errorText)}）は上の「貼ったエラー」に出ています。`,
  })
  showErrorLog(errorText)
  setComposerMode('waiting')
  askContext()
}

/**
 * 「追加しますか？」の確認（PR #33: chat-screen-add-context）。
 * 配色はモックのまま: 追加する = 紫の塗り / しない = 白の枠。
 *
 * セッション作成に失敗したときも、ここを呼び直せば選択からやり直せる
 * （選択肢のボタンは次のメッセージが積まれた時点で無効化されるため）。
 */
function askContext() {
  thread.bot({
    lead: '調査します。確認するコード情報や状況を追加しますか？',
    nodes: [
      thread.actionBar([
        { label: '追加する', kind: 'brand', onClick: openContextDialog },
        { label: 'しない', kind: 'ghost', onClick: () => createSessionOrRetry({}) },
      ]),
    ],
  })
}

/**
 * セッション作成。失敗（レート制限など）で選択肢ごと死なないよう、
 * エラー表示のあとに確認を積み直す。
 */
function createSessionOrRetry(extra) {
  withThinking(null, async () => {
    try {
      await createSessionNow(extra)
    } catch (err) {
      askContext()
      throw err
    }
  })
}

/** 文脈の追加ダイアログ。言語 / FW は入力欄の選択を初期値にする（PR #33） */
function openContextDialog() {
  const language = /** @type {HTMLSelectElement} */ (byId('context-language'))
  const framework = /** @type {HTMLSelectElement} */ (byId('context-framework'))
  language.value = state.pending?.language ?? ''
  framework.value = state.pending?.framework ?? ''
  byId('context-dialog').hidden = false
  const code = /** @type {HTMLTextAreaElement|null} */ (
    byId('form-context').querySelector('textarea')
  )
  code?.focus()
}

/**
 * セッション作成（PR #33 のフェーズ 2）。「しない」またはダイアログの
 * 「エラーを見てもらう」から呼ばれる。
 */
async function createSessionNow(extra) {
  const values = { ...state.pending, ...extra }
  const { data } = await api('POST', '/v1/sessions', { mode: 'live', ...values })
  // 失敗時は pending を保持したまま例外で抜ける。「しない」を押し直せば再試行できる
  state.pending = null
  state.hints = [data.hint]
  state.question = null
  state.declarePromptShown = false
  applySession(data)
  renderTopbar()
  setComposerMode('observing')

  thread.bot({
    lead: 'エラーを直視し、学びを得る準備ができましたね。',
    texts: ['まず、着眼点だけをお渡しします。答えは言いません。'],
    nodes: [thread.hintList(state.hints)],
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
    nodes: [thread.hintList([data.hint])],
  })
}

/**
 * 「原因が分かった」（PR #33: chat-screen-answer-active）。
 * 押すと入力欄が開き、他の操作が止まる。**もう一度押すと元に戻る。**
 */
function toggleDeclare() {
  if (state.composerMode === 'declare') {
    setComposerMode('observing')
    return
  }
  setComposerMode('declare')
  /**
   * SOCRA_BOT が原因の深掘りを促す（PR #33 の仕様）。
   * トグルを往復するたびに同じ文を積まないよう、セッションにつき 1 回にする。
   */
  if (!state.declarePromptShown) {
    state.declarePromptShown = true
    thread.bot({
      texts: ['では、原因を自分の言葉で聞かせてください。安易な答え合わせはしません。'],
    })
  }
  byId('composer-input').focus()
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
    texts: ['設問はここまでです。原因が分かったなら、下の「原因が分かった」から宣言してください。'],
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
    /**
     * レポートは**ボタンで開く**（PR #33: gate-a-pass）。
     * 続けて積むと、到達のフィードバックが結果カードに流されて読めない。
     * Gate C の解説と同じ理由で、読み終えるのは利用者が決める。
     */
    setComposerMode('locked')
    thread.bot({
      lead: '見事です。正確に本質を捉えています。',
      texts: [data.conclusion.feedback],
      nodes: [
        thread.actionBar([
          { label: 'レポートを表示', primary: true, onClick: () => withThinking(null, loadReport) },
        ]),
      ],
    })
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
  thread.bot({ texts: [data.conclusion.feedback] })
  // 書き直せるようにする。入力欄は宣言モードのまま空いている
  byId('composer-input').focus()
}

async function reveal() {
  const { data } = await api('POST', `/v1/sessions/${state.session.id}/reveal`)
  applySession(data)
  renderTopbar()

  /**
   * **振り返りを同時に出さない。**
   *
   * 続けて積むと、その分だけスレッドが流れて解説が画面外に出る。
   * Gate C は「答えが得られない状態を作らない」ために存在するゲートなので
   * （socratic-engine.md の P2 / FR-08）、**その解説を読み飛ばさせたら本末転倒**になる。
   * 読み終えたことを利用者に宣言させてから次へ進む。
   */
  thread.bot({
    lead: 'ここまでの経過をふまえて、原因をお伝えします。',
    nodes: [
      ...revealNodes(data.reveal),
      thread.actionBar([
        {
          label: '読み終えました。振り返りに進む',
          primary: true,
          onClick: () => showRetrospection(data.retrospection),
        },
      ]),
    ],
  })
}

function showRetrospection(retrospection) {
  thread.bot({
    texts: ['最後に 1 問だけ。今回の経験を次に活かすための確認です。'],
    callout: { label: '振り返り', body: retrospection.question, calm: true },
    nodes: [
      thread.optionList(retrospection.options, (id) => {
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

  /**
   * **結果は 1 通にまとめる。** 解説と同じ理由で、続けて積むとその分だけ
   * スレッドが流れ、いちばん長い結果カード（レーダー・内訳・算出根拠）が
   * 画面外に出る。次のセッションへの導線もこの中に入れる。
   */
  const bubble = thread.bot({
    lead: 'セッションの結果です。',
    nodes: [
      ...reportCard(data),
      thread.actionBar([
        { label: '新しいセッションを始める', primary: true, onClick: newSession },
      ]),
    ],
  })
  renderTopbar()

  // コストと集計は本体ではないので、失敗してもレポートの表示を止めない。
  // **後から届くので、行動ボタンより前に差し込む**（末尾に足すと導線が下にずれる）
  api('GET', `/v1/sessions/${state.session.id}/cost`)
    .then((res) => {
      const box = el('details', 'card')
      box.appendChild(el('summary', 'card__title', 'この 1 セッションの実測コスト'))
      for (const node of costNodes(res.data)) box.appendChild(node)
      bubble.insertBefore(box, bubble.querySelector('.actions'))
    })
    .catch(() => {})

  loadStats().catch(() => {})
  loadHistory().catch(() => {})
}

async function loadHistory() {
  const { data } = await api('GET', '/v1/me/sessions')
  renderHistory(data.sessions, {
    onOpen: (id) => withBusy(null, () => openSession(id)),
    onDelete: (session) => withBusy(null, () => deleteSession(session)),
  })
}

/**
 * セッションの削除（NFR-S7）。
 *
 * **確認する。** 取り消せないうえ、レポートと内部診断まで一緒に消える
 * （data-model.md §7 の CASCADE 相当）。
 */
async function deleteSession(session) {
  const ok = window.confirm(
    `このセッションを削除しますか？\n\n${session.summary}\n\n` +
      '結果とスコアも一緒に消えます。取り消せません。',
  )
  if (!ok) return

  await api('DELETE', `/v1/sessions/${session.id}`)
  // 開いているセッションを消したなら、画面も新規に戻す
  if (state.session?.id === session.id) newSession()
  await Promise.all([loadHistory(), loadStats().catch(() => {})])
}

async function loadStats() {
  const { data } = await api('GET', '/v1/me/stats')
  renderStats(data)
}

// ═══ 中断したセッションの復旧 ══════════════════════════════════════════════

/**
 * 記録を順に流してスレッドを組み直す（#27）。
 *
 * **描画は新規のときと同じ関数を使う。** 復旧用に別の見た目を作ると、
 * 「復旧したら少し違う画面になる」という形でずれが育つ。
 */
async function openSession(sessionId) {
  const { data } = await api('GET', `/v1/sessions/${sessionId}/transcript`)

  clearAutoAdvance()
  state.hints = []
  state.question = null
  thread.reset()
  hideErrorLog()
  selectView('chat')

  for (const entry of data.entries) replayEntry(entry)

  applySession(data)
  renderTopbar()

  const active = data.session.status === 'active'
  if (!active) {
    // 完了・中断したセッションは読むだけ。**続きを書ける見た目にしない**
    setComposerMode('locked')
    byId('composer-hint').textContent =
      data.session.status === 'abandoned'
        ? 'このセッションは長時間の中断により終了しています。'
        : 'このセッションは完了しています。'
    return
  }

  state.declarePromptShown = false
  setComposerMode('observing')
  // 未回答の設問が残っていれば、そこから続ける
  if (data.question) showQuestion(data.question)
  else thread.bot({ texts: ['ここから続けられます。'] })
}

/** @param {import('@socrametry/shared').TranscriptEntryPublic} entry */
function replayEntry(entry) {
  if (entry.kind === 'error') {
    const lines = entry.body.split(/\r\n?|\n/).filter((l) => l.trim() !== '')
    thread.user({
      who: state.me?.displayName ?? 'あなた',
      text: 'このエラーで詰まっています。',
      code: lines[0] ?? entry.body,
      note: `全文（${summarize(entry.body)}）は上の「貼ったエラー」に出ています。`,
    })
    showErrorLog(entry.body)
    return
  }

  if (entry.kind === 'hint') {
    state.hints.push({ level: entry.level, body: entry.body })
    thread.bot({
      texts: [entry.auto ? '（同じ段階で詰まったため、ヒントを 1 段開けました）' : ''].filter(Boolean),
      nodes: [thread.hintList([entry])],
    })
    return
  }

  if (entry.kind === 'question') {
    thread.bot({
      texts: [`${stageName(entry.stage)} — ${entry.seqInStage} 問目`],
      callout: { label: '選択問題（Gate B）', body: entry.body },
      // **回答済みの設問は押せない形で出す。** 押せると「やり直せる」と読める
      nodes: [answeredOptions(entry.options, entry.answer)],
    })
    if (entry.answer) {
      thread.bot({
        lead: entry.answer.isCorrect ? '正解です。' : '惜しい。しかし、推測で片づけてはいけません。',
        texts: [entry.answer.feedback],
      })
    }
    return
  }

  if (entry.kind === 'conclusion') {
    if (entry.body) thread.user({ who: state.me?.displayName ?? 'あなた', text: entry.body })
    thread.bot({ texts: [entry.feedback] })
    return
  }

  if (entry.kind === 'reveal') {
    thread.bot({ lead: 'ここまでの経過をふまえて、原因をお伝えします。', nodes: revealNodes(entry.reveal) })
    return
  }

  if (entry.kind === 'retrospection') {
    thread.bot({ texts: ['振り返りに回答済みです。'] })
  }
}

/** 回答済みの選択肢。選んだものが分かる形で、押せなくする */
function answeredOptions(options, answer) {
  const list = el('div', 'options')
  for (const option of options) {
    const picked = answer?.selectedOptionId === option.id
    const node = el(
      'div',
      `option option--done${picked ? ' option--picked' : ''}`,
      `${option.id.toUpperCase()}. ${option.label}${picked ? '（選択）' : ''}`,
    )
    list.appendChild(node)
  }
  return list
}

function newSession() {
  clearAutoAdvance()
  state.session = null
  state.actions = null
  state.question = null
  state.hints = []
  state.pending = null
  state.declarePromptShown = false
  byId('context-dialog').hidden = true
  thread.reset()
  hideErrorLog()
  renderTopbar()
  // 言語 / FW の選択は**リセットしない**。前回のセッションを引き継ぐ（PR #33）
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
fillSelect(byId('context-language'), LANGUAGES)
fillSelect(byId('context-framework'), FRAMEWORKS)
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

/**
 * 送信ボタンの活性は setComposerMode が一元管理する。
 * withThinking にボタンを渡すと finally の再活性化がモードの無効化を
 * 打ち消してしまう（waiting に入った直後に送信が押せる見た目に戻る）。
 * 二重送信の防御はサーバの冪等性（api-spec.md §4）。
 */
byId('form-compose').addEventListener('submit', (event) => {
  event.preventDefault()
  if (state.composerMode === 'compose') withThinking(null, async () => submitError())
  else if (state.composerMode === 'declare') withThinking(null, declareConclusion)
  // waiting / observing / locked では送信自体が無効
})

// ── 進行の操作（入力欄の上の固定バー / PR #33）──────────────────────────
byId('btn-hint').addEventListener('click', () => withThinking(byId('btn-hint'), requestHint))
byId('btn-advance').addEventListener('click', () =>
  withThinking(byId('btn-advance'), () => advance(true)),
)
byId('btn-reveal').addEventListener('click', () => withThinking(byId('btn-reveal'), reveal))
byId('btn-declare').addEventListener('click', toggleDeclare)

// ── 文脈の追加ダイアログ（PR #33）────────────────────────────────────────
byId('form-context').addEventListener('submit', (event) => {
  event.preventDefault()
  const form = /** @type {HTMLFormElement} */ (byId('form-context'))
  const extra = {}
  const code = /** @type {HTMLTextAreaElement} */ (
    form.querySelector('[name="codeSnippet"]')
  ).value.trim()
  const change = /** @type {HTMLInputElement} */ (
    form.querySelector('[name="recentChange"]')
  ).value.trim()
  // これらも LLM に届く。エラー本文と同じくマスクしてから送る（security.md §3）
  if (code !== '') extra.codeSnippet = maskPreview.mask(code).text
  if (change !== '') extra.recentChange = maskPreview.mask(change).text
  for (const key of ['language', 'framework']) {
    const value = /** @type {HTMLSelectElement} */ (byId(`context-${key}`)).value
    if (value !== '') extra[key] = value
  }
  byId('context-dialog').hidden = true
  form.reset()
  createSessionOrRetry(extra)
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

byId('errorlog-toggle').addEventListener('click', toggleErrorLog)
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
