import { CouponScope, CouponChannel, CouponType } from '../../entities/enums';
import { CouponService, type CouponBasket } from './coupon.service';

const coupon = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'cpn-1',
  code: 'WELCOME10',
  type: CouponType.PERCENT,
  percentValue: '10.00',
  flatValuePaise: null,
  minOrderValuePaise: null,
  maxDiscountPaise: null,
  appliesTo: CouponScope.ALL,
  categoryId: null,
  channel: CouponChannel.ALL,
  firstOrderOnly: false,
  usageLimit: null,
  usageLimitPerUser: null,
  startsAt: null,
  expiresAt: null,
  isActive: true,
  ...overrides,
});

/** A ₹1,000 retail basket of almonds. */
const basket: CouponBasket = {
  channel: 'retail',
  lines: [{ categoryId: 'cat-almonds', lineTotalPaise: 100_000n }],
  subtotalPaise: 100_000n,
};

function harness(
  row: ReturnType<typeof coupon> | null,
  counts: { total?: number; forUser?: number; ordersForUser?: number } = {},
) {
  return new CouponService(
    { findOne: jest.fn(() => Promise.resolve(row)) } as never,
    {
      count: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve('userId' in where ? (counts.forUser ?? 0) : (counts.total ?? 0)),
      ),
    } as never,
    { count: jest.fn(() => Promise.resolve(counts.ordersForUser ?? 0)) } as never,
  );
}

describe('CouponService.preview', () => {
  it('takes a percentage of the subtotal, in paise', async () => {
    const result = await harness(coupon()).preview('WELCOME10', basket, null);
    expect(result).toMatchObject({ eligible: true, discountPaise: 10_000n });
  });

  it('caps a percentage at maxDiscountPaise', async () => {
    const result = await harness(coupon({ maxDiscountPaise: 5_000n })).preview(
      'WELCOME10',
      basket,
      null,
    );
    expect(result.discountPaise).toBe(5_000n);
  });

  it('takes a flat amount when that is the type', async () => {
    const flat = coupon({ type: CouponType.FLAT, percentValue: null, flatValuePaise: 15_000n });
    const result = await harness(flat).preview('FLAT150', basket, null);
    expect(result.discountPaise).toBe(15_000n);
  });

  /**
   * A ₹500 flat coupon on a ₹300 order must not make the total negative. `Order.totalPaise` is a
   * bigint with no check constraint, so nothing downstream would catch it.
   */
  it('never discounts more than the basket is worth', async () => {
    const flat = coupon({ type: CouponType.FLAT, percentValue: null, flatValuePaise: 50_000n });
    const small: CouponBasket = {
      ...basket,
      subtotalPaise: 30_000n,
      lines: [{ categoryId: 'cat-almonds', lineTotalPaise: 30_000n }],
    };
    const result = await harness(flat).preview('FLAT500', small, null);
    expect(result.discountPaise).toBe(30_000n);
  });

  it('refuses an unknown code without saying whether it ever existed', async () => {
    const result = await harness(null).preview('NOPE', basket, null);
    expect(result).toMatchObject({ eligible: false, code: 'COUPON_INVALID' });
  });

  it('refuses an inactive coupon', async () => {
    const result = await harness(coupon({ isActive: false })).preview('WELCOME10', basket, null);
    expect(result.eligible).toBe(false);
  });

  it('refuses one outside its window, at both ends', async () => {
    const future = coupon({ startsAt: new Date(Date.now() + 86_400_000) });
    const past = coupon({ expiresAt: new Date(Date.now() - 86_400_000) });
    await expect(harness(future).preview('X', basket, null)).resolves.toMatchObject({
      eligible: false,
    });
    await expect(harness(past).preview('X', basket, null)).resolves.toMatchObject({
      eligible: false,
    });
  });

  it('refuses a basket under the minimum, and names the shortfall', async () => {
    const result = await harness(coupon({ minOrderValuePaise: 150_000n })).preview(
      'X',
      basket,
      null,
    );
    expect(result).toMatchObject({ eligible: false, code: 'COUPON_MIN_ORDER_VALUE' });
    // The customer can act on this one, so it carries the figure rather than a bare refusal.
    expect(result.minOrderValuePaise).toBe(150_000n);
  });

  it('refuses the wrong channel', async () => {
    const bulkOnly = coupon({ channel: CouponChannel.BULK });
    await expect(harness(bulkOnly).preview('X', basket, null)).resolves.toMatchObject({
      eligible: false,
    });
  });

  /**
   * A category coupon discounts only the lines in that category, not the whole basket — otherwise
   * "10% off almonds" takes 10% off the cashews sitting beside them.
   */
  it('discounts only the lines in its category', async () => {
    const almondsOnly = coupon({ appliesTo: CouponScope.CATEGORY, categoryId: 'cat-almonds' });
    const mixed: CouponBasket = {
      channel: 'retail',
      subtotalPaise: 150_000n,
      lines: [
        { categoryId: 'cat-almonds', lineTotalPaise: 100_000n },
        { categoryId: 'cat-cashews', lineTotalPaise: 50_000n },
      ],
    };
    const result = await harness(almondsOnly).preview('ALMOND10', mixed, null);
    expect(result.discountPaise).toBe(10_000n);
  });

  it('refuses a category coupon when no line qualifies', async () => {
    const almondsOnly = coupon({ appliesTo: CouponScope.CATEGORY, categoryId: 'cat-almonds' });
    const cashews: CouponBasket = {
      channel: 'retail',
      subtotalPaise: 50_000n,
      lines: [{ categoryId: 'cat-cashews', lineTotalPaise: 50_000n }],
    };
    await expect(harness(almondsOnly).preview('ALMOND10', cashews, null)).resolves.toMatchObject({
      eligible: false,
      code: 'COUPON_NOT_APPLICABLE',
    });
  });

  it('refuses when the global usage limit is spent', async () => {
    const result = await harness(coupon({ usageLimit: 5 }), { total: 5 }).preview(
      'X',
      basket,
      'u1',
    );
    expect(result.eligible).toBe(false);
  });

  it('refuses when this customer has spent their own allowance', async () => {
    const result = await harness(coupon({ usageLimitPerUser: 1 }), { forUser: 1 }).preview(
      'X',
      basket,
      'u1',
    );
    expect(result.eligible).toBe(false);
  });

  /**
   * `firstOrderOnly` counts **orders**, not redemptions. A customer whose first order used no coupon
   * has still had a first order; counting redemptions would let them spend a first-order coupon on
   * their fifth purchase.
   */
  it('refuses a first-order coupon to a customer who already has an order', async () => {
    const result = await harness(coupon({ firstOrderOnly: true }), { ordersForUser: 1 }).preview(
      'X',
      basket,
      'u1',
    );
    expect(result.eligible).toBe(false);
  });

  /**
   * A guest has no history, so this **is** their first order. The other reading — refuse what you
   * cannot verify — blocks precisely the customer a first-order coupon exists to attract.
   */
  it('allows a first-order coupon to a guest', async () => {
    const result = await harness(coupon({ firstOrderOnly: true })).preview('X', basket, null);
    expect(result.eligible).toBe(true);
  });

  /**
   * Added after mutation testing: measuring the minimum against `basket.subtotalPaise` instead of the
   * eligible subtotal passed all sixteen tests above, because in every one of them the two figures are
   * equal. It is not a cosmetic difference — it is what makes "spend ₹1,500 on almonds" satisfiable
   * with ₹1,000 of almonds and ₹500 of cashews.
   */
  it('measures the minimum against the eligible subtotal, not the whole basket', async () => {
    const almondsOnly = coupon({
      appliesTo: CouponScope.CATEGORY,
      categoryId: 'cat-almonds',
      minOrderValuePaise: 150_000n,
    });
    const mixed: CouponBasket = {
      channel: 'retail',
      subtotalPaise: 150_000n,
      lines: [
        { categoryId: 'cat-almonds', lineTotalPaise: 100_000n },
        { categoryId: 'cat-cashews', lineTotalPaise: 50_000n },
      ],
    };
    const result = await harness(almondsOnly).preview('ALMOND10', mixed, null);
    expect(result).toMatchObject({ eligible: false, code: 'COUPON_MIN_ORDER_VALUE' });
  });

  /**
   * Added after mutation testing: *refuses the wrong channel* is satisfied by an implementation that
   * refuses every channel-scoped coupon, since it only ever presents the mismatching case. This is
   * the other half — the coupon that names the basket's own channel has to work.
   */
  it('allows a coupon scoped to the channel the basket is in', async () => {
    const retailOnly = coupon({ channel: CouponChannel.RETAIL });
    const result = await harness(retailOnly).preview('X', basket, null);
    expect(result).toMatchObject({ eligible: true, discountPaise: 10_000n });
  });

  /**
   * `ck_coupons_value_exclusive` makes this unreachable from the database, so the branch exists for
   * the other route to it: a narrowed `select` that omits the column hands `applyPercent` a `NaN` rate,
   * which throws `RangeError` and becomes a 500. A coupon whose value cannot be read is invalid, not a
   * zero discount the customer gets to apply successfully.
   */
  it('refuses a coupon whose value column does not match its type', async () => {
    const noPercent = coupon({ type: CouponType.PERCENT, percentValue: null });
    const noFlat = coupon({ type: CouponType.FLAT, percentValue: null, flatValuePaise: null });
    await expect(harness(noPercent).preview('X', basket, null)).resolves.toMatchObject({
      eligible: false,
      code: 'COUPON_INVALID',
    });
    await expect(harness(noFlat).preview('X', basket, null)).resolves.toMatchObject({
      eligible: false,
      code: 'COUPON_INVALID',
    });
  });

  /**
   * `Coupon.category` is `ON DELETE SET NULL`, and the entity's docblock hands the consequence to
   * "application validation". This is it: deleting the almonds category must not silently promote
   * "10% off almonds" to 10% off everything.
   */
  it('refuses a category coupon that has lost its category rather than widening it', async () => {
    const orphaned = coupon({ appliesTo: CouponScope.CATEGORY, categoryId: null });
    await expect(harness(orphaned).preview('ALMOND10', basket, null)).resolves.toMatchObject({
      eligible: false,
      code: 'COUPON_NOT_APPLICABLE',
    });
  });

  it('is case-insensitive about the code, because the input is upper-cased on the way in', async () => {
    const findOne = jest.fn(() => Promise.resolve(coupon()));
    const service = new CouponService(
      { findOne } as never,
      { count: jest.fn(() => Promise.resolve(0)) } as never,
      { count: jest.fn(() => Promise.resolve(0)) } as never,
    );
    await service.preview('welcome10', basket, null);
    expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { code: 'WELCOME10' } }));
  });
});
