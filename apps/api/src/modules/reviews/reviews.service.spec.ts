import { summarise } from './reviews.service';

const review = (
  rating: number,
  verifiedPurchase = false,
): { rating: number; verifiedPurchase: boolean } => ({
  rating,
  verifiedPurchase,
});

describe('summarise', () => {
  it('averages to one decimal place', () => {
    expect(summarise([review(5), review(4)]).average).toBe(4.5);
    expect(summarise([review(5), review(4), review(4)]).average).toBe(4.3);
  });

  it('counts verified purchases separately from the total', () => {
    const summary = summarise([review(5, true), review(4), review(3, true)]);
    expect(summary.total).toBe(3);
    expect(summary.verifiedCount).toBe(2);
  });

  /**
   * Five buckets always, five stars down to one, even where the count is zero. A distribution that
   * omits empty buckets makes the review histogram render with missing bars rather than short ones.
   */
  it('always returns five buckets, highest first', () => {
    const summary = summarise([review(5), review(5), review(3)]);
    expect(summary.distribution.map((bucket) => bucket.stars)).toEqual([5, 4, 3, 2, 1]);
    expect(summary.distribution.map((bucket) => bucket.count)).toEqual([2, 0, 1, 0, 0]);
  });

  it('expresses each bucket as a whole percentage of the total', () => {
    const summary = summarise([review(5), review(5), review(4), review(1)]);
    expect(summary.distribution[0]?.percent).toBe(50);
    expect(summary.distribution[1]?.percent).toBe(25);
    expect(summary.distribution[4]?.percent).toBe(25);
  });

  /**
   * A product with no reviews must not divide by zero. `0/0` is `NaN`, which serialises to `null` in
   * JSON and renders as an empty star rating rather than "no reviews yet".
   */
  it('returns zeroes rather than NaN for a product with no reviews', () => {
    const summary = summarise([]);
    expect(summary.average).toBe(0);
    expect(summary.total).toBe(0);
    expect(summary.verifiedCount).toBe(0);
    expect(summary.distribution.every((bucket) => bucket.count === 0 && bucket.percent === 0)).toBe(
      true,
    );
  });

  /**
   * The seeded fixture, pinned: three approved reviews at 5, 4 and 2 stars on
   * `premium-california-almonds`.
   *
   * The same mean is computed twice by two different routes — here in TypeScript at one decimal
   * place, and in SQL by `recomputeAggregates` into a `numeric(3,2)` column, which stores 3.67. The
   * two figures therefore differ in the second decimal and are **not** interchangeable in an
   * assertion. They agree on screen, because `ReviewList.tsx` renders both through `toFixed(1)`.
   * This pins the display figure; the integration spec pins the column.
   */
  it('rounds the seeded fixture to the one-decimal figure the histogram renders', () => {
    expect(summarise([review(5, true), review(4, true), review(2, true)]).average).toBe(3.7);
  });
});
