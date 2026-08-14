// docs/handouts/*.html をブース配布用の PDF に変換する。
//
//   node scripts/build-handouts.mjs
//
// 依存パッケージは追加しない方針(security.md §7)のため、
// インストール済みの Edge / Chrome のヘッドレス印刷機能を使う。
// 使うブラウザを指定したい場合は環境変数 BROWSER_PATH で上書きできる。

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const handoutsDir = path.join(repoRoot, 'docs', 'handouts')

/** Edge / Chrome の実行ファイルを探す。見つかった最初のものを使う */
function findBrowser() {
  const candidates = [
    process.env.BROWSER_PATH,
    // Windows
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean)

  const found = candidates.find((p) => existsSync(p))
  if (!found) {
    console.error('Edge / Chrome が見つかりません。環境変数 BROWSER_PATH で実行ファイルを指定してください。')
    process.exit(1)
  }
  return found
}

const browser = findBrowser()
const sources = readdirSync(handoutsDir).filter((f) => f.endsWith('.html'))

if (sources.length === 0) {
  console.error(`${handoutsDir} に .html がありません`)
  process.exit(1)
}

for (const src of sources) {
  const srcPath = path.join(handoutsDir, src)
  const outPath = path.join(handoutsDir, src.replace(/\.html$/, '.pdf'))
  execFileSync(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-pdf-header-footer',      // 新しめの Chromium 向け
    '--print-to-pdf-no-header',    // 古い Chromium 向け(未知のフラグは無視される)
    `--print-to-pdf=${outPath}`,
    pathToFileURL(srcPath).href,
  ], { stdio: 'pipe' })
  console.log(`✔ ${path.relative(repoRoot, outPath)}`)
}
