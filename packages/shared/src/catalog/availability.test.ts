import { describe, expect, it } from 'vitest';
import { productSoldOut, variantSoldOut } from './availability';

/** The minimum a variant needs for an availability decision. */
const v = (available: number, isActive = true): { available: number; isActive: boolean } => ({
  available,
  isActive,
});

describe('variantSoldOut', () => {
  it('is sold out at zero and in stock above it', () => {
    expect(variantSoldOut(0)).toBe(true);
    expect(variantSoldOut(1)).toBe(false);
    expect(variantSoldOut(120)).toBe(false);
  });

  /**
   * `available` is `onHand - reserved`. The `ck_inventory_non_negative` check constraint does keep
   * `onHand >= reserved`, so a figure read off an `inventory` row is never negative — but this
   * function's parameter is a plain `number`, not a checked column, and a negative one has to mean
   * "nothing to sell" rather than falling through to "in stock" because `-3 === 0` is false.
   */
  it('treats a negative figure as sold out', () => {
    expect(variantSoldOut(-1)).toBe(true);
    expect(variantSoldOut(-100)).toBe(true);
  });
});

describe('productSoldOut', () => {
  it('is sold out only when every active variant is', () => {
    expect(productSoldOut([v(0), v(0)])).toBe(true);
    expect(productSoldOut([v(0), v(5)])).toBe(false);
    expect(productSoldOut([v(5), v(5)])).toBe(false);
  });

  /**
   * Spec §10.1 says "every *active* variant". An inactive variant is not for sale, so it must not
   * vote. Counting it would let a discontinued 50kg pack keep a product looking in stock forever.
   */
  it('ignores inactive variants', () => {
    expect(productSoldOut([v(0), v(99, false)])).toBe(true);
    expect(productSoldOut([v(3), v(0, false)])).toBe(false);
  });

  /**
   * A product with nothing sellable cannot be bought, so it is sold out.
   *
   * `Array.prototype.every` is vacuously true on an empty array, so an implementation built on
   * `.every(...)` returns `true` here as a by-product of that rule rather than by deciding
   * anything about emptiness. The case is pinned because a refactor to `.some(...)`, which
   * returns `false` on an empty array, would silently invert it and put "in stock" on a product
   * with nothing to sell.
   */
  it('treats a product with no active variants as sold out', () => {
    expect(productSoldOut([])).toBe(true);
    expect(productSoldOut([v(120, false)])).toBe(true);
  });

  /**
   * `productSoldOut` must delegate to `variantSoldOut` rather than re-testing `available === 0`
   * inline — the exact duplication this module exists to prevent. A negative-stock active variant
   * is the case that separates the two: `=== 0` reads `-2` as in stock.
   */
  it('delegates the per-variant rule instead of re-testing available === 0', () => {
    expect(productSoldOut([v(-2)])).toBe(true);
    expect(productSoldOut([v(-2), v(0)])).toBe(true);
    expect(productSoldOut([v(-2), v(7)])).toBe(false);
  });
});
