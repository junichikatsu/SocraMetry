// ============================================================================
//  ZIP ビルド（ADR-008 / deployment.md §2）
//
//  pnpm の node_modules は symlink 構造のため、そのまま ZIP に入れると
//  ワークスペース依存が壊れる。esbuild で単一 CommonJS にバンドルして回避する。
//
//  出力: apps/function/socrametry-function.zip
//        └ ルート直下に index.js と package.json のみ（enebular の要件 1）
// ============================================================================
import { build } from 'esbuild'
import archiver from 'archiver'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const OUT_DIR = 'build'
const ZIP_PATH = 'socrametry-function.zip'
const MAX_ZIP_BYTES = 250 * 1024 * 1024

/** ZIP に入れる package.json。"type": "module" を含まないことが要件（要件 3） */
const zipPackageJson = JSON.parse(await readFile('zip-package.json', 'utf8'))
if (zipPackageJson.type === 'module') {
  throw new Error('zip-package.json に "type": "module" があります（Lambda は CommonJS 必須）')
}

const commit = resolveCommit()

await rm(OUT_DIR, { recursive: true, force: true })
await rm(ZIP_PATH, { force: true })
await mkdir(OUT_DIR, { recursive: true })

// ── 1) 単一 CJS にバンドル（ワークスペース依存もすべて内包される）──────────
await build({
  entryPoints: ['src/index.ts'],
  outfile: `${OUT_DIR}/index.js`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs', // ★ enebular の要件（要件 2）
  minify: true,
  sourcemap: false,
  // 静的ファイルをバンドルに文字列として取り込む（ADR-012）
  loader: { '.html': 'text', '.css': 'text' },
  define: {
    __BUILD_INFO__: JSON.stringify({
      version: zipPackageJson.version,
      commit,
      builtAt: new Date().toISOString(),
    }),
  },
})

// ── 2) ZIP 用の最小 package.json をコピー ─────────────────────────────────
await cp('zip-package.json', `${OUT_DIR}/package.json`)

// ── 3) ハンドラが実際に公開されているか、ビルド成果物で検証 ────────────────
// 文字列の grep ではなく require して確認する。バンドラの出力形が変わっても壊れない。
//
// require するとエントリポイントの起動時処理が走り、環境変数の設定漏れが
// WARN として出る（config.ts）。ビルド環境に envVars が無いのは当然なので、
// ここでの警告は無意味なノイズにしかならない。この 1 回だけ抑制する。
const originalWarn = console.warn
console.warn = () => {}
let bundled
try {
  const { createRequire } = await import('node:module')
  bundled = createRequire(import.meta.url)(`./${OUT_DIR}/index.js`)
} finally {
  console.warn = originalWarn
}
if (typeof bundled.handler !== 'function') {
  throw new Error('バンドル結果に handler がありません（ハンドラ指定は index.handler）')
}

// ── 4) build/ の "中身" を ZIP のルートに詰める（親フォルダで包まない: 要件 1）─
await zipDirectory(OUT_DIR, ZIP_PATH)

const { size } = await stat(ZIP_PATH)
if (size > MAX_ZIP_BYTES) {
  throw new Error(`ZIP が 250MB を超えています: ${size} bytes`)
}

console.log(`${ZIP_PATH}  ${(size / 1024).toFixed(1)} KB  (commit: ${commit})`)

// ---------------------------------------------------------------------------

/** CI では GITHUB_SHA、ローカルでは git から取る。どちらも無ければ unknown */
function resolveCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function zipDirectory(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } })
    const stream = createWriteStream(outPath)

    archive.on('error', reject)
    stream.on('close', resolve)
    stream.on('error', reject)

    archive.pipe(stream)
    archive.directory(`${sourceDir}/`, false) // ★ false がルート直下配置の指定
    archive.finalize()
  })
}
