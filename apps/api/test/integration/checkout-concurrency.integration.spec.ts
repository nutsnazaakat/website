import { randomBytes } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { DomainError } from '../../src/common/errors/domain-error';
import { CouponRedemption } from '../../src/entities/commerce/coupon-redemption.entity';
import { Coupon } from '../../src/entities/commerce/coupon.entity';
import { CouponChannel, CouponScope, CouponType } from '../../src/entities/enums';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedCoupons } from '../../src/database/seeds/coupons.seed';
import { seedPincodes } from '../../src/database/seeds/pincodes.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { seedUsers } from '../../src/database/seeds/users.seed';
import { CartService } from '../../src/modules/cart/cart.service';
import { CheckoutService, type CartOwner } from '../../src/modules/checkout/checkout.service';
import type { PlaceOrderDto } from '../../src/modules/checkout/dto/place-order.dto';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { ORDER_NUMBER_PATTERN } from '../../src/modules/orders/order-number';
import { useIntegrationApp, waitForABlockedWriter } from './helpers';

/**
 * **`CheckoutService` comes from the real `CheckoutModule` now.**
 *
 * These tests were written before it existed, against a `CheckoutProbeModule` that listed the
 * providers by hand and merged itself into `AppModule` through `useIntegrationApp`'s `metadata`
 * parameter. Task 9 built `checkout.module.ts` and registered it in `AppModule`, so the probe became
 * two things at once: redundant, and a **second instance** of every checkout service in the process.
 * It is gone, and `integration.app.get(CheckoutService)` reaches the same instance
 * `POST /checkout/orders` uses. The probe also re-provided `CartReadService` and
 * `CartPricingService` because `CartModule` exported only `CartService`; Task 9 exports all three,
 * which is what makes the production module resolve, so that workaround is gone with it.
 *
 * What these tests still deliberately do **not** do is assert HTTP status codes. `place` throws
 * `DomainError`, and the 201/409 is the `HttpStatus` that error carries plus the controller's
 * mapping. Asserting `error.getStatus()` is asserting the same number one layer down; Task 10
 * re-proves both races over the wire.
 */

/** The pack two customers fight over. ₹299 for 250g, so a won order is ₹299 + GST + shipping. */
const ALMONDS = 'premium-california-almonds';
const CONTESTED_SIZE = '250g';

/** Prefix `4` is seeded serviceable at four days and ₹79, so placement clears the pincode gate. */
const SHIPPING_PINCODE = '400001';

/** What one placement is refused for; the whole point is that exactly one placement sees it. */
const OUT_OF_STOCK = 'OUT_OF_STOCK';

/** What the loser of a redemption race is refused with — `CheckoutService.refuseCoupon`. */
const COUPON_LIMIT_REACHED = 'COUPON_LIMIT_REACHED';

/**
 * What the loser of a **first-order** race is refused with, and deliberately not `refuseCoupon`'s
 * code.
 *
 * `domain-error.ts` keeps the two apart on purpose: `COUPON_LIMIT_REACHED` tells a customer to wait
 * for a limit to reset, and there is no limit here that ever will. Proof F asserts the code and not
 * merely "some 409", because routing this refusal through `refuseCoupon` would be the easy wrong fix
 * and would leave every outcome assertion below passing.
 */
const COUPON_FIRST_ORDER_ONLY = 'COUPON_FIRST_ORDER_ONLY';

/**
 * The seeded coupon whose `usageLimitPerUser` is 1, which is the whole of Proof D's subject.
 *
 * `coupons.seed.ts` used to call that column "redundant against `firstOrderOnly` today … the row's
 * second line of defence", and both halves were wrong: `redeem` re-counted the two usage limits under
 * the lock and did **not** re-check `firstOrderOnly`, so on this row the per-user limit was the *only*
 * thing making one customer's double-click safe. Proof F is the coupon that had neither, and
 * `redeem` now re-checks `firstOrderOnly` under the same lock. The seeded value is still asserted
 * rather than assumed, because Proof D is about that column specifically.
 */
const WELCOME10 = 'WELCOME10';

/**
 * A coupon this file inserts, because **no seeded coupon has a `usageLimit` of 1.** `ALMOND15` is the
 * only seeded row with a total cap and it is 100, and driving that to its last use would mean placing
 * 99 orders first.
 *
 * Scope `ALL` rather than `ALMOND15`'s `CATEGORY`, and that is load-bearing rather than convenient:
 * it lets the two racing baskets hold *different* variants, so the only row they contend on is the
 * coupon. Two baskets over one variant serialise on the `inventory` row instead, and the loser then
 * counts redemptions after the winner has committed — a true answer arrived at by the wrong
 * mechanism. **Measured**: with both baskets on one variant and no gate, `redeem` with its
 * `FOR UPDATE` deleted survives 3/3 runs. With two variants it dies 3/3.
 */
const LAST_ONE = 'LASTONE';

/**
 * A coupon this file inserts, because **no seeded coupon carries `firstOrderOnly` without also
 * carrying `usageLimitPerUser`** — `WELCOME10` has both, and that is exactly why this hole stayed
 * invisible. `WELCOME10`'s per-user limit was the thing refusing the second concurrent placement, so a
 * proof written against it says nothing about `firstOrderOnly` at all.
 *
 * `usageLimit` and `usageLimitPerUser` are both null on this row, so **the only rule that can refuse
 * anything here is the one under test.**
 */
const FIRST_ORDER = 'FIRSTORDER';

/**
 * A coupon this file inserts so that Proof D can race the per-user limit **and nothing else**.
 *
 * It used to race the seeded `WELCOME10`, which was the only seeded row carrying `usageLimitPerUser`.
 * That stopped working the moment `redeem` began re-checking `firstOrderOnly`, because `WELCOME10`
 * carries both rules and the first-order one is checked first — the same precedence `preview` applies,
 * so that the two layers cannot name different reasons for refusing one customer one coupon. Racing
 * `WELCOME10` here would therefore prove Proof F's point a second time under Proof D's name.
 *
 * One rule per row, exactly as `LAST_ONE` isolates the total limit.
 */
const PER_USER = 'ONEPERUSER';

/**
 * The weight Proof F's bulk basket holds, and it has to land in a **priced** tier.
 *
 * `catalog.seed.ts`'s `buildTiers` gives every product five slabs and leaves the open-ended 50kg+ one
 * unpriced, so 50 or more is `QUOTE_REQUIRED` and the placement never reaches a coupon. 25 sits in the
 * priced 25–49kg slab and clears every seeded `moqKg` (10 by default, 5 for one product; the only
 * product seeded at 25 is `quoteOnly` and is excluded by `variantsFor` anyway).
 */
const BULK_KG = 25;

/**
 * A `FOR UPDATE` on the coupon row, as `pg_stat_activity` prints the statement it stopped.
 *
 * Deliberately not pinned to `redeem`'s exact column list: what a proof needs to know is that a
 * checkout was parked **on the coupon row before it counted**, not which columns the lock happened to
 * read. It still refuses the statement a lock-less `redeem` blocks on instead — `INSERT INTO
 * "coupon_redemptions"`, stopped on the `FOR KEY SHARE` lock its foreign key takes against `coupons`,
 * which is a block that happens *after* both counts have already returned zero.
 */
const COUPON_ROW_LOCK = /"coupons"[\s\S]*\bfor update\b/i;

/** The conditional decrement in `CheckoutService.sell`, as a blocked backend reports it. */
const INVENTORY_WRITE = /update\s+"inventory"/i;

/**
 * A blocked statement named, or printed verbatim when it is neither of the two a proof expects.
 *
 * The point is the failure message. `expect(blocked.filter(isCouponLock)).toHaveLength(2)` reports
 * `Received array: []` and tells you nothing about what the backends were *actually* stopped on,
 * which is the only interesting question. Mapping the whole list instead puts the unexpected
 * statement straight into the diff — measured against `redeem` with `FOR UPDATE` deleted, both
 * entries come back as the literal `INSERT INTO "public"."coupon_redemptions"…`, and reading that is
 * how you know the mutant counted first and blocked afterwards, on its own foreign key.
 */
const classifyBlocked = (query: string): string => {
  if (COUPON_ROW_LOCK.test(query)) return 'coupon-row-lock';
  if (INVENTORY_WRITE.test(query)) return 'inventory-decrement';
  return query;
};

interface VariantRow {
  variant_id: string;
  slug: string;
  size: string;
}

/** A placement's result, with a refusal reduced to the three things these proofs assert on. */
type Outcome =
  | { kind: 'placed'; orderNumber: string }
  | { kind: 'refused'; status: number; code: string; names: string[] }
  | { kind: 'failed'; message: string; sqlstate: string | null };

/**
 * One outcome as a single string, so a failing assertion prints *why* a placement was refused.
 *
 * `expect(placed.length).toBe(1)` reports `0 !== 1` and nothing else, which is the least useful
 * possible message for a race: the interesting question is always which refusal fired. Comparing
 * these strings puts the code — or a deadlock's SQLSTATE — straight into the diff.
 */
const summarise = (outcome: Outcome): string => {
  if (outcome.kind === 'placed') return 'placed';
  if (outcome.kind === 'refused') return `refused:${outcome.code}`;
  return `failed:${outcome.sqlstate ?? 'no-sqlstate'}:${outcome.message}`;
};

/**
 * Which item a refusal named, from either refusal path.
 *
 * There are two, and which one fires depends on interleaving — see the Proof A docblock. The
 * decrement's 409 names a `variantId`; the re-validation's names the offending lines by `slug`.
 * Read field by field rather than through `JSON.stringify`, because `details` can carry paise and
 * one raw `BigInt` reaching jest's serialiser destroys the whole file's result set.
 */
function offendingNames(details: Record<string, unknown> | undefined): string[] {
  if (details === undefined) return [];
  const names: string[] = [];
  if (typeof details.variantId === 'string') names.push(details.variantId);
  if (Array.isArray(details.lines)) {
    for (const line of details.lines as { slug?: unknown }[]) {
      if (typeof line.slug === 'string') names.push(line.slug);
    }
  }
  return names;
}

function sqlstateOf(error: unknown): string | null {
  const driver = (error as { driverError?: { code?: unknown } }).driverError;
  return typeof driver?.code === 'string' ? driver.code : null;
}

/** One redemption row beside the order it discounted — the pair the coupon proofs are about. */
interface RedeemedRow {
  orderNumber: string;
  couponCode: string | null;
  userId: string | null;
  redemptionPaise: number;
  orderDiscountPaise: number;
}

/** A write Postgres refused, reduced to the two fields that say *which rule* refused it. */
interface WriteRefusal {
  sqlstate: string | null;
  constraint: string | null;
}

/**
 * The SQLSTATE and the constraint name, read as one object so an assertion can demand both.
 *
 * `constraint` and not the message: `duplicate key value violates unique constraint "…"` is a string
 * a Postgres release is free to reword, and a regex over it is also how a proof ends up accepting the
 * *wrong* violation. The name is the thing under test.
 */
function refusalOf(error: unknown): WriteRefusal {
  const driver = (error as { driverError?: { code?: unknown; constraint?: unknown } }).driverError;
  return {
    sqlstate: typeof driver?.code === 'string' ? driver.code : null,
    constraint: typeof driver?.constraint === 'string' ? driver.constraint : null,
  };
}

describe('checkout under concurrency', () => {
  const integration = useIntegrationApp();

  let checkout: CheckoutService;
  let carts: CartService;
  let inventory: InventoryService;
  let adminId: string;

  beforeEach(async () => {
    await seedSettings(integration.dataSource);
    await seedUsers(integration.dataSource);
    await seedCatalog(integration.dataSource);
    // After `seedCatalog`: `ALMOND15` is scoped to a category, so a `category_id` has to exist.
    await seedCoupons(integration.dataSource);
    await seedPincodes(integration.dataSource);

    checkout = integration.app.get(CheckoutService);
    carts = integration.app.get(CartService);
    inventory = integration.app.get(InventoryService);

    const admins = await integration.dataSource.query<{ id: string }[]>(
      `SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`,
    );
    const admin = admins[0]?.id;
    if (admin === undefined) throw new Error('users.seed did not create an admin to attribute to');
    adminId = admin;
  });

  /**
   * `couponCode` is spread in rather than passed as `undefined`, because `PlaceOrderDto`'s field is
   * optional and `previewCoupon` branches on `=== undefined` — an explicit `couponCode: undefined`
   * behaves the same today and would stop doing so the moment anyone reads the key's presence.
   */
  const dto = (couponCode?: string): PlaceOrderDto => ({
    shipping: {
      fullName: 'Race Tester',
      phone: '9876543210',
      email: 'race@demo.in',
      line1: '1 Contention Lane',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: SHIPPING_PINCODE,
    },
    paymentMethod: 'cod',
    ...(couponCode === undefined ? {} : { couponCode }),
  });

  /** A fresh guest owner, with the token shape `issueGuestToken` produces. */
  const someone = (): CartOwner => ({ guestToken: randomBytes(32).toString('base64url') });

  /**
   * Retail variants of orderable products, ascending by `id` — which is the order the decrement
   * sorts into, so a basket built in this order and one built reversed are the two halves of step 4.
   *
   * `quoteOnly` is excluded and that is not incidental: it is checked before either channel prices
   * anything, so a quote-only product's retail pack is refused `QUOTE_REQUIRED` and the placement
   * never reaches a decrement at all. Measured — `premium-nuts-combo` and the corporate gift box are
   * seeded `quoteOnly`, and the first draft of this test picked one and refused both placements.
   */
  const variantsFor = async (limit: number): Promise<VariantRow[]> =>
    integration.dataSource.query<VariantRow[]>(
      `SELECT v.id AS variant_id, p.slug, v.size
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
        WHERE v.channel = 'RETAIL' AND v."isActive" = true
          AND p."isPublished" = true AND p."quoteOnly" = false
        ORDER BY v.id
        LIMIT $1`,
      [limit],
    );

  const contestedVariantId = async (): Promise<string> => {
    const rows = await integration.dataSource.query<{ variant_id: string }[]>(
      `SELECT i.variant_id
         FROM inventory i
         JOIN product_variants v ON v.id = i.variant_id
         JOIN products p ON p.id = v.product_id
        WHERE p.slug = $1 AND v.size = $2`,
      [ALMONDS, CONTESTED_SIZE],
    );
    const id = rows[0]?.variant_id;
    if (id === undefined) throw new Error(`No inventory row for ${ALMONDS} ${CONTESTED_SIZE}`);
    return id;
  };

  /**
   * Drives stock to `target` **through `InventoryService.adjust`**, never by writing the column.
   *
   * `SUM(inventory_transactions.delta) = inventory.onHand` is asserted by
   * `schema-invariants.integration.spec.ts` and is one of the properties these tests exist to
   * protect, so a fixture that set `onHand` directly would leave the ledger short by the difference
   * and make the invariant assertions below vacuous — they would be measuring the fixture's own
   * breakage rather than placement's correctness.
   */
  const setStock = async (variantId: string, target: number): Promise<void> => {
    const rows = await integration.dataSource.query<{ onHand: number }[]>(
      'SELECT "onHand" FROM inventory WHERE variant_id = $1',
      [variantId],
    );
    const current = rows[0]?.onHand;
    if (current === undefined) throw new Error(`No inventory row for variant ${variantId}`);
    if (current === target) return;

    await inventory.adjust({
      variantId,
      delta: target - current,
      reason: 'Concurrency proof fixture',
      actorUserId: adminId,
    });
  };

  const onHandOf = async (variantId: string): Promise<number> => {
    const rows = await integration.dataSource.query<{ onHand: number }[]>(
      'SELECT "onHand" FROM inventory WHERE variant_id = $1',
      [variantId],
    );
    return Number(rows[0]?.onHand);
  };

  /** `onHand` beside the ledger's own sum, so the invariant is asserted as one comparison. */
  const stockAndLedger = async (variantId: string): Promise<{ onHand: number; ledger: number }> => {
    const rows = await integration.dataSource.query<{ on_hand: number; ledger: number }[]>(
      `SELECT i."onHand" AS on_hand,
              COALESCE((SELECT SUM(t.delta) FROM inventory_transactions t
                         WHERE t.variant_id = i.variant_id), 0)::int AS ledger
         FROM inventory i
        WHERE i.variant_id = $1`,
      [variantId],
    );
    return { onHand: Number(rows[0]?.on_hand), ledger: Number(rows[0]?.ledger) };
  };

  const countRows = async (sql: string, parameters: unknown[] = []): Promise<number> => {
    const rows = await integration.dataSource.query<{ count: string }[]>(sql, parameters);
    return Number(rows[0]?.count);
  };

  const countOrders = (): Promise<number> => countRows('SELECT count(*)::int AS count FROM orders');

  const countSales = (variantId: string): Promise<number> =>
    countRows(
      `SELECT count(*)::int AS count FROM inventory_transactions
        WHERE variant_id = $1 AND type = 'SALE'`,
      [variantId],
    );

  /** A basket holding `lines` in the order given — the order matters to step 4. */
  const basketOf = async (
    owner: CartOwner,
    lines: readonly { slug: string; size: string; qty: number }[],
  ): Promise<void> => {
    await carts.replace(owner, {
      lines: lines.map((line) => ({ ...line, mode: 'retail' as const })),
    });
  };

  /**
   * A basket of one **bulk** line — priced per kg off the tier ladder, and **variant-bound to nothing**.
   *
   * Which is the only reason it is here. Proof F needs two concurrent placements by *one signed-in
   * customer*, and a signed-in customer has exactly one cart (`CartService.find` looks a user up by
   * `userId`), so both placements necessarily read the same basket — the trick Proof C uses to keep the
   * placements off a shared `inventory` row, two different variants, is not available. A bulk line
   * closes the gap from the other end: `decrementStock` skips it because there is no `inventory` row to
   * decrement, so the two placements touch **no** stock row at all and the coupon is the only thing
   * either of them can queue on. Proof F asserts that mechanically, by counting `SALE` rows.
   */
  const bulkBasketOf = async (
    owner: CartOwner,
    line: { slug: string; kg: number; qty: number },
  ): Promise<void> => {
    await carts.replace(owner, { lines: [{ ...line, mode: 'bulk' as const }] });
  };

  /**
   * One placement, its outcome captured rather than thrown.
   *
   * A `DomainError` is a business refusal and is what a proof asserts on. Anything else — a deadlock
   * arriving as `QueryFailedError` with SQLSTATE `40P01`, say — is captured too rather than crashing
   * the test, because step 4's whole subject is whether such a thing can happen.
   */
  const place = async (owner: CartOwner, couponCode?: string): Promise<Outcome> => {
    try {
      const order = await checkout.place(owner, dto(couponCode), undefined);
      return { kind: 'placed', orderNumber: order.orderNumber };
    } catch (error) {
      if (error instanceof DomainError) {
        return {
          kind: 'refused',
          status: error.getStatus(),
          code: error.code,
          names: offendingNames(error.details),
        };
      }
      return {
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
        sqlstate: sqlstateOf(error),
      };
    }
  };

  /**
   * Blocks until `count` backends are waiting on a lock, and answers with the statements they are
   * stopped in.
   *
   * `waitForABlockedWriter` returns as soon as **one** backend is blocked, which is all Proof B needs
   * — it has one placement. The coupon proofs have two, and the property they turn on is that *both*
   * checkouts are past their `preview` and holding a count of zero before either can write. Releasing
   * the gate while the second is still pricing its basket would let it count after the winner
   * committed, which is a correct answer reached without the lock — precisely the mutant this is
   * meant to catch.
   *
   * On timeout it answers with whatever is blocked rather than throwing, so the assertion prints the
   * statements that *were* stopped. The shared helper still throws when nothing at all blocks, and
   * its message — "the race was not set up" — is the right report for that case.
   */
  const waitForBlockedWriters = async (count: number, timeoutMs = 15_000): Promise<string[]> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const blocked = await waitForABlockedWriter(integration.dataSource);
      const queries = blocked.map((writer) => writer.query);
      if (queries.length >= count || Date.now() > deadline) return queries;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  /** A seeded coupon's id and its two limits, so a proof races the row rather than a hoped-for code. */
  const couponRow = async (
    code: string,
  ): Promise<{ id: string; usageLimit: number | null; usageLimitPerUser: number | null }> => {
    const rows = await integration.dataSource.query<
      { id: string; usageLimit: number | null; usageLimitPerUser: number | null }[]
    >('SELECT id, "usageLimit", "usageLimitPerUser" FROM coupons WHERE code = $1', [code]);
    const row = rows[0];
    if (row === undefined) throw new Error(`coupons.seed did not create ${code}`);
    return row;
  };

  /**
   * One coupon in the shape a proof needs — see `LAST_ONE` and `FIRST_ORDER` for why neither shape can
   * be seeded. Every other column is spelled out.
   *
   * `firstOrderOnly` is a required field rather than an optional one with a default: a proof about the
   * usage limits and a proof about the first-order rule must each say which coupon they are racing, and
   * a default is how one of them ends up silently being about the other.
   */
  const insertCoupon = async (shape: {
    code: string;
    usageLimit: number | null;
    usageLimitPerUser: number | null;
    firstOrderOnly: boolean;
  }): Promise<string> => {
    const saved = await integration.dataSource.getRepository(Coupon).save({
      type: CouponType.PERCENT,
      // `numeric(5,2)`, and a string in as well as out — same as `coupons.seed.ts`.
      percentValue: '10.00',
      flatValuePaise: null,
      minOrderValuePaise: null,
      // Uncapped, so the discount is unmistakably non-zero on a basket of any size.
      maxDiscountPaise: null,
      appliesTo: CouponScope.ALL,
      categoryId: null,
      channel: CouponChannel.ALL,
      startsAt: null,
      expiresAt: null,
      isActive: true,
      ...shape,
    });
    return saved.id;
  };

  const customerUserId = async (): Promise<string> => {
    const rows = await integration.dataSource.query<{ id: string }[]>(
      `SELECT id FROM users WHERE email = 'b2c@demo.in'`,
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('users.seed did not create the b2c customer');
    return id;
  };

  const countRedemptions = (couponId: string): Promise<number> =>
    countRows('SELECT count(*)::int AS count FROM coupon_redemptions WHERE coupon_id = $1', [
      couponId,
    ]);

  const countSaleRows = (): Promise<number> =>
    countRows(`SELECT count(*)::int AS count FROM inventory_transactions WHERE type = 'SALE'`);

  /**
   * Every redemption joined to the order it discounted.
   *
   * Read as `::text` and converted with `Number` rather than as a bigint: the intent is "the discount
   * this order carries", a plain number is what reads in a diff, and every basket in this file is a
   * few hundred rupees — nowhere near `Number.MAX_SAFE_INTEGER` paise.
   */
  const redeemed = async (): Promise<RedeemedRow[]> => {
    const rows = await integration.dataSource.query<
      {
        order_number: string;
        coupon_code: string | null;
        user_id: string | null;
        redemption_paise: string;
        order_discount_paise: string;
      }[]
    >(
      `SELECT o."orderNumber"           AS order_number,
              o."couponCode"            AS coupon_code,
              r.user_id                 AS user_id,
              r."discountPaise"::text   AS redemption_paise,
              o."discountPaise"::text   AS order_discount_paise
         FROM coupon_redemptions r
         JOIN orders o ON o.id = r.order_id
        ORDER BY o."orderNumber"`,
    );
    return rows.map((row) => ({
      orderNumber: row.order_number,
      couponCode: row.coupon_code,
      userId: row.user_id,
      redemptionPaise: Number(row.redemption_paise),
      orderDiscountPaise: Number(row.order_discount_paise),
    }));
  };

  /** The first two orderable retail variants, ascending by id — two rows, so two `inventory` rows. */
  const twoVariants = async (): Promise<[VariantRow, VariantRow]> => {
    const rows = await variantsFor(2);
    const [first, second] = rows;
    if (first === undefined || second === undefined) {
      throw new Error('catalog.seed produced fewer than two orderable retail variants');
    }
    return [first, second];
  };

  const oneVariant = async (): Promise<VariantRow> => (await twoVariants())[0];

  /**
   * **Proof A — the outcome.** One bag, two customers, one order and one clear rejection.
   *
   * Ordered as the task specifies, because the order of the failures tells you *how* it broke: the
   * response pair first, then the order count, then the stock, then the ledger. `onHand` is asserted
   * to be `0` rather than merely "not 1" because `-1` is what overselling looks like — and
   * `ck_inventory_non_negative` should have made `-1` unreachable, so if it ever appears two
   * independent guards have failed and that is worth knowing from the assertion that fires.
   *
   * **Which refusal path fires is not determined, and the assertion says so on purpose.** Both
   * placements read the basket at the top of their own transaction, so the usual interleaving has
   * both see `onHand = 1`, both clear `verdictFor`, and the loser is refused by the conditional
   * `UPDATE` in `sell` — `details.variantId`. But nothing forces that: if the winner commits before
   * the loser reads its cart, the loser is refused earlier by `refuseBrokenLines`, whose details name
   * the offending lines by `slug`. Both are `409 OUT_OF_STOCK` and both name the pack, which is what
   * this asserts. Pinning one path would make this test a timing detector rather than a correctness
   * one — and **it is Proof B, not this test, that pins the mechanism.**
   */
  it('sells the last bag exactly once when two customers place at the same moment', async () => {
    const variantId = await contestedVariantId();
    await setStock(variantId, 1);

    const first = someone();
    const second = someone();
    const line = { slug: ALMONDS, size: CONTESTED_SIZE, qty: 1 };
    await basketOf(first, [line]);
    await basketOf(second, [line]);

    const outcomes = await Promise.all([place(first), place(second)]);

    const placed = outcomes.filter((outcome) => outcome.kind === 'placed');
    const refused = outcomes.filter((outcome) => outcome.kind === 'refused');
    // Compared as strings so a failure names the refusal rather than only counting it. Sorted
    // because which of the two placements wins is exactly what is not determined.
    expect(outcomes.map(summarise).sort()).toEqual(['placed', `refused:${OUT_OF_STOCK}`]);

    const winner = placed[0];
    // Never a literal number: `cleanDatabase`'s `TRUNCATE ... RESTART IDENTITY` cannot reset
    // `order_number_seq`, which no table owns, so values carry across tests and runs.
    expect(winner?.kind === 'placed' && winner.orderNumber).toEqual(
      expect.stringMatching(ORDER_NUMBER_PATTERN),
    );

    const loser = refused[0];
    expect(loser).toMatchObject({ status: HttpStatus.CONFLICT, code: OUT_OF_STOCK });
    // The refusal names what to fix. A bare "out of stock" on a ten-line basket is unactionable.
    const named = loser?.kind === 'refused' ? loser.names : [];
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((name) => name === variantId || name === ALMONDS)).toBe(true);

    expect(await countOrders()).toBe(1);
    // 0, not -1. -1 is overselling, and it would mean the check constraint failed too.
    expect(await onHandOf(variantId)).toBe(0);
    const { onHand, ledger } = await stockAndLedger(variantId);
    expect(ledger).toBe(onHand);
    // One order, one movement. Two SALE rows against one decrement is how the ledger drifts.
    expect(await countSales(variantId)).toBe(1);
  });

  /**
   * **Proof B — the mechanism.** That the `WHERE` is re-evaluated against the *committed* value.
   *
   * Proof A can pass by luck; this cannot. `Promise.all` of two placements is not a reliable
   * collision — Plan 2's Task 23 measured the same shape catching a read-then-write mutant 3/3 on a
   * cold single-test run and **0/2 on a warm full-suite run**, because each request finished before
   * the next one's write was dispatched. So this test owns the timing rather than hoping for it.
   *
   * A rival connection takes the inventory row `FOR UPDATE` and holds it. Placement runs, clears
   * validation against `onHand = 1` — the value it can see — and then blocks inside its conditional
   * `UPDATE`. **The rival is not released until `pg_stat_activity` reports a backend genuinely
   * waiting on a lock, and the blocked statement is asserted to be the inventory update**, so this
   * cannot pass on a placement that was merely slow. Only then does the rival take the stock to zero
   * and commit.
   *
   * A single conditional `UPDATE` then re-evaluates its predicate against the committed `0`, matches
   * nothing, and fails the placement. A read-then-write implementation applies the decision it made
   * against the stale `1` and oversells. Committing the rival early would let read-then-write see the
   * committed value too and the test would pass for the wrong reason — which is the exact failure
   * mode it exists to rule out.
   */
  it('re-evaluates the decrement against a value committed while it was blocked', async () => {
    const variantId = await contestedVariantId();
    await setStock(variantId, 1);

    const owner = someone();
    await basketOf(owner, [{ slug: ALMONDS, size: CONTESTED_SIZE, qty: 1 }]);

    const rival = integration.dataSource.createQueryRunner();
    let outcome: Outcome;
    let blockedOn: string[] = [];

    try {
      await rival.connect();
      await rival.startTransaction();
      await rival.query('SELECT "onHand" FROM inventory WHERE variant_id = $1 FOR UPDATE', [
        variantId,
      ]);

      const inFlight = place(owner);

      const blocked = await waitForABlockedWriter(integration.dataSource);
      blockedOn = blocked.map((writer) => writer.query);

      /**
       * The rival's own write goes through the ledger too — a bare column write here would break
       * `SUM(delta) = onHand` and make the invariant assertion at the end of this test vacuous. One
       * statement pair in the rival's transaction, so placement sees both or neither.
       */
      await rival.query(
        `UPDATE inventory SET "onHand" = 0, "updatedAt" = now() WHERE variant_id = $1`,
        [variantId],
      );
      await rival.query(
        `INSERT INTO inventory_transactions
           (variant_id, delta, type, reason, "balanceAfter")
         VALUES ($1, -1, 'ADJUSTMENT', 'Rival took the last bag', 0)`,
        [variantId],
      );
      await rival.commitTransaction();

      outcome = await inFlight;
    } finally {
      if (rival.isTransactionActive) await rival.rollbackTransaction();
      await rival.release();
    }

    // The evidence that this test is deterministic rather than lucky: a backend really was stopped,
    // and it was stopped inside the decrement.
    expect(blockedOn.some((query) => INVENTORY_WRITE.test(query))).toBe(true);

    /**
     * Compared as a string, so a failure names the mechanism instead of only the shape. Measured
     * against the read-then-write mutant, this line prints
     * `failed:23514:new row for relation "inventory" violates check constraint
     * "ck_inventory_non_negative"` — the mutant applies the decision it made against the stale `1`,
     * and `ck_inventory_non_negative` is what finally stops the oversell, as a 500 rather than as a
     * refusal anyone can act on.
     */
    expect(summarise(outcome)).toBe(`refused:${OUT_OF_STOCK}`);
    expect(outcome.kind === 'refused' ? outcome.status : null).toBe(HttpStatus.CONFLICT);

    // The rival's value, untouched by a decrement that should not have happened.
    expect(await onHandOf(variantId)).toBe(0);
    // Rolled back whole: no order, no SALE row, and the ledger still explains the stock exactly.
    expect(await countOrders()).toBe(0);
    expect(await countSales(variantId)).toBe(0);
    const { onHand, ledger } = await stockAndLedger(variantId);
    expect(ledger).toBe(onHand);
  });

  /**
   * **Step 4 — the ascending-`variantId` ordering, with two live connections.**
   *
   * Task 5 and Task 6 both order their line operations by ascending `variantId`, and both pin the
   * *sequence* single-threaded, which is all a repository double can see. The reason for the ordering
   * is not visible there at all: two transactions touching the same rows in opposite orders is the
   * textbook deadlock, and Postgres resolves it by killing one with SQLSTATE `40P01` — which reaches
   * the customer as a 500 rather than as any kind of clear rejection.
   *
   * So: two baskets over the same six variants, one built in ascending order and one built reversed,
   * placed together. Sorted, both decrement ascending, the second waits for the first, and both
   * succeed. The assertion is the negative — **no placement failed, and nothing said `deadlock
   * detected`** — because a deadlock is not a refusal this code can shape.
   *
   * Stock is left at the seeded opening figure, so nothing here can be refused for stock; the only
   * thing that can go wrong is the interleaving.
   */
  it('does not deadlock when two orders cover the same variants in opposite basket order', async () => {
    const variants = await variantsFor(6);
    expect(variants).toHaveLength(6);

    const ascending = variants.map((row) => ({ slug: row.slug, size: row.size, qty: 1 }));
    const descending = [...ascending].reverse();

    const first = someone();
    const second = someone();
    await basketOf(first, ascending);
    await basketOf(second, descending);

    const outcomes = await Promise.all([place(first), place(second)]);

    // The whole pair at once: a deadlock shows up in this diff as `failed:40P01:...`, which is the
    // failure this ordering exists to prevent and is not a shape the service can turn into a refusal.
    expect(outcomes.map(summarise)).toEqual(['placed', 'placed']);
    for (const outcome of outcomes) {
      expect(outcome.kind === 'failed' ? outcome.message : '').not.toMatch(/deadlock detected/i);
      expect(outcome.kind === 'failed' ? outcome.sqlstate : null).not.toBe('40P01');
    }
    const numbers = outcomes.map((outcome) =>
      outcome.kind === 'placed' ? outcome.orderNumber : '',
    );
    // Two orders, two references. `nextval` is what makes that true under concurrency.
    expect(new Set(numbers).size).toBe(2);
    for (const number of numbers) expect(number).toMatch(ORDER_NUMBER_PATTERN);

    expect(await countOrders()).toBe(2);
    for (const row of variants) {
      const { onHand, ledger } = await stockAndLedger(row.variant_id);
      expect(ledger).toBe(onHand);
      expect(await countSales(row.variant_id)).toBe(2);
    }
  });

  /**
   * **Proof C — the coupon limit holds under a race**, and it holds because of the lock's *position*.
   *
   * §10.2's reason for treating coupons differently from stock: the condition cannot live inside the
   * writing statement, because the count is over a different table. So the safety is the
   * `SELECT … FOR UPDATE` taken **before** the count, and this test's only job is to make two
   * checkouts arrive at that count with a stale zero and prove exactly one of them gets the use.
   *
   * **The gate is a starting line, not a value.** Proof B's rival exists to commit a number the
   * placement must re-read; releasing it early would let a read-then-write implementation pass. Here
   * the two placements supply each other's number, and the gate exists only so that neither can
   * commit before both have counted. That is why it **rolls back** rather than committing: it changes
   * nothing, and if it did, it would be answering the question instead of asking it.
   *
   * Two things make it deterministic rather than lucky:
   *
   * - The baskets hold **different variants**, so the placements do not serialise on an `inventory`
   *   row. Sharing one would queue the loser behind the winner's commit, and its count would then see
   *   the winner's row whether or not any lock was taken — a pass that proves nothing.
   * - The gate is not released until **two** backends are reported blocked *on the coupon row*. Both
   *   have therefore passed `previewCoupon` — which counted zero, on its own connection, outside this
   *   transaction — and neither has written.
   *
   * Measured, 3 runs per mutation: the `FOR UPDATE` deleted, 3/3, and it is the blocked-statement
   * assertion that fires — both placements come back stopped inside their own `INSERT INTO
   * "coupon_redemptions"`, having already counted zero. The lock moved to *after* both counts, 3/3,
   * and this time the block is genuinely on the coupon row, so it is the outcome that gives it away:
   * `["placed", "placed"]` against a limit of one. The `usageLimit` block deleted, 3/3, the same way.
   */
  it('redeems the last use of a limited coupon exactly once when two checkouts race', async () => {
    const couponId = await insertCoupon({
      code: LAST_ONE,
      usageLimit: 1,
      usageLimitPerUser: null,
      firstOrderOnly: false,
    });
    const [firstVariant, secondVariant] = await twoVariants();

    const first = someone();
    const second = someone();
    await basketOf(first, [{ slug: firstVariant.slug, size: firstVariant.size, qty: 1 }]);
    await basketOf(second, [{ slug: secondVariant.slug, size: secondVariant.size, qty: 1 }]);

    const gate = integration.dataSource.createQueryRunner();
    let outcomes: Outcome[];
    let blockedOn: string[] = [];

    try {
      await gate.connect();
      await gate.startTransaction();
      await gate.query('SELECT id FROM "coupons" WHERE id = $1 FOR UPDATE', [couponId]);

      const inFlight = [place(first, LAST_ONE), place(second, LAST_ONE)];

      blockedOn = await waitForBlockedWriters(2);
      // Nothing to commit. The gate held the line; the placements decide the outcome between them.
      await gate.rollbackTransaction();

      outcomes = await Promise.all(inFlight);
    } finally {
      if (gate.isTransactionActive) await gate.rollbackTransaction();
      await gate.release();
    }

    // The evidence that both checkouts were stopped *before* they counted, which is the mechanism.
    expect(blockedOn.map(classifyBlocked).sort()).toEqual(['coupon-row-lock', 'coupon-row-lock']);

    expect(outcomes.map(summarise).sort()).toEqual(['placed', `refused:${COUPON_LIMIT_REACHED}`]);
    const loser = outcomes.find((outcome) => outcome.kind === 'refused');
    // 409, not 422: the coupon was genuinely valid when it was applied — `refuseCoupon`'s reasoning.
    expect(loser?.kind === 'refused' ? loser.status : null).toBe(HttpStatus.CONFLICT);

    // The refused placement rolled back whole, coupon and stock and order together.
    expect(await countOrders()).toBe(1);
    expect(await countRedemptions(couponId)).toBe(1);
    expect(await countSaleRows()).toBe(1);

    const rows = await redeemed();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    // Never a literal order number — `order_number_seq` survives `TRUNCATE … RESTART IDENTITY`.
    expect(row?.orderNumber).toEqual(expect.stringMatching(ORDER_NUMBER_PATTERN));
    // One order carries the discount, and the redemption row records the same figure the order does.
    expect(row?.couponCode).toBe(LAST_ONE);
    expect(row?.redemptionPaise).toBeGreaterThan(0);
    expect(row?.redemptionPaise).toBe(row?.orderDiscountPaise);

    for (const variant of [firstVariant, secondVariant]) {
      const { onHand, ledger } = await stockAndLedger(variant.variant_id);
      expect(ledger).toBe(onHand);
    }
  });

  /**
   * **Proof D — the per-user limit holds**, for one customer placing twice at once.
   *
   * The same gate, and one difference that is forced rather than chosen: a signed-in customer has
   * exactly **one** cart (`CartService.find` looks a user up by `userId`), so both placements read the
   * same basket and therefore contend on the same `inventory` row. The loser is thus queued twice —
   * behind the winner's decrement, and then behind the coupon row — and the blocked pair asserted
   * below is one backend on each, which is the shape that says both were in flight together.
   *
   * What still makes this a proof of `redeem` rather than of the inventory lock is *where the counts
   * were taken*: both placements ran `previewCoupon` before either wrote anything, and preview
   * answered "no redemptions, no orders" to both. The refusal therefore comes from the re-count under
   * the lock and from nowhere else — `preview`'s answer was already stale when it was given.
   *
   * The coupon raced is an inserted row carrying **only** the per-user limit — see `PER_USER` for why
   * the seeded `WELCOME10` can no longer be the subject of this test. `WELCOME10`'s shape is still
   * asserted, because `coupons.seed.ts` keeps that column as the backstop for the day an admin unticks
   * `firstOrderOnly`, and an edit removing it should fail in the test about that column.
   */
  it('refuses one customer a second use of a per-user-limited coupon', async () => {
    const seeded = await couponRow(WELCOME10);
    expect({ limit: seeded.usageLimit, perUser: seeded.usageLimitPerUser }).toEqual({
      limit: null,
      perUser: 1,
    });

    const couponId = await insertCoupon({
      code: PER_USER,
      usageLimit: null,
      usageLimitPerUser: 1,
      firstOrderOnly: false,
    });

    const userId = await customerUserId();
    const owner: CartOwner = { userId };
    const variant = await oneVariant();
    await basketOf(owner, [{ slug: variant.slug, size: variant.size, qty: 1 }]);

    const gate = integration.dataSource.createQueryRunner();
    let outcomes: Outcome[];
    let blockedOn: string[] = [];

    try {
      await gate.connect();
      await gate.startTransaction();
      await gate.query('SELECT id FROM "coupons" WHERE id = $1 FOR UPDATE', [couponId]);

      const inFlight = [place(owner, PER_USER), place(owner, PER_USER)];

      blockedOn = await waitForBlockedWriters(2);
      await gate.rollbackTransaction();

      outcomes = await Promise.all(inFlight);
    } finally {
      if (gate.isTransactionActive) await gate.rollbackTransaction();
      await gate.release();
    }

    // One placement parked on the coupon row, the other behind its decrement: both are past preview.
    expect(blockedOn.map(classifyBlocked).sort()).toEqual([
      'coupon-row-lock',
      'inventory-decrement',
    ]);

    expect(outcomes.map(summarise).sort()).toEqual(['placed', `refused:${COUPON_LIMIT_REACHED}`]);
    expect(await countOrders()).toBe(1);
    expect(await countRedemptions(couponId)).toBe(1);

    const rows = await redeemed();
    expect(rows).toHaveLength(1);
    // The per-user part: the surviving redemption is attributed to the customer it counted against.
    // A null here would mean the count that refused the second placement could never find the first.
    expect(rows[0]?.userId).toBe(userId);
    expect(rows[0]?.couponCode).toBe(PER_USER);
    expect(rows[0]?.redemptionPaise).toBeGreaterThan(0);
  });

  /**
   * **Proof E — the backstop, by name.**
   *
   * `uq_coupon_redemptions_coupon_order` stops the **same order** redeeming a coupon twice. It does
   * not stop two different orders exceeding `usageLimit` — that is Proof C's lock — and conflating the
   * two is how "we have a unique constraint" ends with a coupon redeemed 400 times against a limit of
   * 100.
   *
   * The first row is written by `redeem` itself rather than by hand, so what the constraint is shown
   * to refuse is production's own row. The second is a direct insert, differing in `discountPaise`,
   * because the constraint is on the pair and a duplicate that differs everywhere else must still be
   * refused.
   *
   * **The SQLSTATE and the constraint name are asserted together, as one object.** An insert here can
   * fail for more than one reason — `coupon_id` carries a `RESTRICT` foreign key to `coupons`, so a
   * bad id gives `23503` and a *different* constraint name — and a proof that accepts any failure
   * passes with the constraint it cares about absent. That trap has been paid for twice on this
   * project. Note that `order_id` has **no** foreign key, which is why this uses a real order id from
   * the redemption `redeem` just wrote rather than trusting a fabricated one to be refused.
   */
  it('refuses a second redemption of one coupon against the same order, by constraint name', async () => {
    const coupon = await couponRow(WELCOME10);
    // A guest, deliberately: `preview` treats a null `userId` as a first order and skips the per-user
    // count, so `WELCOME10` is redeemable here and the row lands with `user_id` null.
    const owner = someone();
    const variant = await oneVariant();
    await basketOf(owner, [{ slug: variant.slug, size: variant.size, qty: 1 }]);

    expect(summarise(await place(owner, WELCOME10))).toBe('placed');
    expect(await countRedemptions(coupon.id)).toBe(1);

    const written = await integration.dataSource.query<{ order_id: string }[]>(
      'SELECT order_id FROM coupon_redemptions WHERE coupon_id = $1',
      [coupon.id],
    );
    const orderId = written[0]?.order_id;
    if (orderId === undefined) throw new Error('redeem wrote no redemption to duplicate');

    let refusal: WriteRefusal = { sqlstate: null, constraint: null };
    try {
      await integration.dataSource.getRepository(CouponRedemption).insert({
        couponId: coupon.id,
        userId: null,
        orderId,
        discountPaise: 1n,
      });
    } catch (error) {
      refusal = refusalOf(error);
    }

    // Both fields, exactly. `{ sqlstate: null, constraint: null }` is what an accepted duplicate
    // prints here, which is the mutant's signature.
    expect(refusal).toEqual({
      sqlstate: '23505',
      constraint: 'uq_coupon_redemptions_coupon_order',
    });
    expect(await countRedemptions(coupon.id)).toBe(1);
  });

  /**
   * **Proof F — `firstOrderOnly` holds under a race**, which for a long time it did not.
   *
   * The rule was validated only by `CouponService.preview`, on its own connection and outside any
   * transaction, and `redeem` re-counted the two usage limits and nothing else. So a coupon carrying
   * `firstOrderOnly` with a null `usageLimitPerUser` — a shape no seeded row has, which is exactly why
   * nobody noticed — could be **discounted twice for one customer from a double-click**: both previews
   * found no prior order, and the column was never read again. `WELCOME10` survived only because its
   * per-user limit happened to refuse the second placement, which is a different rule doing this one's
   * job.
   *
   * The gate is Proof C's, used the same way: it holds the coupon row so that neither placement can
   * write before both have been through `previewCoupon` holding a stale "no orders yet", and it **rolls
   * back**, because a gate that changed anything would be answering the question instead of asking it.
   *
   * Three things make it a proof of `redeem` rather than of anything else:
   *
   * - The coupon has **no usage limit and no per-user limit**, so the only rule in `redeem` that can
   *   refuse either placement is the one under test. A refusal here cannot be `COUPON_LIMIT_REACHED`
   *   wearing a different name, and the code is asserted so that routing this through `refuseCoupon`
   *   would fail rather than pass.
   * - The placements contend on **no `inventory` row whatsoever** — see `bulkBasketOf` for why a bulk
   *   basket rather than Proof C's two variants, which one signed-in customer's single cart rules out.
   *   Sharing a stock row would queue the loser behind the winner's commit and its count would then see
   *   the winner's order whether or not any lock was taken: a pass that proves nothing. `countSaleRows`
   *   is asserted to be 0 so that "no stock row was touched" is measured rather than argued.
   * - The gate is not released until **two** backends are reported blocked *on the coupon row*, so both
   *   are past their preview and neither has committed.
   *
   * Measured, 3 runs per mutation. The whole `firstOrderOnly` block deleted from `redeem`, 3/3 — both
   * placements come back `placed` against one first order. The `Not(input.orderId)` exclusion widened
   * to count every order of the customer's, 3/3 in the opposite direction, with Proof G saying what
   * went wrong in one line. And the `FOR UPDATE` deleted, 3/3 — the blocked-statement assertion is what
   * fires, printing both backends stopped inside their own `INSERT INTO "coupon_redemptions"` on the
   * foreign key's `FOR KEY SHARE`, which is a block that happens *after* both counts have returned
   * zero. That last one is the whole reason this basket holds no stock line: on a shared `inventory`
   * row the loser would have queued behind the winner's commit and counted a committed order without
   * any coupon lock being involved, and the mutant would have lived.
   */
  it('refuses one customer a second use of a first-order-only coupon', async () => {
    const couponId = await insertCoupon({
      code: FIRST_ORDER,
      usageLimit: null,
      usageLimitPerUser: null,
      firstOrderOnly: true,
    });

    const userId = await customerUserId();
    const owner: CartOwner = { userId };
    const variant = await oneVariant();
    await bulkBasketOf(owner, { slug: variant.slug, kg: BULK_KG, qty: 1 });

    const gate = integration.dataSource.createQueryRunner();
    let outcomes: Outcome[];
    let blockedOn: string[] = [];

    try {
      await gate.connect();
      await gate.startTransaction();
      await gate.query('SELECT id FROM "coupons" WHERE id = $1 FOR UPDATE', [couponId]);

      const inFlight = [place(owner, FIRST_ORDER), place(owner, FIRST_ORDER)];

      blockedOn = await waitForBlockedWriters(2);
      // Nothing to commit — the gate held the line, the placements decide the outcome between them.
      await gate.rollbackTransaction();

      outcomes = await Promise.all(inFlight);
    } finally {
      if (gate.isTransactionActive) await gate.rollbackTransaction();
      await gate.release();
    }

    // Both checkouts stopped on the coupon row, and neither on a stock row: the mechanism, and the
    // evidence that this is not Proof D's inventory queue passing under a new name.
    expect(blockedOn.map(classifyBlocked).sort()).toEqual(['coupon-row-lock', 'coupon-row-lock']);

    // Compared as strings so a failure names the refusal. `['placed', 'placed']` is the missing
    // re-check; `refused:COUPON_LIMIT_REACHED` would be the refusal routed through the wrong helper.
    expect(outcomes.map(summarise).sort()).toEqual([
      'placed',
      `refused:${COUPON_FIRST_ORDER_ONLY}`,
    ]);
    const loser = outcomes.find((outcome) => outcome.kind === 'refused');
    // 409, not 422: the coupon really was theirs to use when they applied it. Their own other order
    // took it, one moment earlier.
    expect(loser?.kind === 'refused' ? loser.status : null).toBe(HttpStatus.CONFLICT);

    // The refused placement rolled back whole — order, redemption and all.
    expect(await countOrders()).toBe(1);
    expect(await countRedemptions(couponId)).toBe(1);
    // A bulk line is variant-bound to nothing, so a single `SALE` row here would mean the two
    // placements had an `inventory` row to serialise on after all and the proof above was luck.
    expect(await countSaleRows()).toBe(0);

    const rows = await redeemed();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.orderNumber).toEqual(expect.stringMatching(ORDER_NUMBER_PATTERN));
    expect(row?.couponCode).toBe(FIRST_ORDER);
    // Attributed to the customer it was counted against. A null here would mean the count that
    // refused the second placement could never have found the first.
    expect(row?.userId).toBe(userId);
    expect(row?.redemptionPaise).toBeGreaterThan(0);
    expect(row?.redemptionPaise).toBe(row?.orderDiscountPaise);
  });

  /**
   * **Proof G — the exclusion is load-bearing, in both directions.**
   *
   * `redeem` is called *after* the order row is saved, so the customer's own in-flight order is already
   * visible to the count it takes. The obvious re-check — "does this customer have any orders?" —
   * therefore refuses **every** first-order redemption there has ever been, which is a failure Proof F
   * cannot see: a rule that refuses everything also refuses the second placement, and Proof F's
   * outcome assertion would read `['refused', 'refused']` only by accident of it also having a winner.
   *
   * So this is the same coupon placed **once**, by a signed-in customer with no history, and it must be
   * discounted. Then a second placement, sequentially, which must not be — and that half is the guard
   * against the opposite trivial fix, a check that always passes. Note the second order is still
   * **placed**: `previewCoupon` discards a refused coupon rather than failing the order, so a returning
   * customer loses the discount and not their basket.
   *
   * No gate and no race here on purpose. This is the ordinary path, and the ordinary path is what the
   * exclusion is for.
   */
  it('discounts a genuine first order and then refuses the same customer the discount again', async () => {
    const couponId = await insertCoupon({
      code: FIRST_ORDER,
      usageLimit: null,
      usageLimitPerUser: null,
      firstOrderOnly: true,
    });

    const userId = await customerUserId();
    const owner: CartOwner = { userId };
    const variant = await oneVariant();
    await basketOf(owner, [{ slug: variant.slug, size: variant.size, qty: 1 }]);

    // The whole of the exclusion: this placement's own order exists by the time `redeem` counts.
    expect(summarise(await place(owner, FIRST_ORDER))).toBe('placed');

    const first = await redeemed();
    expect(first).toHaveLength(1);
    expect(first[0]?.couponCode).toBe(FIRST_ORDER);
    expect(first[0]?.userId).toBe(userId);
    expect(first[0]?.redemptionPaise).toBeGreaterThan(0);

    // The cart was emptied by the placement, so the second order needs its own basket.
    await basketOf(owner, [{ slug: variant.slug, size: variant.size, qty: 1 }]);
    expect(summarise(await place(owner, FIRST_ORDER))).toBe('placed');

    expect(await countOrders()).toBe(2);
    // Refused by `preview` this time, before `redeem` is reached at all — and a refused coupon does not
    // fail the order, it is simply not honoured. Two orders, one discount.
    expect(await countRedemptions(couponId)).toBe(1);
    const both = await redeemed();
    expect(both).toHaveLength(1);
    expect(both.map((redemption) => redemption.couponCode)).toEqual([FIRST_ORDER]);
  });
});
