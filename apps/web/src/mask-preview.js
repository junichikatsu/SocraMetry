// @ts-check
/**
 * 送信前のマスキングプレビュー（security.md §3 の A / v0.1 必須）。
 *
 * **サーバと同じ純関数を使う。** これがビルド工程を入れた唯一の理由（ADR-013 改訂）。
 * プレビュー用に正規表現を書き写すと、片方だけ直された瞬間に
 * 「画面では消えているのにサーバには生で届く」表示になる。それは無いより悪い。
 *
 * > **クライアント側のマスクは UX であり、保証ではない**（security.md §3）。
 * > 正はサーバ側の再実行。冪等なので二重に適用しても結果は変わらない。
 * > 「クライアントで消しているから安全」という説明はしない。
 */
import { maskDetail } from '@socrametry/core/masking'
import { byId } from './dom.js'

/** 種別の日本語名。件数だけを出し、**何が消えたかは本文以外に書かない** */
const KIND_LABEL = {
  jwt: 'JWT',
  token: 'トークン',
  credentials: '接続文字列の資格情報',
  key: 'API キー',
  path: '絶対パス',
  email: 'メールアドレス',
  name: '除外語',
}

/**
 * 除外語（社名・製品名）はサーバの `MASK_WORDS` にしかない。
 * **クライアントには渡さない。** 環境変数の中身を画面から読めるようにすると、
 * 「どの社名を扱っているか」がブラウザに出てしまう。
 * ここで消えなかった固有名詞は利用者が手で伏せる、という導線に寄せる
 * （security.md §3 の「手動マスクはクライアントでしか実装できない」）。
 */
export function mask(text) {
  return maskDetail(text)
}

let dismissed = false

export function setupMaskPreview() {
  byId('mask-toggle').addEventListener('click', () => {
    dismissed = true
    render('')
  })
}

/**
 * 入力のたびに呼ぶ。**確認モーダルではなく常時表示のパネル**にしている
 * （security.md §3 の注記）。
 */
export function render(raw) {
  const panel = byId('mask')
  const title = byId('mask-title')
  const preview = byId('mask-preview')

  const trimmed = raw.trim()
  if (trimmed === '' || dismissed) {
    panel.hidden = true
    return
  }

  const result = mask(raw)
  const hits = Object.entries(result.hits).filter(([, n]) => n > 0)

  panel.hidden = false
  preview.textContent = result.text

  if (hits.length === 0) {
    title.textContent = '送信前のマスキング結果 — 伏せた箇所はありません'
    title.classList.remove('mask__title--hit')
  } else {
    const summary = hits.map(([kind, n]) => `${KIND_LABEL[kind] ?? kind} ${n} 件`).join(' / ')
    title.textContent = `送信前のマスキング結果 — ${summary}を伏せました`
    title.classList.add('mask__title--hit')
  }
}

/** 送信後などに畳む。次の入力でまた開く */
export function reset() {
  dismissed = false
  byId('mask').hidden = true
}
