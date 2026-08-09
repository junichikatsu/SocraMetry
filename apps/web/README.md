# apps/web — フロントエンド

Next.js 15 (App Router) / TypeScript / Tailwind CSS

> **未実装。** 現在は要件定義フェーズのため、このディレクトリは構成のプレースホルダです。
> 着手は [M2: MVP](../../docs/roadmap.md#m2-mvpコア体験の一気通貫) から。

## 責務

| 画面 | パス | 内容 |
|---|---|---|
| ランディング / エラー投稿 | `app/page.tsx` | エラーテキストの貼り付け、任意情報の入力 |
| 問答画面（コア体験） | `app/sessions/[id]/page.tsx` | 質問カード・選択肢・段階プログレス・ヒント |
| 振り返りレポート | `app/sessions/[id]/report/page.tsx` | スコアレーダー・つまずき・一般化された学び |
| 履歴 | `app/history/page.tsx` | セッション一覧とスコア推移 |

## やらないこと

- **OrcaRouter を直接呼ばない。** LLM へのアクセスはすべて `apps/api` 経由。
  API キーがフロントに露出する構成を作らないこと（NFR-S1）。
- **答えを持たない。** `packages/shared` の公開型には正解も原因も含まれないため、
  型に従っている限り自然に守られる。

## 依存

`packages/shared`（Zod スキーマ / 公開型）のみ。
