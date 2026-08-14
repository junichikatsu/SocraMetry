// @ts-check
/**
 * 新規セッション開始の流れ（PR #33: chat-screen-add-context / -dialog）。
 *
 * **本物の main.js を jsdom 上で起動し、モックの画面遷移どおりに歩く。**
 * fetch だけを差し替え、DOM 操作・状態遷移・API の呼び順は実物を使う。
 * ここで守るのは PR #33 が決めた順序そのもの:
 *
 *   エラー送信 → 「調査します。確認するコード情報や状況を追加しますか？」
 *     ├─ しない   → POST /v1/sessions → Gate A
 *     └─ 追加する → ダイアログ → 「エラーを見てもらう」→ POST /v1/sessions → Gate A
 *
 * 特に**「エラー送信の時点ではまだセッションを作らない」**を固定する。
 * ここが崩れると、コード断片・直前にした変更（codeSnippet / recentChange）を
 * 渡す口が消える（POST /v1/sessions にしか無いため）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'

const html = readFileSync(
  fileURLToPath(new URL('../public/index.html', import.meta.url)),
  'utf8',
)

const ME = { userId: 'u1', email: 'w@example.com', displayName: 'Watanabe' }
const SESSION = {
  id: 'S1',
  mode: 'live',
  status: 'active',
  gate: 'A',
  hintLevel: 1,
  currentStage: null,
  stageIndex: null,
  totalStages: 5,
  diagnosisStatus: 'pending',
  reachedGate: null,
  startedAt: 1,
  autoAdvanceInMs: null,
}
const ACTIONS = {
  canRequestHint: true,
  canAdvanceToQuestions: true,
  canDeclareConclusion: true,
  canReveal: false,
}
const QUESTION = {
  id: 'S1#1',
  stage: 'observe',
  seqInStage: 1,
  body: 'このエラーメッセージは、何が undefined だったと言っていますか？',
  options: [
    { id: 'a', label: 'map という名前の変数' },
    { id: 'b', label: '呼び出し対象のオブジェクト' },
  ],
}

const STATS = {
  sessionCount: 0,
  totalElapsedMs: 0,
  gateDistribution: { A: 0, B: 0, C: 0, unresolved: 0 },
  selfReachRate: 0,
  recentAxes: null,
  correctRate: null,
  weakestAxis: null,
  trend: [],
}

const json = (body, status = 200) => ({
  ok: status < 400,
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await tick()
}

/**
 * main.js を新しい DOM で起動する。main.js はモジュール状態（state）を持つので、
 * テストごとに resetModules で読み直す。
 */
async function bootApp() {
  /**
   * jsdom はイベントハンドラ内の例外を握りつぶす（jsdomError に流すだけ）。
   * ここで拾って**テストを落とす**。握りつぶされたままだと、ボタンを押しても
   * 何も起きない画面が「テストは通る」ことになってしまう。
   */
  /** @type {Error[]} */
  const uncaught = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (e) => {
    uncaught.push(/** @type {any} */ (e).detail ?? e)
  })

  const dom = new JSDOM(html, { url: 'http://localhost/', virtualConsole })
  /** @type {{method: string, path: string, body: any}[]} */
  const calls = []

  const fetchMock = async (url, opts = {}) => {
    const method = opts.method ?? 'GET'
    const path = String(url)
    calls.push({ method, path, body: opts.body ? JSON.parse(opts.body) : undefined })

    const key = `${method} ${path}`
    if (key === 'POST /v1/sessions/S1/advance')
      return json({ session: { ...SESSION, gate: 'B', currentStage: 'observe', stageIndex: 1 }, question: QUESTION, actions: { ...ACTIONS, canAdvanceToQuestions: false } })
    if (key === 'POST /v1/sessions/S1/hints')
      return json({ session: { ...SESSION, gate: 'B', hintLevel: 2 }, hint: { level: 2, body: 'ヒント2です' }, actions: { ...ACTIONS, canAdvanceToQuestions: false } })
    if (key === 'POST /v1/sessions/S1/answers')
      return json({ session: { ...SESSION, gate: 'B' }, result: { isCorrect: true, feedback: 'その通りです' }, nextQuestion: null, actions: { ...ACTIONS, canAdvanceToQuestions: false } })
    if (key === 'GET /v1/me') return json({ me: ME })
    if (key === 'GET /v1/health')
      return json({ status: 'ok', version: '0', commit: 'c0ffee0', mockMode: true, configOk: true })
    if (key === 'GET /v1/me/sessions') return json({ sessions: [] })
    if (key === 'GET /v1/me/stats') return json(STATS)
    if (key === 'POST /v1/sessions')
      return json({ session: SESSION, hint: { level: 1, body: '着眼点です' }, actions: ACTIONS }, 201)
    if (key === 'POST /v1/sessions/S1/diagnose') return json({ diagnosisStatus: 'ready' })
    throw new Error(`想定外の呼び出し: ${key}`)
  }

  // main.js は import 時に location / document を参照するので、先に差し込む
  globalThis.window = /** @type {any} */ (dom.window)
  globalThis.document = /** @type {any} */ (dom.window.document)
  globalThis.location = /** @type {any} */ (dom.window.location)
  globalThis.FormData = /** @type {any} */ (dom.window.FormData)
  globalThis.fetch = /** @type {any} */ (fetchMock)
  // 言語 / FW の記憶に使う。JSDOM ごとに独立するのでテスト間で漏れない
  globalThis.localStorage = /** @type {any} */ (dom.window.localStorage)
  // 「設問に進む」「進行中の破棄」の確認。テストでは常に進む
  dom.window.confirm = () => true

  vi.resetModules()
  await import('./main.js')
  await flush()

  const d = dom.window.document
  return {
    dom,
    calls,
    d,
    /** ハンドラ内で握りつぶされた例外。空であることをテストが確認する */
    uncaught,
    threadText: () => d.getElementById('thread')?.textContent ?? '',
    clickButton(label) {
      const target = [...d.querySelectorAll('button')].find(
        (b) => b.textContent === label && !(/** @type {HTMLButtonElement} */ (b).disabled),
      )
      if (!target) throw new Error(`押せるボタンがありません: ${label}`)
      /*
        `element.click()` を使わない。この構成（グローバル差し込み + jsdom）では
        click() が**何も起こさず黙って戻る**ことがあり、切り分けで
        「ハンドラが繋がっていない」と誤読させた。dispatchEvent なら
        リスナーの配線そのものを検証できる（実ブラウザの click はその上に乗るだけ）。
      */
      target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    },
    async sendError(text) {
      const input = /** @type {HTMLTextAreaElement} */ (d.getElementById('composer-input'))
      input.value = text
      d.getElementById('form-compose')?.dispatchEvent(
        new dom.window.Event('submit', { cancelable: true }),
      )
      await flush()
    },
    sessionPosts: () => calls.filter((c) => c.method === 'POST' && c.path === '/v1/sessions'),
  }
}

afterEach(() => {
  // 次のテストの JSDOM に置き換わるまで、前の DOM を参照させない
  vi.resetModules()
})

describe('新規セッション開始の流れ（PR #33）', () => {
  it('エラー送信の時点ではセッションを作らず、文脈の追加を確認する', async () => {
    const app = await bootApp()

    // 挨拶が出ている（chat-screen-start）
    expect(app.threadText()).toContain('ようこそ')

    await app.sendError('TypeError: boom\n  at f (a.ts:1:1)')

    // ★ SOCRA_BOT が確認を出し、まだ POST /v1/sessions は飛んでいない
    expect(app.threadText()).toContain('調査します。確認するコード情報や状況を追加しますか？')
    expect(app.sessionPosts()).toHaveLength(0)

    // 選択肢の 2 つが押せる形で出ている
    const labels = [...app.d.querySelectorAll('#thread button')].map((b) => b.textContent)
    expect(labels).toContain('追加する')
    expect(labels).toContain('しない')

    // 入力欄は無効・進行の操作バーは出ていない（仕様: このタイミングでは非表示）
    expect(/** @type {HTMLTextAreaElement} */ (app.d.getElementById('composer-input')).disabled).toBe(true)
    expect(app.d.getElementById('gate-actions')?.hidden).toBe(true)
  })

  it('「しない」で文脈なしのままセッションが作られ、Gate A に入る', async () => {
    const app = await bootApp()
    await app.sendError('TypeError: boom')

    app.clickButton('しない')
    await flush()

    const posts = app.sessionPosts()
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toMatchObject({ mode: 'live', errorText: 'TypeError: boom' })
    expect(posts[0].body.codeSnippet).toBeUndefined()
    expect(posts[0].body.recentChange).toBeUndefined()

    // Gate A: ヒントが出て、進行の操作バーが現れる
    expect(app.threadText()).toContain('着眼点です')
    expect(app.d.getElementById('gate-actions')?.hidden).toBe(false)
    expect(app.d.getElementById('btn-declare')?.hidden).toBe(false)
    // 入力欄は既定で閉じている（宣言の意思表示までは開かない）
    expect(/** @type {HTMLTextAreaElement} */ (app.d.getElementById('composer-input')).disabled).toBe(true)
  })

  it('「追加する」→ダイアログ→「エラーを見てもらう」で文脈つきのセッションが作られる', async () => {
    const app = await bootApp()

    await app.sendError('TypeError: boom')
    app.clickButton('追加する')

    const dialog = app.d.getElementById('context-dialog')
    expect(dialog?.hidden).toBe(false)
    expect(app.sessionPosts()).toHaveLength(0) // まだ作らない

    const form = /** @type {HTMLFormElement} */ (app.d.getElementById('form-context'))
    const code = /** @type {HTMLTextAreaElement} */ (form.querySelector('[name="codeSnippet"]'))
    const change = /** @type {HTMLInputElement} */ (form.querySelector('[name="recentChange"]'))
    const language = /** @type {HTMLSelectElement} */ (app.d.getElementById('context-language'))
    code.value = 'const items = props.items.map(f)'
    change.value = 'API のレスポンス形式を変えた'
    language.value = 'typescript'
    form.dispatchEvent(new app.dom.window.Event('submit', { cancelable: true }))
    await flush()

    expect(dialog?.hidden).toBe(true)
    const posts = app.sessionPosts()
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toMatchObject({
      errorText: 'TypeError: boom',
      codeSnippet: 'const items = props.items.map(f)',
      recentChange: 'API のレスポンス形式を変えた',
      language: 'typescript',
    })
    expect(app.threadText()).toContain('着眼点です')
  })

  it('ダイアログで選んだ言語 / FW を記憶し、次回は選択された状態で開く', async () => {
    const app = await bootApp()

    // 1 回目: typescript / react を選んで送る
    await app.sendError('TypeError: boom')
    app.clickButton('追加する')
    const language = /** @type {HTMLSelectElement} */ (app.d.getElementById('context-language'))
    const framework = /** @type {HTMLSelectElement} */ (app.d.getElementById('context-framework'))
    language.value = 'typescript'
    framework.value = 'react'
    const form = /** @type {HTMLFormElement} */ (app.d.getElementById('form-context'))
    form.dispatchEvent(new app.dom.window.Event('submit', { cancelable: true }))
    await flush()

    // 新規セッションへ（進行中の確認は confirm=true で通す）
    app.d.getElementById('nav-chat')?.dispatchEvent(
      new app.dom.window.MouseEvent('click', { bubbles: true }),
    )
    await flush()
    expect(app.threadText()).toContain('ようこそ') // 新しいスレッドに戻った

    // 2 回目: ダイアログを開くと前回の選択が入っている
    await app.sendError('ReferenceError: x is not defined')
    app.clickButton('追加する')
    expect(language.value).toBe('typescript')
    expect(framework.value).toBe('react')

    // そのまま送れば前回の言語で作られる
    form.dispatchEvent(new app.dom.window.Event('submit', { cancelable: true }))
    await flush()
    const posts = app.sessionPosts()
    expect(posts).toHaveLength(2)
    expect(posts[1].body).toMatchObject({ language: 'typescript', framework: 'react' })
  })

  /**
   * Gate B でヒントを挟んでも、設問に答えられる（報告のあった不具合の再発防止）。
   *
   * スレッドは新しいメッセージを積むとき古い操作ボタンを無効化するが、
   * **未回答の設問はまだ答えられる現役の問い**であって、古くなったわけではない。
   * ヒントのメッセージが積まれた時点で選択肢が死ぬと、設問に戻る手段が無くなる。
   */
  it('Gate B: ヒントを表示したあとも設問に答えられる', async () => {
    const app = await bootApp()
    await app.sendError('TypeError: boom')
    app.clickButton('しない')
    await flush()

    // 設問へ進む（confirm はテストで常に true）
    app.clickButton('設問に進む')
    await flush()
    expect(app.threadText()).toContain('このエラーメッセージは、何が undefined だったと言っていますか？')

    // ヒントを開く
    app.clickButton('ヒントに進む')
    await flush()
    expect(app.threadText()).toContain('ヒント2です')

    // ★ 設問の選択肢がまだ押せて、回答が送れる
    app.clickButton('B. 呼び出し対象のオブジェクト')
    await flush()

    const answers = app.calls.filter((c) => c.method === 'POST' && c.path === '/v1/sessions/S1/answers')
    expect(answers).toHaveLength(1)
    expect(answers[0].body).toMatchObject({ questionId: 'S1#1', selectedOptionId: 'b' })
    expect(app.threadText()).toContain('その通りです')
  })

  /**
   * 宣言モード中、「原因が分かった」は**戻る導線**に変わる。
   * 表記がそのままだと、やめたい人がもう一度それを押すとは思えない
   * （押したら送信されそうに見える）。
   */
  it('Gate B: 「原因が分かった」を押すと「設問に戻る」に変わり、押すと設問へ戻れる', async () => {
    const app = await bootApp()
    await app.sendError('TypeError: boom')
    app.clickButton('しない')
    await flush()
    app.clickButton('設問に進む')
    await flush()

    const input = /** @type {HTMLTextAreaElement} */ (app.d.getElementById('composer-input'))
    const declare = /** @type {HTMLButtonElement} */ (app.d.getElementById('btn-declare'))

    // 宣言モードへ: 入力欄が開き、表記が変わる
    app.clickButton('原因が分かった')
    await flush()
    expect(input.disabled).toBe(false)
    expect(declare.textContent).toBe('設問に戻る')

    // 戻る: 入力欄が閉じ、表記が戻り、設問にはまだ答えられる
    app.clickButton('設問に戻る')
    await flush()
    expect(input.disabled).toBe(true)
    expect(declare.textContent).toBe('原因が分かった')
    app.clickButton('B. 呼び出し対象のオブジェクト')
    await flush()
    expect(
      app.calls.filter((c) => c.method === 'POST' && c.path === '/v1/sessions/S1/answers'),
    ).toHaveLength(1)
  })

  it('未入力のままでも「エラーを見てもらう」で進める（すべて任意）', async () => {
    const app = await bootApp()
    await app.sendError('TypeError: boom')
    app.clickButton('追加する')

    const form = /** @type {HTMLFormElement} */ (app.d.getElementById('form-context'))
    form.dispatchEvent(new app.dom.window.Event('submit', { cancelable: true }))
    await flush()

    const posts = app.sessionPosts()
    expect(posts).toHaveLength(1)
    expect(posts[0].body.codeSnippet).toBeUndefined()
    expect(posts[0].body.recentChange).toBeUndefined()
    expect(app.threadText()).toContain('着眼点です')
  })
})
