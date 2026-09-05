import { toPaise } from '@nutwala/shared';
import type { DataSource } from 'typeorm';
import { Category } from '../../entities/catalog/category.entity';
import { Coupon } from '../../entities/commerce/coupon.entity';
import { CouponChannel, CouponScope, CouponType } from '../../entities/enums';
import { requireValue } from './seed-context';

/**
 * Three coupons, because the table has eleven eligibility columns and shipped with zero rows.
 *
 * A complete schema with no data is a feature nobody can try: `POST /checkout/coupon/preview` had
 * nothing to answer about, and the milestone's browser check had nothing to type. Each row here
 * exercises a different shape of `CouponService.preview` rather than being a plausible-looking
 * duplicate of the last:
 *
 * | Code       | Exercises                                                             |
 * | ---------- | --------------------------------------------------------------------- |
 * | `WELCOME10` | percentage, `maxDiscountPaise` cap, `firstOrderOnly`                  |
 * | `BULK500`   | flat amount, `minOrderValuePaise` and `channel` together             |
 * | `ALMOND15`  | `CATEGORY` scope — so the discount is a share of the basket — and `usageLimit` |
 *
 * **No `startsAt` / `expiresAt` on any of them**, deliberately. A date baked into seed data is a
 * coupon that silently stops working on a day nobody wrote down, and then a hand test or an
 * integration fixture fails for a reason that has nothing to do with the change being made. The
 * window rule is covered by unit tests that construct their own dates.
 */
interface CouponSeed {
  code: string;
  type: CouponType;
  percentValue: string | null;
  flatValuePaise: bigint | null;
  minOrderValuePaise: bigint | null;
  maxDiscountPaise: bigint | null;
  appliesTo: CouponScope;
  /** Resolved from `categorySlug` at seed time; `null` for an unscoped coupon. */
  categorySlug: string | null;
  channel: CouponChannel;
  firstOrderOnly: boolean;
  usageLimit: number | null;
  usageLimitPerUser: number | null;
  isActive: boolean;
}

/**
 * Codes are stored uppercase, as `Coupon.code`'s docblock requires — that is what lets a customer
 * type `welcome10` and be matched. `ck_coupons_value_exclusive` requires exactly one of
 * `percentValue` / `flatValuePaise` per `type`, so each row populates one and nulls the other.
 */
const COUPON_SEEDS: CouponSeed[] = [
  {
    code: 'WELCOME10',
    type: CouponType.PERCENT,
    // `numeric(5,2)`, and a string on the way in as well as the way out.
    percentValue: '10.00',
    flatValuePaise: null,
    minOrderValuePaise: null,
    // 10% off with a ₹200 ceiling, so a ₹10,000 basket gets ₹200 rather than ₹1,000.
    maxDiscountPaise: toPaise(200),
    appliesTo: CouponScope.ALL,
    categorySlug: null,
    channel: CouponChannel.ALL,
    firstOrderOnly: true,
    usageLimit: null,
    /**
     * **Not redundant against `firstOrderOnly`, and it was never the row's *second* line of defence.**
     *
     * The obvious reading — a customer with no orders has no redemptions either — holds only for one
     * checkout at a time. `CouponService.preview` validates `firstOrderOnly` outside any lock, so two
     * concurrent placements by one customer both found no prior order; until `CheckoutService.redeem`
     * began re-checking that column under `SELECT … FOR UPDATE`, **this limit was the only thing that
     * stopped a double-click discounting both orders**, because it is the one `redeem` re-counted.
     *
     * Both are re-checked under the lock now, so the job left for this column is the one the day-to-day
     * reading names: an admin unticking `firstOrderOnly` on this coupon still cannot let one account use
     * it twice. It limits nobody at all while the coupon is anonymous, since a guest has no `userId` to
     * count — which is also why the `firstOrderOnly` re-check skips a guest.
     */
    usageLimitPerUser: 1,
    isActive: true,
  },
  {
    code: 'BULK500',
    type: CouponType.FLAT,
    percentValue: null,
    flatValuePaise: toPaise(500),
    minOrderValuePaise: toPaise(10_000),
    maxDiscountPaise: null,
    appliesTo: CouponScope.ALL,
    categorySlug: null,
    channel: CouponChannel.BULK,
    firstOrderOnly: false,
    usageLimit: null,
    usageLimitPerUser: null,
    isActive: true,
  },
  {
    code: 'ALMOND15',
    type: CouponType.PERCENT,
    percentValue: '15.00',
    flatValuePaise: null,
    minOrderValuePaise: null,
    maxDiscountPaise: null,
    appliesTo: CouponScope.CATEGORY,
    categorySlug: 'almonds',
    channel: CouponChannel.ALL,
    firstOrderOnly: false,
    usageLimit: 100,
    usageLimitPerUser: null,
    isActive: true,
  },
];

/**
 * Runs after `catalog`: `ALMOND15` is scoped to a category, and a `category_id` cannot be invented.
 *
 * `requireValue` rather than a skip, matching every other seeder here — a coupon quietly seeded with
 * a null `category_id` would widen "15% off almonds" to 15% off the whole basket in the eyes of
 * anyone reading the row, and `CouponService.preview` would then refuse it as
 * `COUPON_NOT_APPLICABLE` with no clue why.
 */
export async function seedCoupons(dataSource: DataSource): Promise<number> {
  const repository = dataSource.getRepository(Coupon);
  const categories = await dataSource
    .getRepository(Category)
    .find({ select: { id: true, slug: true } });
  const categoryIdBySlug = new Map(categories.map((category) => [category.slug, category.id]));

  for (const { categorySlug, ...seed } of COUPON_SEEDS) {
    const categoryId =
      categorySlug === null
        ? null
        : requireValue(categoryIdBySlug.get(categorySlug), `category "${categorySlug}"`);
    // Upsert on the natural key, so a re-run updates rather than duplicating — and so editing a
    // figure above and reseeding is how a developer changes one.
    await repository.upsert({ ...seed, categoryId }, ['code']);
  }

  return COUPON_SEEDS.length;
}
