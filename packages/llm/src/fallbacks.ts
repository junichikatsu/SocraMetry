import type { Stage } from '@socrametry/shared'
import type { QuestionerOutput } from './schemas'

/**
 * 定型フォールバック（socratic-engine.md §5 / §2「診断が失敗したとき」）。
 *
 * 使う場面は 2 つ。
 *
 * | 場面 | 理由 |
 * |---|---|
 * | LeakGuard が再生成後も漏洩を検出した | 3 回目の生成は試さない。**確率に頼らない** |
 * | LLM 呼び出しが退避モデルでも失敗した | 「エラーを投げたのに何も返ってこない」を避ける（NFR-O4 / FR-17） |
 *
 * **体験は劣化するが継続はできる。** 内容を汎用にしているのは、
 * どのエラーに対しても成立させる必要があるため。
 * 個別化されていない問いなので、ここに落ちた回数は運用ログで追う。
 */

export const FALLBACK_QUESTIONS: Record<Stage, QuestionerOutput> = {
  observe: {
    question: 'エラーを読むとき、最初に特定すべきものはどれですか？',
    options: [
      { id: 'a', label: '失敗した操作と、その操作の対象' },
      { id: 'b', label: '使っているライブラリのバージョン' },
      { id: 'c', label: 'コード全体の行数' },
      { id: 'd', label: '実行しているマシンの OS' },
    ],
    correctOptionId: 'a',
    rationaleIfCorrect: 'エラーは「何に対する何の操作が失敗したか」を必ず含んでいます。',
    rationaleIfWrong: {
      b: 'メッセージ本文から読み取れるのはどちらでしょうか。',
      c: '規模と今回の現象は関係しているでしょうか。',
      d: '同じメッセージは他の環境でも出ないでしょうか。',
    },
  },
  localize: {
    question: '問題箇所を絞り込むとき、最初に開くとよいのはどれですか？',
    options: [
      { id: 'a', label: 'スタックトレース最上位のアプリケーションコード行' },
      { id: 'b', label: 'ライブラリ内部の行' },
      { id: 'c', label: '設定ファイルの全体' },
      { id: 'd', label: 'README' },
    ],
    correctOptionId: 'a',
    rationaleIfCorrect: '自分の書いたコードから辿るのが最短経路です。',
    rationaleIfWrong: {
      b: '自分で変更できるのはどちらの行でしょうか。',
      c: '範囲を狭めるという目的に合っているでしょうか。',
      d: '実行時の状態が書かれているでしょうか。',
    },
  },
  hypothesize: {
    question: '仮説を立てるとき、優先して疑うとよいのはどれですか？',
    options: [
      { id: 'a', label: '直前に変更した箇所' },
      { id: 'b', label: '長年動いている共通処理' },
      { id: 'c', label: '言語仕様そのもの' },
      { id: 'd', label: 'CPU の性能' },
    ],
    correctOptionId: 'a',
    rationaleIfCorrect: '「昨日まで動いていた」なら、変わったところに理由があります。',
    rationaleIfWrong: {
      b: '今日になって壊れた説明がつくでしょうか。',
      c: 'それが原因なら他の箇所も壊れないでしょうか。',
      d: '同じ現象は別のマシンでも起きないでしょうか。',
    },
  },
  verify: {
    question: '仮説を確かめる手段として、最初に取るとよいのはどれですか？',
    options: [
      { id: 'a', label: '疑っている値を出力して実際の中身を見る' },
      { id: 'b', label: '思いついた修正を先に当ててみる' },
      { id: 'c', label: '関係する記事を検索する' },
      { id: 'd', label: '再起動して様子を見る' },
    ],
    correctOptionId: 'a',
    rationaleIfCorrect: '思い込みを潰してから動くのが、遠回りを避ける道です。',
    rationaleIfWrong: {
      b: '当たったとしても、なぜ直ったか分かるでしょうか。',
      c: '手元の事実より先に見るべきものでしょうか。',
      d: '再現条件が分からなくなるおそれはないでしょうか。',
    },
  },
  fix: {
    question: '再発しない直し方として適切なのはどれですか？',
    options: [
      { id: 'a', label: '想定外の状態を明示的に扱えるようにする' },
      { id: 'b', label: 'エラーを握りつぶして表示だけ通す' },
      { id: 'c', label: '該当行をコメントアウトする' },
      { id: 'd', label: '再試行を無制限に繰り返す' },
    ],
    correctOptionId: 'a',
    rationaleIfCorrect: '対症療法で終わらせず、状態そのものを設計に含められています。',
    rationaleIfWrong: {
      b: '次に同じことが起きたとき気づけるでしょうか。',
      c: '機能そのものが失われないでしょうか。',
      d: '原因が残ったままでも収束するでしょうか。',
    },
  },
}

/**
 * Gate A の定型ヒント（Lv1〜3）。
 * 診断も Hinter も失敗したときに使う。**答えは含まない。**
 */
export const FALLBACK_HINTS = [
  'エラーメッセージの後半に注目してみてください。何に対する操作が失敗したかが書かれています。',
  'スタックトレースの中で、自分が書いたコードの行を探してみてください。',
  'エラーの形そのものに注目してください。同じ形のエラーは、いつも同じ種類の見落としから生まれます。',
] as const

export function fallbackHint(level: number): string {
  const index = Math.min(Math.max(level, 1), FALLBACK_HINTS.length) - 1
  return FALLBACK_HINTS[index] ?? FALLBACK_HINTS[0]
}

/** Judge が失敗したときの扱い。**勝手に `reached` にしない**（評価が甘くなる） */
export const FALLBACK_JUDGE = {
  verdict: 'partial' as const,
  feedback:
    '判定処理が一時的に応答しませんでした。もう少し具体的に、どの時点で何が起きたかを書き足してみてください。',
}

export const FALLBACK_REVEAL = {
  fixDirection: '観測できた事実に基づいて、想定外の状態を明示的に扱う形へ直すのが基本方針です。',
  prevention: '同じ状態が再び起きたときに気づけるよう、境界に検査を置いておくと再発を防げます。',
}

export const FALLBACK_REPORT = {
  stumblingPoint: 'この回の詳細な振り返りは生成できませんでした。道筋の記録をご確認ください。',
  generalizedLesson:
    'エラーは「何に対する何の操作が失敗したか」を必ず含んでいます。まずその 2 つを特定するのが最短経路です。',
  nextTimeSteps: [
    'エラーメッセージから、失敗した操作とその対象を特定する',
    'スタックトレース最上位のアプリケーションコード行を開く',
    '疑っている値を出力し、実際の中身を確認する',
  ],
}
