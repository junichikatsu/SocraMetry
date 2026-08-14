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
      // esbuild の生成物。lint は入力側（apps/web/src）に当てる
      'apps/web/public/app.js',
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
    // 運用スクリプト。Node 18+ の実行前提で、fetch などの標準グローバルを使う
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    // フロントエンド（ADR-013 改訂: フレームワークなし・バンドルのみ）。
    // ブラウザで実行されるため、Node ではなくブラウザのグローバルを持つ。
    files: ['apps/web/src/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        clearTimeout: 'readonly',
        console: 'readonly',
        document: 'readonly',
        Event: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        localStorage: 'readonly',
        location: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
        window: 'readonly',
      },
    },
    rules: {
      // 自動エスケープがない構成なので、innerHTML の混入を lint で止める
      // （security.md §7 / LLM の出力とユーザー入力を DOM に入れる箇所がある）
      'no-restricted-properties': [
        'error',
        {
          property: 'innerHTML',
          message: 'innerHTML は使わないこと。textContent を使う（security.md §7）。',
        },
        {
          property: 'outerHTML',
          message: 'outerHTML は使わないこと。textContent を使う（security.md §7）。',
        },
      ],
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
