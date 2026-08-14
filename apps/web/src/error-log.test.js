// @ts-check
import { describe, expect, it } from 'vitest'
import { classifyLine, segments, summarize, toLines } from './error-log.js'

const kinds = (text) => toLines(text).map((l) => l.kind)

describe('行の分類', () => {
  it('空行を除いた最初の行が例外名と本文', () => {
    expect(kinds('\n\nTypeError: x is undefined\n    at foo (a.ts:1:1)')).toEqual([
      'plain',
      'plain',
      'message',
      'frame',
    ])
  })

  it('言語ごとのスタックトレースを拾う', () => {
    const cases = [
      ['    at ProductList (ProductList.tsx:24:18)', 'JavaScript'],
      ['    at pool.acquireConnection() line 42', 'モックの例'],
      ['    at /app/index.js:5:1', '括弧なし'],
      ['at com.example.Foo.bar(Foo.java:42)', 'Java'],
      ['  File "app.py", line 42, in handler', 'Python'],
      ['\tfrom app/models/user.rb:12:in `find`', 'Ruby'],
      ['#0 /var/www/index.php(12): handler()', 'PHP'],
      ['\t/app/main.go:88 +0x1f', 'Go'],
      ['    ... 12 more', 'Java の省略'],
    ]
    for (const [line, label] of cases) {
      expect(classifyLine(line, false), label).toBe('frame')
    }
  })

  it('例外の連鎖は区切りとして扱う', () => {
    expect(classifyLine('Caused by: java.sql.SQLException: timeout', false)).toBe('cause')
    expect(classifyLine('During handling of the above exception, another occurred:', false)).toBe(
      'cause',
    )
  })

  /**
   * 拾えなくても普通の行として出るだけ。**誤検出しないことを優先する。**
   * 散文をスタックトレース扱いにすると、色が意味を持たなくなる。
   */
  it('ふつうの文をスタックトレース扱いしない', () => {
    for (const line of [
      'データベースに接続できません',
      'at the same time, the pool was exhausted',
      'attempt 3 failed',
    ]) {
      expect(classifyLine(line, false), line).toBe('plain')
    }
  })

  it('CRLF が混ざっても行がずれない', () => {
    expect(kinds('TypeError: x\r\n    at foo (a.ts:1:1)\r\n')).toEqual(['message', 'frame', 'plain'])
  })
})

describe('マスキング箇所の切り出し', () => {
  it('伏せた箇所だけを分ける', () => {
    expect(segments('key=[REDACTED_KEY] at <path>/a.ts')).toEqual([
      { text: 'key=', redacted: false },
      { text: '[REDACTED_KEY]', redacted: true },
      { text: ' at ', redacted: false },
      { text: '<path>/', redacted: true },
      { text: 'a.ts', redacted: false },
    ])
  })

  it('伏せた箇所が無ければ 1 つにまとめる', () => {
    expect(segments('普通の行')).toEqual([{ text: '普通の行', redacted: false }])
  })

  it('空行でも落ちない', () => {
    expect(segments('')).toEqual([{ text: '', redacted: false }])
  })

  /** `matchAll` は正規表現の状態を持つ。2 回呼んで結果が変わらないこと */
  it('繰り返し呼んでも結果が変わらない', () => {
    const line = '[REDACTED_EMAIL] と [REDACTED_JWT]'
    expect(segments(line)).toEqual(segments(line))
    expect(segments(line).filter((s) => s.redacted)).toHaveLength(2)
  })
})

describe('要約', () => {
  /** 「3 行しか見えていないが実際は 40 行ある」が伝わらないと、開く判断ができない */
  it('全体の行数とスタックトレースの行数を出す', () => {
    expect(summarize('TypeError: x\n  at a (a.ts:1:1)\n  at b (b.ts:2:2)')).toBe(
      '3 行 / スタックトレース 2 行',
    )
  })

  it('スタックトレースが無ければ行数だけ', () => {
    expect(summarize('接続できません')).toBe('1 行')
  })
})
