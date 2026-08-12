import { getDataStoreClient, run, runGet } from './client'
import { tableId } from './tables'
import type { AnswerKeysSecret, DiagnosisSecret, RevealSecret, SecretKind } from './types'

/**
 * `session_secrets` テーブル ★非公開（data-model.md §3.2 / ADR-005）。
 *
 * **このテーブルの内容は公開 API のレスポンスに一切含めない。**
 * `apps/function/src/routes/` からの直接参照は禁止し、`services/` 経由のみとする
 * （packages/README.md / eslint.config.mjs の no-restricted-imports）。
 *
 * メインキーが `sessionId` で `ownerId` を含まないのは、
 * サブキー（`kind`）で診断・正解・開示文を出し分けるため。
 * **所有者の検証は `sessions` の読み出しで先に済ませる**こと。
 * このリポジトリを `sessions` の確認なしに呼んではならない。
 */

async function getSecret<T>(sessionId: string, kind: SecretKind): Promise<T | null> {
  const params = await runGet(`secrets.getItem:${kind}`, () =>
    getDataStoreClient().getItem({ tableId: tableId('secrets'), key: { sessionId, kind } }),
  )
  return (params?.Item as T | undefined) ?? null
}

async function putSecret(item: { sessionId: string; kind: SecretKind }): Promise<void> {
  await run(`secrets.putItem:${item.kind}`, () =>
    getDataStoreClient().putItem({ tableId: tableId('secrets'), item }),
  )
}

/** 到達判定（Judge）と Gate C の開示でのみ読む */
export function getDiagnosis(sessionId: string): Promise<DiagnosisSecret | null> {
  return getSecret<DiagnosisSecret>(sessionId, 'diagnosis')
}

export function putDiagnosis(item: DiagnosisSecret): Promise<void> {
  return putSecret(item)
}

/** 回答の正誤判定でのみ読む。LLM を使わずここで判定する（socratic-engine.md §4.1） */
export function getAnswerKeys(sessionId: string): Promise<AnswerKeysSecret | null> {
  return getSecret<AnswerKeysSecret>(sessionId, 'answerkeys')
}

export function putAnswerKeys(item: AnswerKeysSecret): Promise<void> {
  return putSecret(item)
}

/** 生成済みの開示文。再要求で同じ内容を返すため（冪等 / api-spec.md §4） */
export function getReveal(sessionId: string): Promise<RevealSecret | null> {
  return getSecret<RevealSecret>(sessionId, 'reveal')
}

export function putReveal(item: RevealSecret): Promise<void> {
  return putSecret(item)
}

/**
 * セッション削除時の後始末（data-model.md §7）。
 * **CASCADE がないため関連アイテムを明示的に削除する。**
 */
export async function deleteSecrets(sessionId: string): Promise<void> {
  const table = tableId('secrets')
  for (const kind of ['diagnosis', 'answerkeys', 'reveal'] as const) {
    await run(`secrets.deleteItem:${kind}`, () =>
      getDataStoreClient().deleteItem({ tableId: table, key: { sessionId, kind } }),
    )
  }
}
