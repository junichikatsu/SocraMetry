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

/** 投げられた `DataStoreError` を型のまま取り出す */
async function captureError(promise: Promise<unknown>): Promise<DataStoreError> {
  try {
    await promise
  } catch (cause) {
    return cause as DataStoreError
  }
  throw new Error('例外が投げられませんでした')
}

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

  /**
   * 「保存先に接続できません」だけでは、設定漏れ・接続不可・データストア側の
   * エラーのどれなのかが切り分けられない（FR-17）。
   * 公開してよい識別子だけを載せる。
   */
  it('公開用の detail は値を含まず、失敗の種別が分かる', async () => {
    setDataStoreClient({
      getItem: async () => {
        const e = new Error('Could not load credentials from any providers')
        e.name = 'CredentialsProviderError'
        throw e
      },
      putItem: async () => ({ result: 'success' }),
      query: async () => ({ result: 'success' }),
      deleteItem: async () => ({ result: 'success' }),
    })

    const error = await captureError(sessionRepo.getSession(owner, '01J8XK4M2N0000000000000001'))

    expect(error.toPublicDetail()).toEqual({
      operation: 'sessions.getItem',
      kind: 'threw',
      errorName: 'CredentialsProviderError',
    })
    // 生のメッセージは公開用に含まれない
    expect(JSON.stringify(error.toPublicDetail())).not.toContain('credentials from any')
  })

  it('データストア側のエラーメッセージは公開用に含めない（キーの値が乗りうる）', async () => {
    setDataStoreClient({
      getItem: async () => ({ result: 'fail', error: 'no item for sato@example.com' }),
      putItem: async () => ({ result: 'success' }),
      query: async () => ({ result: 'success' }),
      deleteItem: async () => ({ result: 'success' }),
    })

    const error = await captureError(sessionRepo.getSession(owner, '01J8XK4M2N0000000000000001'))

    expect(error.toPublicDetail()).toEqual({ operation: 'sessions.getItem', kind: 'failed' })
    expect(JSON.stringify(error.toPublicDetail())).not.toContain('sato@example.com')
  })

  /**
   * SDK は `throw result.error` でデータストア側のエラーを**文字列のまま**投げる。
   * `Error` しか見ていないと原因の記述を丸ごと失う（実際にそれで詰まった）。
   */
  /**
   * データストアは `getItem` でアイテムが無いとき `"Not found"` を返す。
   * **本製品では「無い」は正常系**（初回サインアップ時のアカウント確認など）であり、
   * これを 503 にするとサインアップが原理的に成立しない。
   */
  it('アイテムが無いときの "Not found" は null にする', async () => {
    const notFound = async () => {
      throw 'Not found'
    }
    setDataStoreClient({
      getItem: notFound,
      putItem: notFound,
      query: notFound,
      deleteItem: notFound,
    })

    await expect(sessionRepo.getSession(owner, '01J8XK4M2N0000000000000001')).resolves.toBeNull()
    await expect(secretRepo.getDiagnosis('01J8XK4M2N0000000000000001')).resolves.toBeNull()
    await expect(reportRepo.getReport(owner, '01J8XK4M2N0000000000000001')).resolves.toBeNull()
  })

  it('書き込みとクエリの "Not found" は隠さない（設定ミスが埋もれるため）', async () => {
    const notFound = async () => {
      throw 'Not found'
    }
    setDataStoreClient({
      getItem: notFound,
      putItem: notFound,
      query: notFound,
      deleteItem: notFound,
    })

    await expect(sessionRepo.putSession({} as SessionItem)).rejects.toThrow(DataStoreError)
    await expect(reportRepo.listReports(owner)).rejects.toThrow(DataStoreError)
  })

  it('文字列が投げられてもデータストア側のエラーとして扱い、本文を保持する', async () => {
    const boom = async () => {
      throw 'ValidationException: key schema mismatch'
    }
    setDataStoreClient({ getItem: boom, putItem: boom, query: boom, deleteItem: boom })

    const error = await captureError(sessionRepo.getSession(owner, '01J8XK4M2N0000000000000001'))

    // 接続失敗（threw）ではなく、操作が返したエラー（failed）に分類する
    expect(error.kind).toBe('failed')
    expect(error.rawMessage).toContain('key schema mismatch')
    // 公開用には含めない（出すかどうかは apps/function 側が LOG_LEVEL で判断する）
    expect(error.toPublicDetail()['message']).toBeUndefined()
  })

  /**
   * **既知のトレードオフ。** プロキシはエラーを文字列でしか返さないため、
   * 「アイテムが無い」と「テーブルが無い」を読み出しでは区別できない。
   * 前者を通さないとサインアップが成立しないので、読みは空として扱う。
   *
   * **設定ミスは書き込みで必ず表面化する**ため、埋もれることはない
   * （読みは空 → 続く putItem が 503 になる）。この関係が崩れると
   * 「動いているように見えて何も保存されない」状態になりうるので、
   * 挙動をテストで固定しておく。
   */
  it('テーブル不在も読みでは空になるが、書きで必ず失敗する', async () => {
    const tableMissing = async () => {
      throw 'Requested resource not found: Table not found'
    }
    setDataStoreClient({
      getItem: tableMissing,
      putItem: tableMissing,
      query: tableMissing,
      deleteItem: tableMissing,
    })

    await expect(sessionRepo.getSession(owner, '01J8XK4M2N0000000000000001')).resolves.toBeNull()
    await expect(sessionRepo.putSession({} as SessionItem)).rejects.toThrow(DataStoreError)
  })

  it('テーブル ID が未設定なら、どのキーが足りないかを返す（値ではないので出してよい）', async () => {
    delete process.env['DS_TABLE_SESSIONS']

    const error = await captureError(
      Promise.resolve().then(() => tableId('sessions')),
    )

    expect(error.toPublicDetail()).toEqual({
      operation: 'resolve-table:sessions',
      kind: 'unset',
      errorName: 'DS_TABLE_SESSIONS',
    })
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
