#!/usr/bin/env node
/**
 * デプロイ環境のコストを集計する（F11 / cost-model.md §5）。
 *
 * ## 何のためにあるか
 *
 * cost-model.md §5 の金額は、**トークン数の実測に単価表を掛けた推定値**である。
 * 単価表（`packages/llm/src/pricing.ts`）は OrcaRouter の実際の課金と
 * 突き合わせたことがなく、レビューで **クレジット消費が推定のおよそ半分**
 * との指摘を受けた。
 *
 * このスクリプトは `ops_logs` の USD 合計を出し、**OrcaRouter の Usage 差分と
 * 突き合わせる**ための土台にする。手作業の集計を置き換える目的もある。
 *
 * ## MOCK の扱い
 *
 * `ops_logs` は MOCK の呼び出しを記録しない（`cost-log.ts`）。
 * そのため MOCK だけのセッションは呼び出し 0 件として現れる。これを
 * 「実 LLM を使ったセッション」から除く。**混ぜると 1 セッションあたりの
 * 平均が実際より安く見え、請求と合わない原因になる。**
 *
 * ## 使い方
 *
 * ```
 * node scripts/cost-report.mjs <email> <password>
 * BASE_URL=https://... node scripts/cost-report.mjs <email> <password>
 * ```
 *
 * 集計対象は**ログイン中ユーザーのセッションだけ**。計測は 1 アカウントに
 * 統一すること。
 */

const BASE = process.env['BASE_URL'] ?? 'https://lcdp003.enebular.com/socrametry'
const [email, password] = process.argv.slice(2)

if (!email || !password) {
  console.error('使い方: node scripts/cost-report.mjs <email> <password>')
  console.error('        BASE_URL で接続先を変えられます')
  process.exit(1)
}

let cookie = ''

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  // Cookie は削除用と発行用が同時に返る。削除でない方を採る
  const issued = res.headers.getSetCookie().find((line) => !line.includes('Max-Age=0'))
  if (issued) cookie = issued.split(';')[0]

  const text = await res.text()
  let data = null
  try {
    data = text === '' ? null : JSON.parse(text)
  } catch {
    data = { _raw: text.slice(0, 300) }
  }
  return { status: res.status, data }
}

const log = (...args) => console.log(...args)
const section = (title) => console.log(`\n──── ${title} ────`)

// ── ログインと環境の確認 ──
const login = await api('POST', '/v1/auth/login', { email, password })
if (login.status !== 200) {
  console.error(`ログイン失敗: ${login.status} ${JSON.stringify(login.data)}`)
  process.exit(1)
}

const health = await api('GET', '/v1/health')
const rate = health.data?.limits?.usdJpyRate ?? null
const jpy = (usd) => (rate === null ? '' : `（約 ${(usd * rate).toFixed(2)} 円）`)
log(`接続先: ${BASE}`)
log(`為替レート: 1 USD = ${rate ?? '不明（デプロイが古い）'} 円 / mockMode=${health.data?.mockMode}`)

// ── セッション一覧（新しい順・ページング）──
const sessions = []
let startKey = null
for (;;) {
  const query = `limit=50${startKey ? `&startKey=${encodeURIComponent(startKey)}` : ''}`
  const page = await api('GET', `/v1/me/sessions?${query}`)
  if (page.status !== 200) {
    log(`セッション一覧の取得に失敗: ${page.status}`)
    break
  }
  sessions.push(...(page.data.sessions ?? []))
  startKey = page.data.nextStartKey ?? null
  if (!startKey) break
}

section(`セッション ${sessions.length} 件`)

const totals = { usd: 0, prompt: 0, completion: 0, calls: 0, unknownPrice: 0, errors: 0 }
const byRole = new Map()
const byModel = new Map()
let mockOnly = 0
let realSessions = 0

for (const s of sessions) {
  const res = await api('GET', `/v1/sessions/${s.id}/cost`)
  if (res.status !== 200) {
    log(`  ${s.id}: 取得できず (${res.status})`)
    continue
  }
  const calls = res.data.calls ?? []
  if (calls.length === 0) {
    mockOnly += 1
    continue
  }
  realSessions += 1

  const sum = res.data.summary ?? {}
  totals.usd += sum.costUsd ?? 0
  totals.prompt += sum.promptTokens ?? 0
  totals.completion += sum.completionTokens ?? 0
  totals.calls += calls.length
  totals.unknownPrice += sum.unknownPrice ?? 0
  totals.errors += sum.errors ?? 0

  for (const call of calls) {
    const role = byRole.get(call.role) ?? { usd: 0, calls: 0 }
    role.usd += call.estimatedCostUsd ?? 0
    role.calls += 1
    byRole.set(call.role, role)

    const key = call.model ?? '(不明)'
    const model = byModel.get(key) ?? { usd: 0, calls: 0, unpriced: 0 }
    model.usd += call.estimatedCostUsd ?? 0
    model.calls += 1
    if (call.estimatedCostUsd === null) model.unpriced += 1
    byModel.set(key, model)
  }

  log(
    `  ${s.id}  Gate ${s.reachedGate ?? '-'}  ${String(calls.length).padStart(2)} 回  ` +
      `${(sum.costUsd ?? 0).toFixed(5)} USD`,
  )
}

section('★ 合計')
log(`実 LLM を使ったセッション : ${realSessions} 件`)
log(`MOCK のみのセッション     : ${mockOnly} 件（除外）`)
log(`LLM 呼び出し              : ${totals.calls} 回（うち失敗 ${totals.errors} 回）`)
log(`入力 / 出力トークン       : ${totals.prompt} / ${totals.completion}`)
log(`推定コスト合計            : ${totals.usd.toFixed(5)} USD${jpy(totals.usd)}`)
if (realSessions > 0) {
  const per = totals.usd / realSessions
  log(`1 セッションあたり        : ${per.toFixed(5)} USD${jpy(per)}`)
}
if (totals.unknownPrice > 0) {
  log(`\n⚠ 単価表に無いモデルの呼び出し: ${totals.unknownPrice} 回（合計に含まれていない）`)
}

if (byRole.size > 0) {
  section('役割別')
  for (const [role, v] of [...byRole].sort((a, b) => b[1].usd - a[1].usd)) {
    const share = totals.usd > 0 ? ((v.usd / totals.usd) * 100).toFixed(1) : '0.0'
    log(`  ${role.padEnd(12)} ${String(v.calls).padStart(3)} 回  ${v.usd.toFixed(5)} USD  (${share}%)`)
  }

  section('モデル別')
  for (const [model, v] of [...byModel].sort((a, b) => b[1].usd - a[1].usd)) {
    const warn = v.unpriced > 0 ? `  ⚠ 単価不明 ${v.unpriced} 回` : ''
    log(`  ${model.padEnd(34)} ${String(v.calls).padStart(3)} 回  ${v.usd.toFixed(5)} USD${warn}`)
  }
}

section('OrcaRouter の請求との突き合わせ')
log('上の「推定コスト合計」を OrcaRouter の Usage 差分と比べてください。')
log('')
log('  ほぼ一致    → 単価表は妥当。cost-model の金額を「実測」と呼べる')
log('  推定 > 請求 → 単価表が高すぎる（割引・別レートの可能性）')
log('  推定 < 請求 → 単価表が安すぎる、または集計から漏れた呼び出しがある')
log('')
log('★ 集計対象はログイン中ユーザーのセッションだけです。計測は 1 アカウントに統一してください。')
