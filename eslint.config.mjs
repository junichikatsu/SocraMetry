// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.turbo/**',
      '**/coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // ビルドスクリプトなど、素の ESM で書く Node スクリプト
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    // ADR-005 / packages/README: 答え（session_secrets）に触れてよいのは
    // packages/datastore の secret-repo と services/ 層だけ。
    // routes/ からの直接参照は構造として禁止する。
    files: ['apps/function/src/routes/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/secret-repo', '**/secret-repo.js'],
              message:
                'routes から session_secrets に直接触らないこと（ADR-005）。services 層を経由する。',
            },
          ],
        },
      ],
    },
  },
)
