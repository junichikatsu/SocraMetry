/**
 * ビルド時に esbuild の define で埋め込まれる（build.mjs）。
 * tsx でのローカル起動時は定義されないため、参照側で typeof ガードすること。
 */
declare const __BUILD_INFO__: {
  readonly version: string
  readonly commit: string
  readonly builtAt: string
}
