// @ts-check
/**
 * 型検査にも lint にも出ない、**組み上げないと分からない壊れ方**を押さえる。
 *
 * ここまでに 2 件出している。どちらも CSS 1 行が原因で、
 * どちらもコードを読んでいる限り正しく見えた。
 *
 *   1. `hidden` がクラス側の `display` に打ち消され、フォームが同時に出ていた
 *   2. グリッド項目の `min-height` 不足で、入力欄が画面外に出ていた
 *
 * ## このテストで**できないこと**
 *
 * jsdom はレイアウトを持たない。高さも位置も計算されないため、
 * **「入力欄が画面内にあるか」は確かめられない。** 2 のような不具合は
 * 実ブラウザで見るしかなく、ここでできるのは
 * 「原因になった規則が消えていないか」を留めることだけ。
 * その旨は該当の describe に書いてある。
 *
 * ## 画面の出し分け
 *
 * この画面はページ遷移を持たず、すべての切替を `hidden` 属性で行っている
 * （ADR-012 / ADR-013）。ところが `hidden` を効かせているのはブラウザ標準の
 * `[hidden] { display: none }` で、これは**作者スタイルより弱い。**
 * クラス側に `display: flex` を 1 行書いた瞬間、`hidden` は黙って無効になる。
 *
 * 実際に、ログイン画面でログインと新規登録のフォームが同時に出ていた。
 * 型検査でも lint でも出ない。**組み上げて計算済みスタイルを見るしかない。**
 *
 * ここで守るのは「hidden を立てたら消える」という一点で、見た目は対象にしない。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { beforeAll, describe, expect, it } from 'vitest'

const read = (name) => readFileSync(fileURLToPath(new URL(`../public/${name}`, import.meta.url)), 'utf8')

/** @type {import('jsdom').JSDOM} */
let dom

beforeAll(() => {
  const html = read('index.html')
  const css = read('styles.css')
  // 外部参照（<link rel="stylesheet">）は読ませず、中身を直接埋め込む
  dom = new JSDOM(html.replace('<link rel="stylesheet" href="styles.css" />', `<style>${css}</style>`))
})

const isVisible = (id) => {
  const node = dom.window.document.getElementById(id)
  if (!node) throw new Error(`要素がありません: #${id}`)
  return dom.window.getComputedStyle(node).display !== 'none'
}

const setHidden = (id, value) => {
  const node = dom.window.document.getElementById(id)
  if (!node) throw new Error(`要素がありません: #${id}`)
  node.hidden = value
}

/**
 * 切替対象。**クラス側に display を持つものを必ず含める**（それが壊れる条件のため）。
 * 括弧内はそのクラスが指定している display。
 */
const TOGGLED = [
  'login', //          .login   grid
  'app', //            .app     grid
  'form-login', //     .form    flex
  'form-signup', //    .form    flex
  'view-chat', //      .view    flex
  'view-dashboard', // .view    flex
  'view-history', //   .view    flex
  'btn-send', //       .send    grid
  'mask', //           指定なし
  'error', //          指定なし
  'mock-badge', //     指定なし（span）
]

describe('hidden 属性で消える（作者スタイルの display に打ち消されない）', () => {
  for (const id of TOGGLED) {
    it(`#${id}`, () => {
      setHidden(id, true)
      expect(isVisible(id), `#${id} は hidden にしても消えていない`).toBe(false)
      setHidden(id, false)
      expect(isVisible(id), `#${id} は hidden を外しても出てこない`).toBe(true)
    })
  }
})

describe('ログイン画面のタブ', () => {
  /** `main.js` の selectTab と同じ操作。ロジックではなく**結果**を確かめる */
  const selectTab = (which) => {
    const isLogin = which === 'login'
    setHidden('form-login', !isLogin)
    setHidden('form-signup', isLogin)
  }

  it('ログインを選ぶと新規登録のフォームは出ない', () => {
    selectTab('login')
    expect(isVisible('form-login')).toBe(true)
    expect(isVisible('form-signup')).toBe(false)
  })

  it('新規登録を選ぶとログインのフォームは出ない', () => {
    selectTab('signup')
    expect(isVisible('form-signup')).toBe(true)
    expect(isVisible('form-login')).toBe(false)
  })

  it('招待コードと表示名は新規登録のときだけ入力できる', () => {
    selectTab('login')
    for (const name of ['inviteCode', 'displayName']) {
      const field = dom.window.document.querySelector(`#form-signup [name="${name}"]`)
      expect(field, `${name} の入力欄がありません`).not.toBeNull()
    }
    // ログイン側にはそもそも存在しない（隠れているだけ、にしない）
    expect(dom.window.document.querySelector('#form-login [name="inviteCode"]')).toBeNull()
    expect(dom.window.document.querySelector('#form-login [name="displayName"]')).toBeNull()
  })
})

/**
 * ⚠️ **レイアウトそのものは検証できていない**（jsdom に高さの計算がないため）。
 * ここで留めているのは「入力欄が画面外に出た原因の規則が残っているか」だけ。
 *
 * スレッドが伸びると .main が画面より高くなり、下端の入力欄が
 * body の overflow: hidden に隠れて触れなくなっていた。
 * グリッド項目の既定が `min-height: auto`（中身より小さくなれない）ためで、
 * .thread / .view の min-height: 0 はフレックス側の話なので効かない。
 */
describe('入力欄が画面外に出ないための規則が残っている', () => {
  const styleOf = (selector, prop) => {
    const node = dom.window.document.querySelector(selector)
    if (!node) throw new Error(`要素がありません: ${selector}`)
    return dom.window.getComputedStyle(node)[prop]
  }

  it('.app が行を minmax(0, …) で切っている（暗黙の auto 行だと中身の分だけ伸びる）', () => {
    expect(styleOf('.app', 'gridTemplateRows')).toContain('minmax(0')
  })

  it('.main がグリッド項目として中身より小さくなれる', () => {
    expect(styleOf('.main', 'minHeight')).toBe('0')
  })

  it('スレッドだけがはみ出しを引き受け、入力欄は縮まない', () => {
    expect(styleOf('.thread', 'overflowY')).toBe('auto')
    expect(styleOf('.thread', 'minHeight')).toBe('0')
    expect(styleOf('.composer', 'flexShrink')).toBe('0')
  })
})

describe('初期表示', () => {
  it('起動直後はログインも本体も出さない（どちらを出すかは /v1/me の結果で決まる）', () => {
    const fresh = new JSDOM(read('index.html'))
    for (const id of ['login', 'app']) {
      expect(fresh.window.document.getElementById(id)?.hidden, `#${id}`).toBe(true)
    }
  })

  it('対話ビューだけが最初から表示、他のビューは隠れている', () => {
    const fresh = new JSDOM(read('index.html'))
    expect(fresh.window.document.getElementById('view-chat')?.hidden).toBe(false)
    expect(fresh.window.document.getElementById('view-dashboard')?.hidden).toBe(true)
    expect(fresh.window.document.getElementById('view-history')?.hidden).toBe(true)
  })
})
