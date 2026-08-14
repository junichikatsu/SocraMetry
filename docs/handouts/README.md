# ブース配布資料(handouts)

デモ・ブース来場者向けの配布資料。原稿(HTML)と生成物(PDF)をここに置く。

| 資料 | 原稿 | 生成物(縦 / 横) | 元にした設計書 |
|---|---|---|---|
| コスト価格表 | [cost-pricing.html](cost-pricing.html) | cost-pricing.pdf / cost-pricing-landscape.pdf | [cost-model.md](../cost-model.md) |
| セキュリティ説明 | [security.html](security.html) | security.pdf / security-landscape.pdf | [security.md](../security.md) |

## PDF の再生成

```sh
pnpm build:handouts
```

1 つの原稿から縦向き(A4)と横向き(A4 landscape)の両方を生成する。
横向き専用の原稿は無く、`@page` を上書きした一時ファイル経由で生成するため、縦横で内容がずれることはない。

インストール済みの Edge / Chrome のヘッドレス印刷で PDF 化する(依存パッケージは追加しない)。
ブラウザを指定したい場合は `BROWSER_PATH` で実行ファイルを指定する。

## 編集時の注意

- **数値を変えるときは元の設計書から。** 原価・粗利などの数値の正は
  [cost-model.md](../cost-model.md)(実測・請求突き合わせ済み)にある。原稿側で数字を作らない
- **販売価格は正式決定していない。** 1,000 円/人月は仮定値であり、「参考価格(仮)」の明示を外さない
- **「できないことをできると書かない」**([security.md](../security.md) の原則)。
  特に「固有名詞は自動では消えない」の注意書きは削らない
- 原稿を編集したら PDF を再生成し、**両方をコミットする**
