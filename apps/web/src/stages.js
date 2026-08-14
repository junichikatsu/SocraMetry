// @ts-check
/** 段階と 5 軸の対応（socratic-engine.md §3 / evaluation-model.md §2.1） */
export const STAGES = [
  { key: 'observe', name: '観察', ability: 'エラーを正確に読めるか' },
  { key: 'localize', name: '切り分け', ability: '問題箇所を絞れるか' },
  { key: 'hypothesize', name: '仮説', ability: '原因を推論できるか' },
  { key: 'verify', name: '検証', ability: '仮説を確かめられるか' },
  { key: 'fix', name: '修正', ability: '再発しない直し方を選べるか' },
]

export const stageName = (key) => STAGES.find((s) => s.key === key)?.name ?? key

export const GATE_LABEL = {
  A: 'Gate A — ヒントだけで自力到達',
  B: 'Gate B — 設問の誘導で到達',
  C: 'Gate C — 解説で理解',
}

export const LANGUAGES = [
  'typescript', 'javascript', 'python', 'java', 'go', 'ruby', 'php',
  'csharp', 'rust', 'kotlin', 'swift', 'sql', 'shell', 'other',
]

export const FRAMEWORKS = [
  'nextjs', 'react', 'vue', 'nuxt', 'node', 'express', 'hono', 'nestjs',
  'django', 'flask', 'fastapi', 'rails', 'spring', 'laravel', 'dotnet', 'none', 'other',
]
