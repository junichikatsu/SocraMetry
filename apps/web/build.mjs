// ============================================================================
//  フロントエンドのバンドル（ADR-013 改訂）
//
//  ビルド工程を持つ理由は 1 つだけ。**マスキングのプレビュー**（security.md §3 A）
//  を出すために、サーバと同じ純関数 `@socrametry/core/masking` をブラウザに
//  届ける必要があるため。プレビューを別実装にすると、2 つの正規表現が乖離した
//  瞬間に「消えて見えるのに消えていない」表示になる。それは無いより悪い。
//
//  フレームワークは入れない。入れたのはバンドラだけ。
//
//  入力: src/main.js
//  出力: public/app.js（生成物。git 管理しない）
// ============================================================================
import { build, context } from 'esbuild'
import { copyFileSync } from 'node:fs'

// ロゴの原本は assets/ に置く（public/ は配信物。app.js と同じく git 管理しない）
copyFileSync('assets/logo.png', 'public/logo.png')

const options = {
  entryPoints: ['src/main.js'],
  outfile: 'public/app.js',
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  // ★ IIFE。module にすると index.html 側で type="module" が要る
  format: 'iife',
  // **minify しない。** 配信される JS は開発者が読める状態に保つ。
  // 同一オリジン配信（ADR-012）で cache-control: no-cache のため、
  // 数十 KB の差は体感に出ない。読めることの方が価値が大きい
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  banner: {
    js: '/* 生成物です。編集しないでください。編集先は apps/web/src/ です。 */',
  },
}

if (process.argv.includes('--watch')) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('watching apps/web/src/ …')
} else {
  await build(options)
}
