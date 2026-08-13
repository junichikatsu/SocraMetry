// @ts-check
/**
 * 対話スレッドの描画（MOCK/SocraMetry_MOC.html のチャット画面）。
 *
 * 3 ゲートを**1 本のスレッド**として見せる。ゲートごとに画面を切り替えると、
 * 「同じ先輩と話し続けている」という体験（socratic-engine.md §1）が切れる。
 * 進行はスレッドに積み上がり、前のやりとりはスクロールで残る。
 */
import { append, button, byId, clear, clockLabel, el } from './dom.js'

const BOT = 'SOCRA_BOT (AI INSTRUCTOR)'

/** ADR-007: ローディングを進捗バーではなく「先輩が考えている」表現にする */
const THINKING = [
  'ふむ…ログを見せてもらっています。',
  'なるほど。少し確認させてください。',
  'では、一つ聞かせてください。',
  'ちょっと待ってください、いま見ています。',
]

const thread = () => byId('thread')

export function reset() {
  clear(thread())
}

/**
 * 新しく積んだメッセージが**読み始められる位置**にくるようにする。
 *
 * 常に末尾へ飛ばしていたが、それだと画面より高いメッセージ（Gate C の解説など）は
 * **本文の途中から表示される。** 読み始めの位置を自分で探すことになり、
 * 上に何が書いてあったかも分からない。
 *
 * 収まる高さなら末尾へ寄せる方が自然なので、高さで振り分ける。
 *
 * @param {HTMLElement} root 積んだメッセージ
 */
function scrollToNew(root) {
  const node = thread()
  if (root.offsetHeight < node.clientHeight) {
    node.scrollTop = node.scrollHeight
    return
  }
  // 上端にぴったり付けず、少しだけ余白を残す
  node.scrollTop = Math.max(0, root.offsetTop - node.offsetTop - 12)
}

/**
 * @param {{ who: string, mine?: boolean, avatar?: string }} meta
 * @returns {{ root: HTMLElement, bubble: HTMLElement }}
 */
function shell(meta) {
  const root = el('div', meta.mine ? 'msg msg--user' : 'msg')

  /**
   * SOCRA_BOT のアイコンは画像（assets/robo.png）。
   * `?v=` はサーバが配信時に app.js の中でも置換する（static.ts）。
   * これが無いと、アイコンを差し替えても前段のキャッシュが 4 時間残る。
   */
  const avatar = el('div', meta.mine ? 'msg__avatar' : 'msg__avatar msg__avatar--bot')
  if (meta.mine) {
    avatar.textContent = meta.avatar ?? '🧑'
  } else {
    const icon = /** @type {HTMLImageElement} */ (el('img', 'msg__avatar-img'))
    icon.src = 'robo.png?v=__ASSET_VERSION__'
    icon.alt = ''
    avatar.appendChild(icon)
  }

  const bubble = el('div', 'msg__bubble')

  const who = el('div', 'msg__who')
  who.appendChild(el('span', undefined, meta.who))
  who.appendChild(el('span', 'msg__time', clockLabel(Date.now())))
  bubble.appendChild(who)

  append(root, avatar, bubble)
  return { root, bubble }
}

/**
 * スレッドに積む。
 *
 * **積む前に、それまでのメッセージの操作ボタンを無効化する。**
 * 一度きりの導線（追加する / しない、レポートを表示など）は、次のメッセージが
 * 積まれた時点で用済みになる。押せてしまうと 409 を返させるだけで、
 * 「押せるのに効かない」という最も分かりにくい状態になる。
 *
 * ★ ただし **`.options--sticky`（現在の設問・振り返り）は殺さない。**
 * ヒントの追加や原因宣言のやりとりでメッセージが積まれても、未回答の設問は
 * **まだ答えられる現役の問い**であって、古くなったわけではない。
 * ここで無効化すると「ヒントを見たら設問に戻れない」が起きる（実際に起きた）。
 * 閉じるのは、答えられなくなった時点で呼ばれる `retireSticky()` の仕事。
 */
function push(root) {
  const node = thread()
  for (const stale of node.querySelectorAll(
    '.actions button, .options:not(.options--sticky) button',
  )) {
    /** @type {HTMLButtonElement} */ (stale).disabled = true
  }
  node.appendChild(root)
  scrollToNew(root)
  return root
}

/**
 * 現在の設問・振り返りを閉じる。**もう答えられなくなったとき**に呼ぶ
 * （次の設問に進んだ / 開示した / セッションが完了した）。
 */
export function retireSticky() {
  for (const b of thread().querySelectorAll('.options--sticky button')) {
    /** @type {HTMLButtonElement} */ (b).disabled = true
  }
  for (const list of thread().querySelectorAll('.options--sticky')) {
    list.classList.remove('options--sticky')
  }
}

/**
 * 先輩（AI）の発言。
 * @param {{
 *   lead?: string,
 *   texts?: string[],
 *   callout?: { label: string, body: string, calm?: boolean },
 *   nodes?: (Node|null|false)[],
 * }} content
 */
export function bot(content) {
  const { root, bubble } = shell({ who: BOT })
  if (content.lead) bubble.appendChild(el('p', 'msg__lead', content.lead))
  for (const text of content.texts ?? []) bubble.appendChild(el('p', 'msg__text', text))
  if (content.callout) bubble.appendChild(callout(content.callout))
  append(bubble, ...(content.nodes ?? []))
  push(root)
  return bubble
}

/**
 * 利用者の発言。`code` はエラーテキストなど**そのまま等幅で見せたい**もの。
 * @param {{ who: string, text?: string, code?: string, note?: string }} content
 */
export function user(content) {
  const { root, bubble } = shell({ who: `${content.who} (DEVELOPER)`, mine: true, avatar: '🧑' })
  if (content.text) bubble.appendChild(el('p', 'msg__text', content.text))
  if (content.code) bubble.appendChild(el('pre', 'msg__code', content.code))
  if (content.note) bubble.appendChild(el('p', 'msg__note', content.note))
  push(root)
  return bubble
}

/** @param {{ label: string, body: string, calm?: boolean }} spec */
export function callout(spec) {
  const box = el('div', spec.calm ? 'callout callout--calm' : 'callout')
  box.appendChild(el('p', 'callout__label', `${spec.label}：`))
  box.appendChild(el('p', 'callout__body', spec.body))
  return box
}

/** 「先輩が考えている」行。返り値を `remove()` すると消える（ADR-007） */
export function thinking() {
  const { root, bubble } = shell({ who: BOT })
  const line = el('div', 'thinking')
  const dots = el('span', 'thinking__dots')
  for (let i = 0; i < 3; i += 1) dots.appendChild(el('span'))
  line.appendChild(dots)
  line.appendChild(el('span', undefined, THINKING[Math.floor(Math.random() * THINKING.length)]))
  bubble.appendChild(line)
  push(root)
  return {
    remove() {
      root.remove()
    },
  }
}

/**
 * 選択肢。**押した後は全部 disabled にする。**
 * 連打による二重回答はサーバの冪等性で防いでいるが（api-spec.md §4）、
 * 押せてしまう見た目のままだと「効いていない」と読める。
 *
 * 現役の問い（設問・振り返り）は `sticky` にする。後からメッセージが積まれても
 * 無効化されず、`retireSticky()` が呼ばれるまで答えられる（`push` の注記）。
 *
 * @param {{id: string, label: string}[]} options
 * @param {(id: string) => void} onPick
 * @param {{ sticky?: boolean }} [opts]
 */
export function optionList(options, onPick, opts = {}) {
  const list = el('div', opts.sticky ? 'options options--sticky' : 'options')
  const buttons = options.map((option) =>
    button(`${option.id.toUpperCase()}. ${option.label}`, 'option', () => {
      for (const b of buttons) b.disabled = true
      onPick(option.id)
    }),
  )
  append(list, ...buttons)
  return list
}

/**
 * 行動ボタンの並び。
 *
 * `kind` はモックの配色に合わせるためのもの。
 * `brand`（紫の塗り）/ `ghost`（白の枠）/ 既定は淡い紫、`primary` はアクセント。
 *
 * @param {{label: string, onClick: () => void, primary?: boolean, kind?: 'brand'|'ghost', disabled?: boolean}[]} specs
 */
export function actionBar(specs) {
  const bar = el('div', 'actions')
  for (const spec of specs) {
    const className = spec.primary
      ? 'btn btn--primary btn--small'
      : spec.kind === 'brand'
        ? 'btn btn--brand'
        : spec.kind === 'ghost'
          ? 'btn btn--ghost'
          : 'btn'
    const b = button(spec.label, className, spec.onClick)
    b.disabled = Boolean(spec.disabled)
    bar.appendChild(b)
  }
  return bar
}

/** ヒントの積み上げ表示。段階が進んでも履歴として残す */
export function hintList(hints) {
  const list = el('ul', 'hint-list')
  for (const hint of hints) {
    const li = el('li', 'hint-list__item')
    li.appendChild(el('span', 'hint-list__level', `Lv${hint.level}`))
    li.appendChild(el('span', undefined, hint.body))
    list.appendChild(li)
  }
  return list
}
