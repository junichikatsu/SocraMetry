import type { Stage } from '@socrametry/shared'
import type {
  DiagnoserOutput,
  JudgeOutput,
  QuestionerOutput,
  ReporterOutput,
  RevealerOutput,
} from './schemas'

/**
 * MOCK モードの固定応答（ADR-014 / FR-16）。
 *
 * `MOCK_MODE=true` のとき LLM を一切呼ばない。**各役割の入口 1 箇所で分岐する。**
 *
 * | 局面 | 効果 |
 * |---|---|
 * | UI 開発 | LLM の応答を待たずに全画面を通せる |
 * | 自動テスト | 応答が決定的になり、主要導線のテストが書ける（F13） |
 * | コスト | 開発中・CI の LLM 課金がゼロ |
 * | **デモ** | 通信障害・レート制限・モデル障害があっても導線が最後まで通る |
 *
 * **固定応答は LeakGuard を通る文面にしてある。**
 * ここが引っかかると MOCK モードの導線が毎回テンプレートに落ち、
 * 「MOCK では通るのに本番では違う」という一番デバッグしづらい差が生まれる。
 */

export const MOCK_DIAGNOSIS: DiagnoserOutput = {
  rootCause:
    'props で渡される items が API 応答前の初回レンダリング時に undefined になっている',
  confidence: 0.82,
  evidence: [
    'スタックトレース 3 行目が ProductList.tsx:24 を指している',
    'map の呼び出し元がガードされていない',
  ],
  focusHints: [
    { stage: 'observe', lookAt: 'エラーメッセージの「reading」の直前部分' },
    { stage: 'localize', lookAt: 'スタックトレース最上位のアプリケーションコード行' },
    { stage: 'hypothesize', lookAt: 'その値がどこから渡ってきているか' },
    { stage: 'verify', lookAt: 'その値の初回描画時点の中身' },
    { stage: 'fix', lookAt: 'データが未到着の間の表示の扱い' },
  ],
  distractorThemes: ['構文エラーの可能性', 'ライブラリのバージョン不整合', '型定義の欠落'],
  difficulty: 'medium',
  gateAHints: [
    'エラーメッセージの後半に注目してみてください。',
    '「reading」の直後の単語が、失敗した操作を表しています。',
    '「X of undefined」という形は、X を持っているはずの入れ物が空だったことを意味します。',
  ],
}

/** Gate A の Lv1（診断前）。エラーテキストだけから作れる汎用ヒント */
export const MOCK_HINT = 'エラーメッセージの後半に注目してみてください。'

/**
 * 段階別の固定設問。
 * **意図的に、診断文の語彙と重ならない文面にしている**（LeakGuard L4 対策）。
 */
export const MOCK_QUESTIONS: Record<Stage, QuestionerOutput> = {
  observe: {
    question: 'このエラーメッセージは、何が undefined だったと言っていますか？',
    options: [
      { id: 'a', label: 'map という名前の変数' },
      { id: 'b', label: 'map を呼び出そうとした対象' },
      { id: 'c', label: 'map に渡したコールバック関数' },
      { id: 'd', label: 'map の戻り値' },
    ],
    correctOptionId: 'b',
    rationaleIfCorrect: 'どの対象に対する操作かを特定できています。',
    rationaleIfWrong: {
      a: 'メッセージの語順をもう一度追ってみてください。',
      c: '括弧の中と外、どちらの話をしているでしょうか。',
      d: 'そもそも呼び出しは成功したでしょうか。',
    },
  },
  localize: {
    question: 'その対象は、どこから渡ってきていますか？',
    options: [
      { id: 'a', label: '同じ関数の中で宣言されている' },
      { id: 'b', label: '呼び出し元から引数として渡されている' },
      { id: 'c', label: 'ライブラリの内部で作られている' },
      { id: 'd', label: 'グローバル変数として定義されている' },
    ],
    correctOptionId: 'b',
    rationaleIfCorrect: '値の出所を辿れています。次はその出所の中身を疑ってみましょう。',
    rationaleIfWrong: {
      a: 'スタックトレース最上位の行をもう一度見てみてください。',
      c: 'アプリケーション側のコードとライブラリ側、どちらの行でしょうか。',
      d: '宣言されている場所を探してみてください。',
    },
  },
  hypothesize: {
    question: 'その値が空になりうるのは、どんなときだと考えられますか？',
    options: [
      { id: 'a', label: '構文が間違っているとき' },
      { id: 'b', label: 'まだ値が用意されていない時点で読まれたとき' },
      { id: 'c', label: 'ライブラリのバージョンが古いとき' },
      { id: 'd', label: '型定義が欠けているとき' },
    ],
    correctOptionId: 'b',
    rationaleIfCorrect: 'タイミングに目を向けられています。',
    rationaleIfWrong: {
      a: '構文が誤っていれば、そもそもこの行まで到達するでしょうか。',
      c: 'バージョンを変えていない状況でも起きうるでしょうか。',
      d: '型定義は実行時の中身を保証するでしょうか。',
    },
  },
  verify: {
    question: 'その考えが正しいと確かめるには、まず何を見ますか？',
    options: [
      { id: 'a', label: '読み込んでいる時点でのその値の中身' },
      { id: 'b', label: 'ライブラリの CHANGELOG' },
      { id: 'c', label: '本番環境のアクセスログ' },
      { id: 'd', label: 'コードの総行数' },
    ],
    correctOptionId: 'a',
    rationaleIfCorrect: '思い込みを潰す手順を選べています。',
    rationaleIfWrong: {
      b: '外部の資料より先に、手元の値を見られないでしょうか。',
      c: 'この現象は手元でも再現していないでしょうか。',
      d: '規模と今回の現象は関係しているでしょうか。',
    },
  },
  fix: {
    question: '同じことを二度起こさないために、どこに何を足しますか？',
    options: [
      { id: 'a', label: '値が未到着の状態を明示的に扱う' },
      { id: 'b', label: '例外を握りつぶして表示を止めない' },
      { id: 'c', label: '該当行をコメントアウトする' },
      { id: 'd', label: 'ライブラリを最新版に上げる' },
    ],
    correctOptionId: 'a',
    rationaleIfCorrect: '対症療法で終わらせず、状態そのものを扱えています。',
    rationaleIfWrong: {
      b: '現象は見えなくなりますが、原因は残るでしょうか。',
      c: '機能そのものが失われないでしょうか。',
      d: '今回の現象はバージョンに起因していたでしょうか。',
    },
  },
}

/**
 * 到達判定の固定応答。
 *
 * **`reached` を返せることが重要。** デモとテストで Gate A / B の完了導線
 * （最良の結末）を通す必要があるため、キーワードを含む宣言は `reached` にする。
 * 決定的なルールなので、同じ入力からは常に同じ判定が出る。
 */
const MOCK_REACHED_KEYWORDS = [
  'undefined',
  '未到着',
  '初回',
  '非同期',
  '応答',
  'レンダリング',
  '描画',
  'props',
  'items',
  '空',
]

export function mockJudge(conclusion: string): JudgeOutput {
  const hit = MOCK_REACHED_KEYWORDS.some((k) => conclusion.includes(k))
  return hit
    ? {
        verdict: 'reached',
        feedback: 'その通りです。データが到着する前の状態を見落としていた、という構造ですね。',
      }
    : {
        verdict: 'partial',
        feedback: 'その現象が起きるのはどんなタイミングでしょうか。もう一段だけ掘ってみましょう。',
      }
}

export const MOCK_REVEAL: RevealerOutput = {
  rootCause:
    'props の items が API 応答前の初回レンダリングで undefined だったため、map の呼び出しが失敗していました。',
  evidence: [
    'スタックトレース 3 行目が ProductList.tsx:24 を指しています',
    'items は親から props で渡され、フェッチ完了前は未定義のままです',
  ],
  fixDirection:
    'データ到着前の状態を明示的に扱います。初期値を与えるか、未到着時の表示を分けます。',
  prevention:
    '非同期データを受け取る props には、未到着の状態を型で表現しておくと同種のバグを防げます。',
}

export const MOCK_REPORT: ReporterOutput = {
  stumblingPoint: '切り分けの段階で、値の出所を辿るまでに時間がかかりました。',
  generalizedLesson:
    '「X of undefined」は常に「X を持っているはずの入れ物が空だった」ことを意味します。まず入れ物の出所を辿るのが最短経路です。',
  nextTimeSteps: [
    'エラーメッセージから、失敗した操作とその対象を特定する',
    'スタックトレース最上位のアプリケーションコード行を開く',
    'その値が非同期で来るなら、到着前の状態を必ず確認する',
  ],
}

/** Gate C の振り返り 1 問（socratic-engine.md §8）。LLM を使わない固定文 */
export const RETROSPECTION_QUESTION = {
  question: '今回、どの段階で見落としがありましたか？',
  options: [
    { id: 'a', label: 'エラーメッセージの読み取り' },
    { id: 'b', label: '変更点の洗い出し' },
    { id: 'c', label: '原因の推論' },
    { id: 'd', label: '仮説の確かめ方' },
  ],
} as const
