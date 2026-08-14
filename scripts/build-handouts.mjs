// docs/handouts/*.html をブース配布用の PDF に変換する。
// 縦向き(<name>.pdf)と横向き(<name>-landscape.pdf)の両方を生成する。
//
//   node scripts/build-handouts.mjs
//
// 依存パッケージは追加しない方針(security.md §7)のため、
// インストール済みの Edge / Chrome のヘッドレス印刷機能を使う。
// 使うブラウザを指定したい場合は環境変数 BROWSER_PATH で上書きできる。

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
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
const sources = readdirSync(handoutsDir).filter(
  (f) => f.endsWith('.html') && !f.endsWith('.tmp.html'),
)

if (sources.length === 0) {
  console.error(`${handoutsDir} に .html がありません`)
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 通常プロファイルを共有すると起動中の Edge に処理が委譲されて
// file:// の解決に失敗することがあるため、専用プロファイルで起動する
const profileDir = path.join(handoutsDir, '.headless-profile.tmp')

// Edge のランチャープロセスは即座に終了し、PDF の書き込みは別プロセスが
// 非同期に行う。そのためプロセスの終了ではなく「出力ファイルが現れて
// サイズが安定する」ことで完了を判定する。
async function printToPdf(srcPath, outPath) {
  rmSync(outPath, { force: true }) // 前回の出力を完了と誤認しないよう先に消す
  execFileSync(browser, [
    '--headless=new',
    '--disable-gpu',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-pdf-header-footer',      // 新しめの Chromium 向け
    '--print-to-pdf-no-header',    // 古い Chromium 向け(未知のフラグは無視される)
    `--print-to-pdf=${outPath}`,
    pathToFileURL(srcPath).href,
  ], { stdio: 'pipe' })

  const timeoutMs = 30_000
  const start = Date.now()
  let lastSize = -1
  while (true) {
    await sleep(300)
    const size = existsSync(outPath) ? statSync(outPath).size : -1
    if (size > 0 && size === lastSize) break // 2 回連続で同サイズなら書き込み完了
    lastSize = size
    if (Date.now() - start > timeoutMs) {
      throw new Error(`${path.basename(outPath)}: ${timeoutMs / 1000} 秒待っても生成が完了しません`)
    }
  }
  console.log(`✔ ${path.relative(repoRoot, outPath)}`)
}

// 横向きは原稿を複製せず、@page を上書きした一時ファイルから生成する
// (原稿が二重管理になると縦横で内容がずれるため)。
// 一時ファイルは docs/handouts 内に置く。OS の一時ディレクトリは
// Windows の 8.3 短縮パス(C:\Users\XXXXX~1\...)になることがあり、
// Edge が file:// URL を解決できない。
try {
  for (const src of sources) {
    const srcPath = path.join(handoutsDir, src)

    // 縦向き
    await printToPdf(srcPath, path.join(handoutsDir, src.replace(/\.html$/, '.pdf')))

    // 横向き
    const html = readFileSync(srcPath, 'utf8')
    if (!html.includes('</head>')) throw new Error(`${src}: </head> が見つかりません`)
    const landscapeHtml = html.replace(
      '</head>',
      '<style>@page { size: A4 landscape; }</style></head>',
    )
    const tmpPath = path.join(handoutsDir, src.replace(/\.html$/, '.landscape.tmp.html'))
    writeFileSync(tmpPath, landscapeHtml)
    try {
      await printToPdf(tmpPath, path.join(handoutsDir, src.replace(/\.html$/, '-landscape.pdf')))
    } finally {
      rmSync(tmpPath, { force: true })
    }
  }
} finally {
  // 直前の Edge がプロファイルを掴んでいることがあるため、失敗しても続行する
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch {
    console.warn(`△ ${path.relative(repoRoot, profileDir)} を削除できませんでした(次回実行時に再利用されます)`)
  }
}
