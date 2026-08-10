import { z } from 'zod'

/**
 * 入力バリデーションの共通部品（security.md §2.2 / F05）。
 *
 * **サーバ側で必ず検証する。** フロントの検証は UX のためのものであり防御ではない。
 * FE と BE が同じスキーマを参照するため、検証内容がずれない（api-spec.md §7）。
 */

/**
 * 言語 / フレームワークは**事前定義リストの値のみ**受け付ける。
 * 自由文字列を許すと、そのままプロンプトに入る値の集合が無限になり、
 * プロンプトインジェクションの入口が 1 つ増える。
 */
export const LANGUAGES = [
  'typescript',
  'javascript',
  'python',
  'java',
  'go',
  'ruby',
  'php',
  'csharp',
  'rust',
  'kotlin',
  'swift',
  'sql',
  'shell',
  'other',
] as const

export const FRAMEWORKS = [
  'nextjs',
  'react',
  'vue',
  'nuxt',
  'node',
  'express',
  'hono',
  'nestjs',
  'django',
  'flask',
  'fastapi',
  'rails',
  'spring',
  'laravel',
  'dotnet',
  'none',
  'other',
] as const

export type Language = (typeof LANGUAGES)[number]
export type Framework = (typeof FRAMEWORKS)[number]

export const languageSchema = z.enum(LANGUAGES)
export const frameworkSchema = z.enum(FRAMEWORKS)

/** ULID は Crockford Base32 の 26 文字。I / L / O / U を含まない */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

export const ulidSchema = z.string().regex(ULID_PATTERN, 'ULID 形式ではありません')

/** `<sessionId>#<seq>`。回答の冪等キー（api-spec.md §4） */
export const questionIdSchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}#\d{1,4}$/, 'questionId の形式が不正です')

/** 選択肢 ID は a〜e の 1 文字（難易度に応じて 2〜5 択 / socratic-engine.md C7） */
export const optionIdSchema = z.enum(['a', 'b', 'c', 'd', 'e'])
