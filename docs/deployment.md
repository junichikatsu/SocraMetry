# デプロイ（enebular ZIP + GitHub Actions）

| 項目 | 内容 |
|---|---|
| ドキュメント版数 | v0.2 |
| 作成日 | 2026-08-09 |
| 更新日 | 2026-08-10 |
| 主な変更 | §3 の事前セットアップを v0.1 の実態に修正（プロジェクト 1 / テーブル 5 / キー定義を明記） |
| 参照 | [ZIP ファイルデプロイ](https://docs.enebular.com/ja/GetStarted/ZIPFileDeployment.html) / [enebular CLI](https://www.npmjs.com/package/@uhuru/enebular-cli) / [GitHub Actions 自動化](https://blog.enebular.com/function/github-actions-enebular-cli-automation/) |

---

## 1. デプロイ対象

| コンポーネント | デプロイ先 | 方法 |
|---|---|---|
| `apps/function` **+ `apps/web`** | enebular クラウド実行環境（ZIP） | GitHub Actions → `@uhuru/enebular-cli` |
| データストア | enebular データストア | コンソールで手動作成（テーブル ID を `envVars` へ） |

> **フロントエンドは ZIP に同梱される。デプロイ先は 1 つだけ**
> （[ADR-012](architecture.md#adr-012-フロントエンドを関数から同一オリジンで配信する)）。
> 別ホスティングを使わないため、バージョンずれも CORS 設定も発生しない。

### 環境

**v0.1 は development の 1 プロジェクトのみ**（F19 Won't）。

| ブランチ / イベント | デプロイ先 | 版 |
|---|---|---|
| `main` への push | development | v0.1 |
| `v*` タグの push | production | v0.2 以降 |
| 手動実行 (`workflow_dispatch`) | 選択したプロジェクト | — |

---

## 2. ZIP の作り方

### 2.1 enebular 側の要件

[公式ドキュメント](https://docs.enebular.com/ja/GetStarted/ZIPFileDeployment.html)より、
Node.js の ZIP は次を満たす必要がある。

| # | 要件 |
|---|---|
| 1 | ZIP の**ルート直下**に `index.js` と `package.json` を置く（親フォルダで包まない） |
| 2 | ハンドラは `index.handler`。`exports.handler = async (event) => {...}` の **CommonJS** 形式 |
| 3 | `package.json` に **`"type": "module"` を書かない**（ES Modules と非互換） |
| 4 | 戻り値は `{ statusCode, headers, body }`。`body` は文字列（JSON は `JSON.stringify`） |
| 5 | ZIP サイズは **250MB 以下** |
| 6 | 外部パッケージを使う場合は `node_modules` を同梱する |

### 2.2 SocraMetry での作り方

pnpm ワークスペースの `node_modules` は symlink 構造のため、
そのまま ZIP に入れると**ワークスペース依存（`@socrametry/core` 等）が壊れる**。
そこで **esbuild で単一 CommonJS ファイルにバンドル**する
（[ADR-008](architecture.md#adr-008-esbuild-で単一-commonjs-ファイルにバンドルして-zip-化する)）。

```
apps/function/
├── src/index.ts          →  esbuild  →  build/index.js   (CJS / 依存を内包)
├── zip-package.json      →  コピー   →  build/package.json
└── build.mjs                            build/  →  socrametry-function.zip

apps/web/public/
├── index.html            ┐
├── styles.css            ├→ esbuild が文字列として index.js に取り込む (ADR-012)
└── app.js                ┘
```

> **静的ファイルは別途 ZIP に入れず、バンドルに文字列として含める。**
> Lambda のファイルシステム読み込みが不要になり、
> ZIP の中身は `index.js` と `package.json` の 2 つだけで済む。

**`apps/function/build.mjs`**（実装は [apps/function/build.mjs](../apps/function/build.mjs)。以下は骨子）

```js
// loader オプションで .html / .css / .js を文字列として取り込む（ADR-012）
//   loader: { '.html': 'text', '.css': 'text' }
import { build } from 'esbuild'
import { cp, rm, mkdir } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import archiver from 'archiver'

const OUT = 'build'
await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

// 1) 単一 CJS にバンドル（ワークスペース依存もすべて内包される）
await build({
  entryPoints: ['src/index.ts'],
  outfile: `${OUT}/index.js`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',          // ★ enebular の要件（要件 2）
  minify: true,
  sourcemap: false,
})

// 2) ZIP 用の最小 package.json（"type": "module" を含まないもの）
await cp('zip-package.json', `${OUT}/package.json`)

// 3) build/ の "中身" を ZIP のルートに詰める（親フォルダで包まない: 要件 1）
const zip = archiver('zip', { zlib: { level: 9 } })
zip.pipe(createWriteStream('socrametry-function.zip'))
zip.directory(`${OUT}/`, false)   // ★ false がルート直下配置の指定
await zip.finalize()
```

**`apps/function/zip-package.json`**

```json
{
  "name": "socrametry-function",
  "version": "0.1.0",
  "description": "SocraMetry backend on enebular cloud execution environment",
  "main": "index.js"
}
```

> `"type": "module"` を**書かない**こと。ビルドスクリプトがこのファイルをコピーするだけの
> 運用にしておけば、`apps/function/package.json`（こちらは `"type": "module"`）の
> 設定に引きずられて壊れることがない。`build.mjs` は起動時にこのファイルを読み、
> `type: "module"` が入っていたらビルドを失敗させる。

**`apps/function/src/index.ts`**

```ts
import { handle } from 'hono/aws-lambda'
import { app } from './app'

// enebular のハンドラ指定は index.handler
export const handler = handle(app)
```

### 2.3 ローカル確認

デプロイ前に、同じ `app` を Lambda なしで起動して動作確認する（NFR-Q3）。

```bash
pnpm --filter @socrametry/function dev     # apps/function/src/local.ts を起動
```

ZIP の中身の検証も CI で行う。

```bash
unzip -l socrametry-function.zip | head    # index.js と package.json がルートにあるか
```

> **ハンドラの検証は文字列検索で行わない。** esbuild の CommonJS 出力は
> `__toCommonJS` を経由して `module.exports` を組み立てるため、
> バンドル結果に `exports.handler` という**字面は現れない**。
> `require()` して `typeof handler === 'function'` を確認する
> （契約そのものを検証する）方式にしている。`build.mjs` と CI の両方で実施する。

---

## 3. enebular 側の事前セットアップ（手動・初回のみ）

CLI は既存のアセットと実行環境に対して動くため、**最初の 1 回はコンソールで作る**。

| # | 作業 | 取得する ID |
|---|---|---|
| 1 | プロジェクトを **1 つ**作成（development 相当）※ production は v0.2（F19 Won't） | `PROJECT_ID` |
| 2 | データストアのテーブルを **5 つ**作成（§3.1） | テーブル ID × 5 |
| 3 | ZIP をファイルアセットとして登録（`--deploy-type cloud --handler index.handler`） | `ASSET_ID` |
| 4 | ZIP 向けクラウド実行環境を作成（ランタイム Node.js 22.x） | `CLOUD_ID` |
| 5 | HTTP トリガーを有効化しパスを設定（インスタンス内で一意） | トリガー URL |
| 6 | `connectDataStore` を有効化し、環境変数を設定 | — |
| 7 | アクセスキー / シークレットキーを発行 | `ENEBULAR_ACCESS_KEY` / `ENEBULAR_SECRET_KEY` |

> **手順 3 は ZIP の実体を要求する。** アプリの実装前にセットアップを進める場合は、
> `exports.handler` が 200 を返すだけの最小 ZIP を登録しておき、
> 以降は CI の `enebular update file` で中身を差し替える。

### 3.1 作成するテーブル（5 つ）

コンソールでの作成時に**キー名と型**を指定する。定義は
[data-model.md §2](data-model.md#2-テーブル一覧9-テーブル) と
[scope-v0.1.md §4.4](scope-v0.1.md#44-データストアのテーブルを-5-つに絞る) が正。

| # | テーブル | メインキー | サブキー | サブキー型 | 対応する環境変数 |
|---|---|---|---|---|---|
| 1 | `users` | `email` | `kind`（値は `"account"` 固定） | 文字列 | `DS_TABLE_USERS` |
| 2 | `sessions` | `ownerId` | `sessionId`（ULID） | 文字列 | `DS_TABLE_SESSIONS` |
| 3 | `session_secrets` | `sessionId` | `kind` | 文字列 | `DS_TABLE_SECRETS` |
| 4 | `reports` | `ownerId` | `sessionId`（ULID） | 文字列 | `DS_TABLE_REPORTS` |
| 5 | `ops_logs` | `sessionId` | `ts`（epoch ms） | **数値** | `DS_TABLE_OPS_LOGS` |

`org_directory` / `member_stats` / `assignments` / `question_bank` は **v0.2 で追加**する（F16 Won't）。
v0.1 はフリー / トライアル枠を前提とするため、テーブル数上限 10 に対して 5 で収める（前提 A-8）。

> **`ops_logs` のサブキーだけが数値**である点に注意。
> 文字列で作ると時系列の範囲クエリ（A5）が辞書順になり、桁が変わった時点で壊れる。

### 3.2 手順 3 を CLI で行う場合

```bash
enebular add file \
  --project-id <プロジェクトID> \
  --file ./socrametry-function.zip \
  --deploy-type cloud \
  --handler index.handler \
  --name "SocraMetry Function" \
  --detail "SocraMetry backend"
```

### 3.3 環境変数の設定（手順 6）

`enebular bulk-update cloud-config` の設定ファイルで指定できるキーは
`name` / `httpTriggerStatus` / `httpTriggerPath` / `scheduleTriggerStatus` /
`scheduleTriggerDef` / `timeout` / `connectAgent` / `connectDataStore` / `envVars`。

```bash
enebular bulk-update cloud-config \
  --project-id <プロジェクトID> \
  --cloud-id <クラウド実行環境ID> \
  --config-file ./config.json
```

**方針（未決 Q-8）**: `envVars` には `ORCAROUTER_API_KEY` が含まれるため、
**設定ファイルをリポジトリにコミットしない**。v1 は以下を推奨する。

| 案 | 内容 | 採否 |
|---|---|---|
| **A（推奨）** | `envVars` は**コンソールで手動管理**し、CI は ZIP の更新とデプロイのみ行う | v1 で採用 |
| B | CI で GitHub Secrets からテンプレートを埋めて `config.json` を生成し `bulk-update` する | キーのローテーションを自動化したくなったら移行 |

案 A なら、**CI が知る必要のあるシークレットは enebular のアクセスキーだけ**になり、
OrcaRouter のキーが GitHub 側に一切存在しない状態を保てる。

---

## 4. GitHub Actions ワークフロー

実装は [.github/workflows/deploy-function.yml](../.github/workflows/deploy-function.yml)。

### 4.1 必要な GitHub Secrets

| Secret | 用途 |
|---|---|
| `ENEBULAR_ACCESS_KEY` | enebular CLI の認証 |
| `ENEBULAR_SECRET_KEY` | 同上 |

> **値の前後に空白や改行が入っていると認証エラーになる**（[公式ブログ](https://blog.enebular.com/function/github-actions-enebular-cli-automation/)より）。
> ワークフローの冒頭で空チェックを行っている。

### 4.2 必要な GitHub Variables

シークレットではない ID は Variables（`vars`）で管理し、環境ごとに切り替える。

| Variable | 用途 |
|---|---|
| `ENEBULAR_PROJECT_ID` | デプロイ先プロジェクト ID |
| `ENEBULAR_CLOUD_ID` | クラウド実行環境 ID |
| `ENEBULAR_FILE_ASSET_ID` | ZIP のファイルアセット ID |

GitHub Environments を作り、環境ごとにこの 3 つを設定する。
**v0.1 は `development` のみ**（enebular プロジェクトが 1 つのため）。
`production` は v0.2 で追加し、Required reviewers を付けて承認制にする。

このほか、デプロイ後の疎通確認に `HTTP_TRIGGER_URL`（トリガー URL）を設定できる。
未設定ならスモークテストのステップはスキップされる。

### 4.3 実行順序

```
build → update file → deploy cloud → add file-version
```

| # | ステップ | コマンド |
|---|---|---|
| 1 | ZIP をビルド | `pnpm --filter @socrametry/function build:zip` |
| 2 | ファイルアセットを差し替え | `enebular update file --project-id … --asset-id … --file … --json` |
| 3 | クラウド実行環境へデプロイ | `enebular deploy cloud --project-id … --cloud-id … --asset-id … --asset-type file --json` |
| 4 | バージョンを記録 | `enebular add file-version --project-id … --asset-id … --name … --comment … --json` |

> **`--json` を必ず付ける。** GitHub Actions では対話的な確認ができないため、
> これがないと確認プロンプトで workflow が停止する。`--yes` でも同様の効果がある。

> **`--asset-type` は `file`。** ブログ記事の例は Node-RED フローのデプロイのため `flow` だが、
> ZIP デプロイでは `file` を指定する。

---

## 5. ロールバック

`enebular add file-version` でバージョンを記録しているため、
コンソールから過去バージョンを選んで再デプロイできる。

CI からのロールバックは `workflow_dispatch` で対象タグを指定して
ワークフローを再実行する（ビルドし直して同じ内容を再デプロイする）方式とする。
ZIP は決定的にビルドされるため、同じコミットからは同じ ZIP が得られる。

---

## 6. デプロイ前チェックリスト

| # | 確認項目 | 検証 |
|---|---|---|
| 1 | ZIP のルート直下に `index.js` と `package.json` があるか | 自動 |
| 2 | ZIP 内 `package.json` に `"type": "module"` が**ない**か | 自動 |
| 3 | ハンドラ指定が `index.handler` になっているか | 自動 |
| 4 | ZIP サイズが 250MB 以下か | 自動 |
| 5 | デプロイしたコミットが実際に動いているか | 自動 |
| 6 | `envVars` に必要なテーブル ID と鍵が設定されているか | 自動 |
| 7 | `SESSION_JWT_SECRET` と `INVITE_CODE` が既定値（`change-me`）のままでないか | 自動 |
| 8 | `connectDataStore` が有効か | 手動 |
| 9 | `OPS_LOG_ENABLED` が `true` か（v0.1 はコスト実測のため有効にする / F11） | 手動 |
| 10 | **`MOCK_MODE` が意図した値になっているか**（本番で `true` のまま公開しない） | 手動 |
| 11 | HTTP トリガーのパスが enebular インスタンス内で一意か | 手動 |
| 12 | `timeout` が API 仕様の想定レイテンシ（最大 20 秒）より長いか | 手動 |
| 13 | `LOG_LEVEL` が `INFO` 以下か（`DEBUG` 以上は入力内容がログに出うる） | 手動 |

**自動** = デプロイのたびに CI が検証し、満たさなければワークフローが落ちる。
1〜4 は ZIP のビルド時（`build.mjs`）と `Verify ZIP layout`、
5〜7 は `Smoke test` が `/v1/health` の応答を見て判定する。

**手動** = 初回セットアップ時と設定変更時に人が確認する。
9・10 は「意図した値かどうか」であり、機械には判定できない。

### 6・7 の自動チェックの仕組み

`apps/function/src/config.ts` が、**動作モードに応じて**必須の環境変数を判定する。

| 条件 | 追加で必須になるもの |
|---|---|
| 常に | `DS_TABLE_USERS` / `SESSIONS` / `SECRETS` / `REPORTS`、`SESSION_JWT_SECRET`、`INVITE_CODE` |
| `OPS_LOG_ENABLED=true` | `DS_TABLE_OPS_LOGS` |
| `MOCK_MODE` が `true` 以外 | `ORCAROUTER_API_KEY`、`MODEL_DIAGNOSER` / `QUESTIONER` / `JUDGE` |

`.env.example` の雛形の値（`00000000-…` / `change-me`）のままなら未設定として扱う。

> **不足しているキー名は `/v1/health` に出さない。** このエンドポイントは認証不要のため、
> 公開するのは `configOk`（真偽値）と `configMissing`（件数）だけ。
> キー名は**起動時のログ**（`config.incomplete`）にのみ出力する。値はどこにも出さない。

> **起動を止める形（throw）にはしない。** 設定 1 個の欠けで全リクエストが 500 になると
> `/v1/health` すら返らず、「関数は動いているのに何も応答しない」という
> 最も切り分けにくい状態になる。`configOk: false` を返せる状態で立ち上がる方が診断できる。

> **トリガーのパスをアプリ側に設定する必要はない。**
> アプリは先頭セグメントを問わずルーティングするため、
> トリガーのパスを変えてもアプリの再設定は要らない（ADR-009）。

> **10 は特に注意。** `MOCK_MODE=true` のまま公開すると、
> 固定応答が返っていることに気づかないまま「動いている」と見えてしまう。
> ここだけは自動化できないため、`/v1/health` の `mockMode` を目視で確認する。
