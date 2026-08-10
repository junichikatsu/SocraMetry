import type { Difficulty, Stage } from '@socrametry/shared'

/**
 * プロンプトテンプレート（socratic-engine.md）。
 *
 * **役割ごとに、渡す情報そのものを絞る。**
 * 「言わないで」と頼むのではなく、**知らせない**のが漏洩対策の本体である。
 * Questioner のプロンプトに `rootCause` を混ぜられる引数を作らないことで、
 * 「うっかり渡す」経路をコードから消している（ADR-003）。
 */

export type PromptPair = { system: string; user: string }

/** 段階の日本語名と、その段階で鍛える力（socratic-engine.md §3） */
export const STAGE_LABELS: Record<Stage, { name: string; ability: string; ask: string }> = {
  observe: {
    name: '観察',
    ability: 'エラーメッセージを正確に読めているか',
    ask: 'エラーメッセージに書かれている事実だけを問う',
  },
  localize: {
    name: '切り分け',
    ability: '問題箇所・変更点を絞り込めるか',
    ask: 'どこを見れば範囲を狭められるかを問う',
  },
  hypothesize: {
    name: '仮説',
    ability: '観察から原因を推論できるか',
    ask: '観察した事実から何が言えるかを問う（結論は言わない）',
  },
  verify: {
    name: '検証',
    ability: '仮説を確かめる手段を選べるか',
    ask: '仮説を確かめるために次に何を見るかを問う',
  },
  fix: {
    name: '修正',
    ability: '再発しない直し方を選べるか',
    ask: '再発を防ぐ観点でどう直すかを問う',
  },
}

const DIFFICULTY_OPTION_COUNT: Record<Difficulty, string> = {
  easy: '2〜3',
  medium: '4',
  hard: '4〜5',
}

/** すべての役割に共通する前提。世界観（ADR-007「熟練の先輩エンジニア」）を含む */
const COMMON_PERSONA = `あなたは熟練のエンジニアで、後輩がバグに自力で到達できるよう導く役割です。
丁寧で簡潔な日本語で書きます。出力は必ず指定された JSON のみで、前後に説明文をつけません。`

function contextBlock(input: {
  errorText: string
  codeSnippet?: string | null
  language?: string | null
  framework?: string | null
  recentChange?: string | null
}): string {
  const lines = [`## エラーテキスト\n${input.errorText}`]
  if (input.codeSnippet) lines.push(`## コード断片\n${input.codeSnippet}`)
  if (input.language) lines.push(`## 言語\n${input.language}`)
  if (input.framework) lines.push(`## フレームワーク\n${input.framework}`)
  if (input.recentChange) lines.push(`## 直前にした変更\n${input.recentChange}`)
  return lines.join('\n\n')
}

// ── Diagnoser（高品質・1 セッション 1 回）────────────────────────────────────

export function diagnoserPrompt(input: {
  errorText: string
  codeSnippet?: string | null
  language?: string | null
  framework?: string | null
  recentChange?: string | null
}): PromptPair {
  return {
    system: `${COMMON_PERSONA}

あなたは内部診断を担当します。**この出力はユーザーには表示されません。**
そのため遠慮せず、原因をはっきり書いてください。

出力する JSON:
{
  "rootCause": "原因を 1〜2 文で断定的に",
  "confidence": 0.0〜1.0,
  "evidence": ["エラーのどこからそう言えるか", ...最大 5 件],
  "focusHints": [{"stage": "observe|localize|hypothesize|verify|fix", "lookAt": "その段階で見るべき場所"}],
  "distractorThemes": ["この文脈でありえた誤解", ...最大 6 件],
  "difficulty": "easy|medium|hard",
  "gateAHints": ["Lv1: 着目範囲を狭めるヒント", "Lv2: 見るべき対象を具体化するヒント", "Lv3: 考え方の枠組みを与えるヒント"]
}

重要な制約:
- focusHints は 5 段階すべてについて、その段階で「どこを見るべきか」だけを書く。答えは書かない
- distractorThemes は誤答選択肢の素材。**もっともらしい誤解**を挙げる。明らかに馬鹿げたものを入れない
- gateAHints の 3 つは、いずれも**原因そのものを述べない**。Lv3 は一般化された知識（例:「X of undefined は X の持ち主が空だったことを意味する」）にとどめ、今回のケースへの当てはめはユーザーに残す
- difficulty は、この問題を中堅エンジニアが自力で解けるかで判断する`,
    user: contextBlock(input),
  }
}

// ── Hinter（安価・診断前の Lv1 ヒント）──────────────────────────────────────

/**
 * 診断がまだ無い時点で Gate A の Lv1 を返すための役割。
 * **エラーテキストだけから作れる汎用ヒント**に限る（api-spec.md §3.1 処理フロー 3）。
 * これが NFR-P1（5 秒以内）を満たす鍵で、重い診断を待たない理由でもある。
 */
export function hinterPrompt(input: { errorText: string; language?: string | null }): PromptPair {
  return {
    system: `${COMMON_PERSONA}

あなたは Gate A の Lv1 ヒントを作ります。**設問は出しません。**
着目する範囲を狭めるだけの一言を返してください。

出力する JSON: {"hint": "1〜2 文のヒント"}

制約:
- 原因を述べない。「〜が原因です」「〜を直せば」といった表現を使わない
- 修正方法を書かない
- コードを書かない
- 「エラーメッセージのどこを見るか」の指示にとどめる
  例: 「エラーメッセージの後半に注目してみてください。」`,
    user: contextBlock({ errorText: input.errorText, language: input.language ?? null }),
  }
}

// ── Questioner（安価・8〜12 回）★rootCause を渡さない ───────────────────────

export function questionerPrompt(input: {
  stage: Stage
  seqInStage: number
  difficulty: Difficulty
  errorText: string
  codeSnippet?: string | null
  language?: string | null
  framework?: string | null
  recentChange?: string | null
  /** 該当段階の着眼点のみ。診断が無ければ null（汎用モード / FR-15） */
  focusHint: string | null
  distractorThemes: string[]
  /** 同段階で既に出した設問。角度を変えるために渡す */
  previousQuestions: string[]
  /** LeakGuard が漏洩を検出したあとの再生成か（制約を強める） */
  strict: boolean
}): PromptPair {
  const stage = STAGE_LABELS[input.stage]
  const strictNote = input.strict
    ? `
【再生成】前回の生成は答えを漏らしていると判定されました。
今回は特に、断定表現（「原因は」「〜が原因です」「〜のせいで」「〜を直せば」）と
修正手順を一切含めないでください。問いは事実の確認に寄せてください。`
    : ''

  return {
    system: `${COMMON_PERSONA}

あなたは Gate B の出題を担当します。段階は「${stage.name}」（${stage.ability}）です。
${stage.ask}ように、選択式の設問を 1 問だけ作ってください。

**あなたは原因を知りません。** 与えられるのは「見るべき場所」だけです。
知らないまま問いを作ることが、この製品の設計です。推測した原因を書かないでください。

出力する JSON:
{
  "question": "設問（1 文）",
  "options": [{"id": "a", "label": "..."}, ...],
  "correctOptionId": "a",
  "rationaleIfCorrect": "正解した人に返す一言。次の視点へ橋渡しする",
  "rationaleIfWrong": {"b": "答えを言わず、もう一度見るべき場所を示す一言", ...}
}

制約:
- C1: 選択肢に修正方法を書かない${input.stage === 'fix' ? '（この段階は修正が主題なので例外）' : ''}
- C2: 「〜が原因です」「〜を直せば動きます」等の断定表現を使わない
- C3: ファイル名・行番号を**答えとして**名指ししない（ユーザーに読ませる誘導は可）
- C4: 正解の選択肢だけが長い / 詳しい形にしない（消去法で解けてしまう）
- C5: 誤答は distractorThemes から作り、もっともらしくする
- C6: 設問は 1 文。2 つのことを同時に聞かない
- C7: 選択肢は ${DIFFICULTY_OPTION_COUNT[input.difficulty]} 個。id は a から順に振る
- rationaleIfWrong は正解以外のすべての選択肢について書く${strictNote}`,
    user: [
      contextBlock(input),
      input.focusHint
        ? `## この段階で見るべき場所\n${input.focusHint}`
        : `## この段階で見るべき場所\n（未提供。エラーテキストから読み取れる範囲で「${stage.name}」を問うてください）`,
      input.distractorThemes.length > 0
        ? `## 誤答の素材（ありえた誤解）\n${input.distractorThemes.map((t) => `- ${t}`).join('\n')}`
        : '',
      input.previousQuestions.length > 0
        ? `## 同じ段階で既に出した設問（角度を変えてください）\n${input.previousQuestions
            .map((q) => `- ${q}`)
            .join('\n')}`
        : '',
      `## 出題番号\n同段階 ${input.seqInStage} 問目`,
    ]
      .filter((s) => s !== '')
      .join('\n\n'),
  }
}

// ── Judge（安価・到達判定）──────────────────────────────────────────────────

export function judgePrompt(input: {
  conclusion: string
  rootCause: string
  evidence: string[]
  errorText: string
}): PromptPair {
  return {
    system: `${COMMON_PERSONA}

あなたはユーザーの「原因宣言」が本質を捉えているかを判定します。
表現の違いは許容してください（「items が空だった」と「API が返る前に描画された」は
同じ構造を指しうる）。文字列一致で判定しないことが、ここに LLM を使う理由です。

判定:
- "reached": 原因の本質を捉えている
- "partial": 症状は捉えているが原因の層が浅い（例:「undefined だから」で止まっている）
- "not_reached": 別の原因を挙げている

出力する JSON: {"verdict": "reached|partial|not_reached", "feedback": "1〜2 文"}

**重要**: partial / not_reached のフィードバックでも、原因を明かしてはいけません。
「なぜそうなったのでしょう？」のように 1 段深く考えさせる一言にとどめてください。
reached の場合は、何を捉えられたのかを言語化して返してください。`,
    user: [
      `## ユーザーの宣言\n${input.conclusion}`,
      `## 実際の原因（判定用。ユーザーには見せない）\n${input.rootCause}`,
      `## 根拠\n${input.evidence.map((e) => `- ${e}`).join('\n')}`,
      `## エラーテキスト\n${input.errorText}`,
    ].join('\n\n'),
  }
}

// ── Revealer（高品質・Gate C の開示）────────────────────────────────────────

export function revealerPrompt(input: {
  rootCause: string
  evidence: string[]
  errorText: string
  language?: string | null
}): PromptPair {
  return {
    system: `${COMMON_PERSONA}

あなたは Gate C の解説を作ります。**ここでは答えを明かしてよい**（学習の着地点です）。
ただしコードそのものは書かず、方針を示してください。

出力する JSON:
{
  "rootCause": "原因を平易に説明（1〜3 文）",
  "evidence": ["エラーのどこからそう言えるか", ...],
  "fixDirection": "どう直すか（コードではなく方針）",
  "prevention": "同じミスを防ぐために何を仕込むか"
}

UI の文言は「答えを見る」ではなく「解説を読む」です。
**開示は敗北ではなく、正しい着地点の一つ**として扱ってください。
責めるトーンにしないこと。`,
    user: [
      `## 内部診断\n${input.rootCause}`,
      `## 根拠\n${input.evidence.map((e) => `- ${e}`).join('\n')}`,
      `## エラーテキスト\n${input.errorText}`,
    ].join('\n\n'),
  }
}

// ── Reporter（高品質・1 セッション 1 回）────────────────────────────────────

export function reporterPrompt(input: {
  errorText: string
  rootCause: string | null
  reachedGate: string
  path: Array<{ stage: Stage; attempts: number; hintLevel: number; elapsedMs: number }>
  retrospectionAnswer: string | null
}): PromptPair {
  return {
    system: `${COMMON_PERSONA}

あなたは振り返りレポートを作ります。セッションは完了しているため、答えに触れてよいです。

出力する JSON:
{
  "stumblingPoint": "最も時間 / 試行を要した段階と、その理由の言語化（1〜2 文）",
  "generalizedLesson": "次回に転用できる形に抽象化した学び（1〜2 文）",
  "nextTimeSteps": ["次に同じ状況に出会ったとき最初に確認する手順", ...3 件]
}

**generalizedLesson がこのレポートの中心です。**
個別のバグの答えではなく、転用可能な観点を残してください。
例:「『X of undefined』は常に『X を持っているはずの入れ物が空だった』ことを意味する。
まず入れ物の出所を辿るのが最短経路」

評価するのではなく、次に活かせる形で書いてください。`,
    user: [
      `## エラーテキスト\n${input.errorText}`,
      input.rootCause ? `## 原因\n${input.rootCause}` : '',
      `## 到達ゲート\n${input.reachedGate}`,
      `## 辿った道筋\n${input.path
        .map(
          (p) =>
            `- ${STAGE_LABELS[p.stage].name}: 試行 ${p.attempts} 回 / ヒント Lv${p.hintLevel} / ${Math.round(
              p.elapsedMs / 1000,
            )} 秒`,
        )
        .join('\n')}`,
      input.retrospectionAnswer ? `## 本人の振り返り\n${input.retrospectionAnswer}` : '',
    ]
      .filter((s) => s !== '')
      .join('\n\n'),
  }
}
