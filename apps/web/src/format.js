// @ts-check
/**
 * 表示用の整形。**DOM にも API にも触らない純関数**だけを置く。
 * 単体で確かめられる形にしておきたいものの受け皿。
 */

/**
 * 比率（0〜1）を百分率の文字列にする。**小数点以下 1 桁で丸める。**
 *
 * 丸めないと 3 件中 1 件が `33.33333333333333` になる。
 * 桁を増やしても意味は増えない。セッション数が少ない段階では、
 * そもそも横比較に耐えない値である（evaluation-model.md §3.5）。
 *
 * 整数になるものは小数点を出さない（`100.0` ではなく `100`）。
 *
 * @param {number|null|undefined} value 0〜1 の比率
 * @returns {string} `%` は付けない。単位の置き方は呼び出し側で決める
 */
export function percent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const rounded = Math.round(value * 1000) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/**
 * 待ち時間の案内。`Retry-After`（秒）から作る。
 *
 * **秒まで出さない。** 「あと 1382 秒」と言われても待つか諦めるかの判断は変わらず、
 * 数字が細かいほど正確そうに見えるだけになる。分に丸めて切り上げる
 * （切り捨てると、その時刻に試してまだ弾かれる）。
 *
 * @param {number|null|undefined} sec
 * @returns {string} 案内文。時間が分からなければ空文字
 */
export function retryLabel(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return ''
  if (sec < 60) return 'あと 1 分ほどで再開できます。'

  const minutes = Math.ceil(sec / 60)
  if (minutes < 60) return `あと約 ${minutes} 分で再開できます。`

  /**
   * **レート制限の窓は 1 時間なので、ここに来る値は 3600 秒までしかない。**
   * それでも時間へ換算しようとすると、3601 秒を「約 2 時間」と切り上げてしまい、
   * 実際より長く待たせる案内になる。上限で言い切る方が正確。
   */
  return 'あと約 1 時間で再開できます。'
}
