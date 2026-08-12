/**
 * ビルド時に esbuild の define で埋め込まれる（build.mjs）。
 * tsx でのローカル起動時は定義されないため、参照側で typeof ガードすること。
 */
declare const __BUILD_INFO__: {
  readonly version: string
  readonly commit: string
  readonly builtAt: string
}

/**
 * `apps/web/public/` の中身（ADR-012）。
 * ローカル起動時は定義されず、`local.ts` がディスクから読んで差し込む。
 */
declare const __STATIC_ASSETS__: {
  readonly 'index.html': string
  readonly 'styles.css': string
  readonly 'app.js': string
}
