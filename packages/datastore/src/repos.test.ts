import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DataStoreError, setDataStoreClient, type DataStoreClient } from './client'
import { ownerIdOf, type OwnerId } from './owner'
import * as reportRepo from './report-repo'
import * as secretRepo from './secret-repo'
import * as sessionRepo from './session-repo'
import { tableId } from './tables'
import type { SessionItem } from './types'

/**
 * リポジトリ層のテスト。
 * SDK は実行環境が注入する認証情報を要求するため、記録用の代替に差し替える。
 */

type Call = { op: string; args: Record<string, unknown> }

function recordingClient(items: Record<string, unknown> = {}): {
  client: DataStoreClient
  calls: Call[]
} {
  const calls: Call[] = []
  const store = new Map<string, unknown>(Object.entries(items))

  const client: DataStoreClient = {
    getItem: async (args) => {
      calls.push({ op: 'getItem', args })
      return { result: 'success', params: { Item: store.get(JSON.stringify(args.key)) } }
    },
    putItem: async (args) => {
      calls.push({ op: 'putItem', args })
      return { result: 'success', params: { Item: args.item } }
    },
    query: async (args) => {
      calls.push({ op: 'query', args })
      return { result: 'success', params: { Items: [], LastEvaluatedKey: null } }
    },
    deleteItem: async (args) => {
      calls.push({ op: 'deleteItem', args })
      return { result: 'success', params: { Item: null } }
    },
  }
  return { client, calls }
}

const owner = ownerIdOf({ userId: 'usr_9d0e11', email: 'a@b.co', displayName: '佐藤' })

beforeEach(() => {
  process.env['DS_TABLE_SESSIONS'] = 'tbl-sessions'
  process.env['DS_TABLE_SECRETS'] = 'tbl-secrets'
  process.env['DS_TABLE_REPORTS'] = 'tbl-reports'
})

afterEach(() => {
  setDataStoreClient(null)
  delete process.env['DS_TABLE_SESSIONS']
  delete process.env['DS_TABLE_SECRETS']
  delete process.env['DS_TABLE_REPORTS']
})

describe('ownerIdOf（ADR-010）', () => {
  it('認証済みコンテキストから組み立てる。v0.1 は userId がそのまま ownerId', () => {
    expect(owner).toBe('usr_9d0e11')
  })
})

describe('tableId', () => {
  it('環境変数から解決する', () => {
    expect(tableId('sessions')).toBe('tbl-sessions')
  })

  it('未設定はリクエスト単位のエラーにする（起動は止めない）', () => {
    delete process.env['DS_TABLE_SESSIONS']
    expect(() => tableId('sessions')).toThrow(DataStoreError)
  })
})

describe('session-repo', () => {
  it('メインキーに ownerId を含めて引く（他人のセッションは引けない）', async () => {
    const { client, calls } = recordingClient()
    setDataStoreClient(client)

    await sessionRepo.getSession(owner, '01J8XK4M2N0000000000000001')

    expect(calls[0]?.args['key']).toEqual({
      ownerId: 'usr_9d0e11',
      sessionId: '01J8XK4M2N0000000000000001',
    })
  })

  it('履歴一覧は降順で引く（ULID の辞書順 = 生成時刻順なので新しい順になる）', async () => {
    const { client, calls } = recordingClient()
    setDataStoreClient(client)

    await sessionRepo.listSessions(owner, { limit: 20 })

    expect(calls[0]?.args).toMatchObject({
      expression: '#ownerId = :ownerId',
      values: { ownerId: 'usr_9d0e11' },
      limit: 20,
      order: true,
    })
  })

  it('見つからない場合は null（エラーにしない）', async () => {
    const { client } = recordingClient()
    setDataStoreClient(client)
    await expect(sessionRepo.getSession(owner, '01J8XK4M2N0000000000000001')).resolves.toBeNull()
  })

  it('SDK が result: fail を返したら DataStoreError にする', async () => {
    setDataStoreClient({
      getItem: async () => ({ result: 'fail', error: 'boom' }),
      putItem: async () => ({ result: 'success' }),
      query: async () => ({ result: 'success' }),
      deleteItem: async () => ({ result: 'success' }),
    })
    await expect(sessionRepo.getSession(owner, '01J8XK4M2N0000000000000001')).rejects.toThrow(
      DataStoreError,
    )
  })

  /**
   * SDK は**プロキシ Lambda の呼び出しに失敗すると例外を投げる**。
   * これを取りこぼすと `503 DATASTORE_UNAVAILABLE` ではなく素の 500 になり、
   * 「画面が止まらず原因が表示される」（FR-17）が成立しない。
   */
  it('SDK が例外を投げても DataStoreError に揃える', async () => {
    const boom = async () => {
      throw new Error('CredentialsProviderError')
    }
    setDataStoreClient({ getItem: boom, putItem: boom, query: boom, deleteItem: boom })

    await expect(sessionRepo.getSession(owner, '01J8XK4M2N0000000000000001')).rejects.toThrow(
      DataStoreError,
    )
    await expect(reportRepo.listReports(owner)).rejects.toThrow(DataStoreError)
    await expect(secretRepo.getDiagnosis('01J8XK4M2N0000000000000001')).rejects.toThrow(
      DataStoreError,
    )
  })

  it('例外の中身をメッセージに載せない（アイテムが混じりうるため）', async () => {
    setDataStoreClient({
      getItem: async () => {
        throw new Error('failed to put item: {"errorText":"ProductList.tsx で落ちた"}')
      },
      putItem: async () => ({ result: 'success' }),
      query: async () => ({ result: 'success' }),
      deleteItem: async () => ({ result: 'success' }),
    })

    await expect(
      sessionRepo.getSession(owner, '01J8XK4M2N0000000000000001'),
    ).rejects.toThrow(/^datastore sessions\.getItem failed$/)
  })
})

describe('secret-repo（ADR-005 ★非公開）', () => {
  it('診断と正解をサブキー kind で分けて保存する', async () => {
    const { client, calls } = recordingClient()
    setDataStoreClient(client)

    await secretRepo.getDiagnosis('01J8XK4M2N0000000000000001')
    await secretRepo.getAnswerKeys('01J8XK4M2N0000000000000001')

    expect(calls[0]?.args['key']).toEqual({
      sessionId: '01J8XK4M2N0000000000000001',
      kind: 'diagnosis',
    })
    expect(calls[1]?.args['key']).toEqual({
      sessionId: '01J8XK4M2N0000000000000001',
      kind: 'answerkeys',
    })
  })

  it('答えは sessions と別テーブルに保存される（テーブル分離が唯一の隔離手段）', async () => {
    const { client, calls } = recordingClient()
    setDataStoreClient(client)

    await secretRepo.putDiagnosis({
      sessionId: '01J8XK4M2N0000000000000001',
      kind: 'diagnosis',
      rootCause: '答え',
      confidence: 0.8,
      evidence: [],
      focusHints: [],
      distractorThemes: [],
      difficulty: 'medium',
      hints: [],
      modelUsed: 'mock',
      createdAt: 0,
    })

    expect(calls[0]?.args['tableId']).toBe('tbl-secrets')
    expect(calls[0]?.args['tableId']).not.toBe('tbl-sessions')
  })

  it('削除は 3 種類すべてを消す（CASCADE がない）', async () => {
    const { client, calls } = recordingClient()
    setDataStoreClient(client)

    await secretRepo.deleteSecrets('01J8XK4M2N0000000000000001')

    expect(calls.map((c) => (c.args['key'] as { kind: string }).kind)).toEqual([
      'diagnosis',
      'answerkeys',
      'reveal',
    ])
  })
})

describe('report-repo', () => {
  it('sessions と同じキー構成なので 1 クエリで集計できる（A4）', async () => {
    const { client, calls } = recordingClient()
    setDataStoreClient(client)

    await reportRepo.listReports(owner)

    expect(calls[0]?.args).toMatchObject({
      tableId: 'tbl-reports',
      expression: '#ownerId = :ownerId',
      limit: 100,
    })
  })
})

describe('保存はアイテム全体を書く（getItem がアイテム全体を返すため）', () => {
  it('putSession は渡したアイテムをそのまま書く', async () => {
    const { client, calls } = recordingClient()
    setDataStoreClient(client)

    const session = { ownerId: owner, sessionId: '01J8XK4M2N0000000000000001' } as SessionItem
    await sessionRepo.putSession(session)

    expect(calls[0]?.args['item']).toBe(session)
  })
})

describe('OwnerId のブランド型', () => {
  it('生の文字列は渡せない（型レベルの担保なので実行時ではなくコンパイル時に効く）', () => {
    // @ts-expect-error 文字列連結で作ったキーは渡せない
    const invalid: OwnerId = 'usr_9d0e11'
    expect(invalid).toBe('usr_9d0e11')
  })
})
