# apps/web — フロントエンド

**フレームワークなし。HTML + CSS + 素の JavaScript。バンドラ（esbuild）だけを入れている。**

画面の仕様は [docs/screen-design.md](../../docs/screen-design.md)、
意匠は [MOCK/](../../MOCK/) が正です。

## 構成

```
src/                    ★ 編集するのはこちら
├── main.js             3 ゲートの進行と配線
├── api.js              API 呼び出し規約（202 の再送を含む）
├── thread.js           対話スレッドの描画
├── report.js           結果カード（算出根拠つき）
├── dashboard.js        個人ダッシュボードと履歴
├── radar.js            5 軸レーダー（SVG 手書き）
├── mask-preview.js     送信前マスキングプレビュー
├── stages.js           段階・5 軸・選択肢の定数
└── dom.js              DOM 組み立てヘルパ

public/                 配信物
├── index.html          構造だけを持つ。文言と分岐は JS が入れる
├── styles.css
└── app.js              ★ 生成物。git 管理しない。編集しても消える
```

**`public/` の 3 ファイルは `apps/function` が配信します**
（[ADR-012](../../docs/architecture.md#adr-012-フロントエンドを関数から同一オリジンで配信する)）。
別ホスティングは使いません。

## 開発

```bash
# 1) バンドルを監視ビルド（別ターミナルで動かしっぱなしにする）
pnpm dev:web

# 2) API サーバ。public/ をリクエストごとに読み直すのでリロードだけで反映される
pnpm dev
```

`index.html` と `styles.css` は 1) を経由しません。編集したらリロードだけで反映されます。

`pnpm --filter @socrametry/function build:zip` は**先に `apps/web` をビルドします。**
CI もデプロイもこのコマンドを直接呼ぶため、古い `app.js` が ZIP に入ることはありません。

## なぜフレームワークを使わないのか

| # | 理由 |
|---|---|
| 1 | ルーティングも複雑な状態管理も不要。フレームワークが解く問題が存在しない |
| 2 | 同一オリジン配信（ADR-012）と噛み合う。静的ファイルをそのまま返せる |
| 3 | 依存が増えないことは、攻撃面が増えないことでもある |

## なぜバンドラだけ入れたのか

**送信前のマスキングプレビュー**（[security.md §3](../../docs/security.md#3-秘匿情報のマスキングr1-への対策) の A / v0.1 必須）を
実装するため、**サーバと同じ純関数** `@socrametry/core/masking` をブラウザに届ける必要があります。

プレビュー用に正規表現を書き写す案は採っていません。
2 つの実装が乖離した瞬間、**画面では消えているのにサーバには生で届く**表示になります。
マスキングは「消えて見えること」自体が機能なので、表示と実体がずれる余地を残せません。

入れたのは**バンドラだけ**です。トランスパイルもフレームワークも入れていません。
`src/` に書くのはブラウザがそのまま解釈できる構文の素の JavaScript で、
esbuild がやるのは import の解決と結合だけ、出力も `minify: false` で読める形のままです。

詳細は [ADR-013](../../docs/architecture.md#adr-013-フロントエンドをフレームワークなしで書くバンドラのみ入れる)。

## 絶対に守ること

| # | ルール |
|---|---|
| 1 | **`innerHTML` を使わない。`textContent` を使う** |
| 2 | OrcaRouter を直接呼ばない。API キーに関する記述をこのディレクトリに置かない |
| 3 | 送信中はボタンを `disabled` にする（連打防止 / F04） |
| 4 | API は相対パスで呼ぶ。ベース URL の環境変数を作らない |
| 5 | MOCK モードで動いていることを画面に明示する |
| 6 | **外部ホストを読まない**（CDN・Web フォント・画像） |
| 7 | 「どのボタンを出してよいか」はサーバの `actions` に従う。条件式を持たない |
| 8 | 画面の出し分けは `hidden` 属性だけで行う（下記） |

### 8: `hidden` と `display` の衝突

`hidden` を効かせているのはブラウザ標準の `[hidden] { display: none }` で、
**これは作者スタイルより弱い**。クラス側に `display: flex` を 1 行書くと、
`hidden` を立てても表示されたままになります（実際にログイン画面で起きました）。

`styles.css` の**末尾**に `[hidden] { display: none !important; }` を置いて押さえています。
「末尾に置く」と「`!important`」の両方をやっているのは、
どちらの解決規則でも勝つようにするためです（理由は該当箇所のコメント）。

**`display` を新しく足したら `src/visibility.test.js` の `TOGGLED` に id を足してください。**

### 1 が特に重要な理由

React のような**自動エスケープがありません**。
ユーザーが貼り付けたエラーテキストに `<script>` が含まれていれば、
LLM がそれを引用した文を生成しえます。

```js
// ✗ LLM 出力をそのまま HTML として挿入
optionEl.innerHTML = option.label

// ✓ テキストとして挿入
optionEl.textContent = option.label
```

**LLM の出力は信頼できない入力として扱う。**
`src/**` に対して lint で `innerHTML` / `outerHTML` を禁止しています
（[security.md §7](../../docs/security.md#7-その他)）。

### 6 が必要な理由

モックは Tailwind の CDN と Google Fonts を読んでいますが、配信物では使いません。
細い回線（テザリングでの NFR-P1 計測 / #23）でスタイルが後から降ってくる状態を作らないため、
また同一オリジン配信（ADR-012）で消した外部依存を戻さないためです。

## テスト

```bash
pnpm --filter @socrametry/web test
```

`src/visibility.test.js` が、`index.html` と `styles.css` を実際に組み上げて
**計算済みスタイル**を見ます。見た目は対象にせず、
「`hidden` を立てたら消える」という一点だけを守ります。

型検査でも lint でも出ない種類の壊れ方なので、**組み上げて確かめるしかありません。**

> jsdom は `!important` を解釈せず、指定順と詳細度だけで解決します。
> そのため `!important` だけに頼った書き方はこのテストを通りません。
> 実ブラウザでは通ってしまうため、**テストの方が厳しい**状態にしてあります。

## 型検査

`tsc --checkJs` で JSDoc の注釈を検査します（`pnpm --filter @socrametry/web typecheck`）。
**目的は `@socrametry/shared` の公開型と突き合わせて API 契約のずれを拾うこと**で、
すべてに注釈を付けることではありません（`strict` は切ってあります。理由は `tsconfig.json`）。

## v0.2 で見直すこと

組織ダッシュボード（複数画面・グラフ・一覧）が入る段階で、フレームワーク導入を再検討します。
**v0.1 の画面数には過剰である**というだけで、将来にわたって不要という判断ではありません。

モックにあって v0.1 で作っていないものは
[screen-design.md §6](../../docs/screen-design.md#6-モックにあるが実装していないもの) に一覧があります。
