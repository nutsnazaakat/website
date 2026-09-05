import { HttpStatus } from '@nestjs/common';
import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import {
  B2B_ORDER_STATUSES,
  B2C_ORDER_STATUSES,
  ORDER_NUMBER_PATTERN,
  type AccountOrder,
  type OrderChannel,
  type OrderStatus,
  type PaymentStatus,
} from '@nutwala/shared';
import type { Response, Test } from 'supertest';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedCoupons } from '../../src/database/seeds/coupons.seed';
import { seedOrders } from '../../src/database/seeds/orders.seed';
import { seedPincodes } from '../../src/database/seeds/pincodes.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { seedUsers } from '../../src/database/seeds/users.seed';
import { OrderStatusService } from '../../src/modules/orders/order-status.service';
import {
  agent,
  cookieValue,
  expectError,
  expectSuccess,
  request,
  responseBody,
  useIntegrationApp,
} from './helpers';

/**
 * Cookie and header names spelled out rather than imported, for the reason `cart.integration.
 * spec.ts` and `checkout.integration.spec.ts` both give: they are wire contract, so a rename must
 * break a test here rather than typecheck and leave every client broken.
 */
const CSRF_COOKIE = 'nn_csrf';
const CSRF_HEADER = 'X-CSRF-Token';

const ORDERS = '/api/v1/account/orders';
const CART = '/api/v1/cart';
const PLACE = '/api/v1/checkout/orders';
const LOGIN = '/api/v1/auth/login';

const B2C = 'b2c@demo.in';
const B2B = 'b2b@demo.in';

/**
 * Widened to `number` deliberately — supertest types `Response.status` as `number`, so comparing it
 * against an `HttpStatus` member trips `no-unsafe-enum-comparison`.
 */
const OK: number = HttpStatus.OK;
const CREATED: number = HttpStatus.CREATED;
const BAD_REQUEST: number = HttpStatus.BAD_REQUEST;
const UNAUTHORIZED: number = HttpStatus.UNAUTHORIZED;
const FORBIDDEN: number = HttpStatus.FORBIDDEN;
const NOT_FOUND: number = HttpStatus.NOT_FOUND;
const CONFLICT: number = HttpStatus.CONFLICT;
const UNPROCESSABLE: number = HttpStatus.UNPROCESSABLE_ENTITY;

interface Money {
  subtotal: number;
  discount: number;
  gst: number;
  shipping: number;
  total: number;
}

interface SeededOrder {
  number: string;
  owner: string;
  channel: OrderChannel;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  events: number;
  items: number;
  /** The company block a bulk order carries and a retail one must not. */
  business: { companyName: string; gstin: string; poNumber: string } | null;
  /** `orders`' own five money columns, in paise. */
  paise: Money;
}

/**
 * The seeded fixture, in `placedAt DESC` order — the order `GET /account/orders` must answer in.
 *
 * Every figure here is `orders.seed.ts`'s own arithmetic worked through, not a reading of the
 * database: `unitRupees * 100 * qty` per line, `gstOn(lineTotal, 5)` per line **summed**, plus
 * `shippingRupees * 100`. It is written out rather than derived so that a change to the seeder
 * fails this suite loudly instead of being absorbed by it, and so the paise column and the rupee
 * wire value are pinned from opposite ends — `holds the paise this fixture says it does` compares
 * this table against the columns, and `every money field is rupees` compares the columns against
 * the wire.
 *
 * `NN-2026-004488`'s ₹1,751.25 of GST is the one figure worth looking at twice: it is the only
 * seeded order whose tax is not a whole number of rupees, and it is the whole of disagreement 5 —
 * see the note above `describe('money')`.
 */
const SEEDED: readonly SeededOrder[] = [
  {
    number: 'NN-2026-005107',
    owner: B2C,
    channel: 'retail',
    status: 'out-for-delivery',
    paymentStatus: 'pending',
    events: 6,
    items: 2,
    business: null,
    // makhana 250g x3 @ ₹299 = ₹897 (gst ₹44.85); pistachios 250g x1 @ ₹509 (gst ₹25.45)
    paise: { subtotal: 140_600, discount: 0, gst: 7_030, shipping: 0, total: 147_630 },
  },
  {
    number: 'NN-2026-005042',
    owner: B2B,
    channel: 'bulk',
    status: 'shipped',
    paymentStatus: 'pending',
    events: 7,
    items: 2,
    business: {
      companyName: 'Anand Sweets & Namkeen',
      gstin: '29ABCDE1234F1Z5',
      poNumber: 'ANS/2026/0412',
    },
    // cashews 25kg @ ₹934/kg = ₹23,350 (gst ₹1,167.50); pistachios 10kg @ ₹1,529/kg = ₹15,290
    paise: { subtotal: 3_864_000, discount: 0, gst: 193_200, shipping: 0, total: 4_057_200 },
  },
  {
    number: 'NN-2026-004977',
    owner: B2C,
    channel: 'retail',
    status: 'cancelled',
    paymentStatus: 'pending',
    events: 3,
    items: 1,
    business: null,
    // dates 500g x1 @ ₹659 (gst ₹32.95), plus the ₹79 flat charge
    paise: { subtotal: 65_900, discount: 0, gst: 3_295, shipping: 7_900, total: 77_095 },
  },
  {
    number: 'NN-2026-004821',
    owner: B2C,
    channel: 'retail',
    status: 'delivered',
    paymentStatus: 'collected',
    events: 7,
    items: 2,
    business: null,
    // cashews 500g x2 @ ₹599 = ₹1,198 (gst ₹59.90); almonds 1kg x1 @ ₹999 (gst ₹49.95)
    paise: { subtotal: 219_700, discount: 0, gst: 10_985, shipping: 0, total: 230_685 },
  },
  {
    number: 'NN-2026-004650',
    owner: B2C,
    channel: 'retail',
    status: 'refunded',
    paymentStatus: 'refunded',
    events: 7,
    items: 2,
    business: null,
    // walnuts 500g x1 @ ₹709 (gst ₹35.45); raisins 500g x1 @ ₹269 (gst ₹13.45), plus ₹79
    paise: { subtotal: 97_800, discount: 0, gst: 4_890, shipping: 7_900, total: 110_590 },
  },
  {
    number: 'NN-2026-004488',
    owner: B2B,
    channel: 'bulk',
    status: 'delivered',
    paymentStatus: 'collected',
    events: 8,
    items: 2,
    business: {
      companyName: 'Anand Sweets & Namkeen',
      gstin: '29ABCDE1234F1Z5',
      poNumber: 'ANS/2026/0388',
    },
    // almonds 25kg @ ₹849/kg = ₹21,225 (gst ₹1,061.25); raisins 25kg @ ₹552/kg = ₹13,800 (₹690)
    paise: { subtotal: 3_502_500, discount: 0, gst: 175_125, shipping: 0, total: 3_677_625 },
  },
];

const ownedBy = (email: string): readonly SeededOrder[] =>
  SEEDED.filter((order) => order.owner === email);

const numbersOf = (orders: readonly SeededOrder[]): string[] => orders.map((order) => order.number);

/** The two addresses `orders.seed.ts` snapshots, field for field — `toAddress`'s whole output. */
const RETAIL_ADDRESS = {
  fullName: 'Asha Rao',
  phone: '9876543210',
  email: B2C,
  line1: '12 Residency Road',
  line2: 'Near Mayo Hall',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560025',
};

const BUSINESS_ADDRESS = {
  fullName: 'Rakesh Anand',
  phone: '9845012345',
  email: B2B,
  line1: 'Unit 7, Peenya Industrial Area, Phase II',
  line2: 'Goods entrance on the rear road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560058',
};

/** The whole 14-value vocabulary, from `shared`'s own two tuples. `Set`, because they overlap. */
const EVERY_STATUS = new Set<string>([...B2C_ORDER_STATUSES, ...B2B_ORDER_STATUSES]);

interface Refusal {
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}

function refusalOf(response: Response): Refusal {
  expectError(response);
  return responseBody<Refusal>(response);
}

describe('account orders', () => {
  const integration = useIntegrationApp();

  /**
   * Empties the rate limiter between tests, for the reason `cart.integration.spec.ts:68` records:
   * `useIntegrationApp` boots one application per file, so `ThrottlerGuard`'s in-memory storage is
   * shared, `POST /auth/login` is capped at **five attempts per fifteen minutes per IP**, and every
   * supertest request arrives from 127.0.0.1. This file signs in well over five times — several
   * cases sign in as both customers — so without this the sixth login 429s and the failure lands on
   * whichever test happens to be sixth rather than on anything that test did.
   */
  beforeEach(() => {
    const throttler = integration.app.get<ThrottlerStorageService>(ThrottlerStorage);
    throttler.onApplicationShutdown();
    throttler.storage.clear();
  });

  /**
   * `seedOrders` is the whole fixture, and it needs three seeders ahead of it: `users` for the two
   * customers and the `Business` row every bulk order's `business_id` points at, and `catalog` for
   * the products, variants and HSN codes its lines snapshot — it throws rather than writing a
   * dangling line if either is missing.
   *
   * `settings`, `pincodes` and `coupons` are here for the placement round-trip only. A read-only
   * case needs none of them, and paying for them once per test is cheaper than a second `describe`
   * with its own hooks.
   */
  beforeEach(async () => {
    await seedSettings(integration.dataSource);
    await seedUsers(integration.dataSource);
    await seedCatalog(integration.dataSource);
    await seedCoupons(integration.dataSource);
    await seedPincodes(integration.dataSource);
    await seedOrders(integration.dataSource);
  });

  /** Signs in and returns a cookie-persisting client plus the CSRF token to echo. */
  async function signedIn(email = B2C) {
    const client = agent(integration.app);
    const login = await client.post(LOGIN).send({ email, password: 'Password123!' }).expect(OK);
    return { client, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  }

  /**
   * An anonymous client that already holds `nn_csrf`, plus the token to echo — `cart.integration.
   * spec.ts:101`, and it primes with a `GET` for the reason recorded there: `CsrfBootstrapMiddleware`
   * sets the cookie on the **response**, so a brand-new client's first write can never satisfy the
   * global `CsrfGuard`.
   *
   * Used here only to prove that carrying a guest token is not an identity: every read in this file
   * is authenticated.
   */
  async function guest() {
    const client = agent(integration.app);
    const primer = await client.get(CART).expect(OK);
    return { client, csrf: cookieValue(primer, CSRF_COOKIE) };
  }

  type Client = Awaited<ReturnType<typeof guest>>['client'];

  const list = async (client: Client, query = ''): Promise<AccountOrder[]> =>
    expectSuccess<AccountOrder[]>(await client.get(`${ORDERS}${query}`).expect(OK));

  const read = async (client: Client, orderNumber: string): Promise<AccountOrder> =>
    expectSuccess<AccountOrder>(await client.get(`${ORDERS}/${orderNumber}`).expect(OK));

  const countRows = async (sql: string, parameters: unknown[] = []): Promise<number> => {
    const rows = await integration.dataSource.query<{ count: string }[]>(sql, parameters);
    return Number(rows[0]?.count);
  };

  const countOrders = (): Promise<number> => countRows('SELECT count(*)::int AS count FROM orders');

  const countEvents = (): Promise<number> =>
    countRows('SELECT count(*)::int AS count FROM order_events');

  /**
   * The five money columns of every order, keyed by order number, read as `::text` and converted
   * with `Number`.
   *
   * `::text` rather than letting the driver hand back a `bigint`: a plain number is what reads in a
   * diff, and every figure here is under ₹40,000.
   */
  const storedMoney = async (): Promise<Map<string, Money>> => {
    const rows = await integration.dataSource.query<
      {
        order_number: string;
        subtotal: string;
        discount: string;
        gst: string;
        shipping: string;
        total: string;
      }[]
    >(
      `SELECT "orderNumber"         AS order_number,
              "subtotalPaise"::text AS subtotal,
              "discountPaise"::text AS discount,
              "gstPaise"::text      AS gst,
              "shippingPaise"::text AS shipping,
              "totalPaise"::text    AS total
         FROM orders
        ORDER BY "orderNumber"`,
    );
    return new Map(
      rows.map((row) => [
        row.order_number,
        {
          subtotal: Number(row.subtotal),
          discount: Number(row.discount),
          gst: Number(row.gst),
          shipping: Number(row.shipping),
          total: Number(row.total),
        },
      ]),
    );
  };

  const moneyOf = (order: AccountOrder): Money => ({
    subtotal: order.subtotal,
    discount: order.discount,
    gst: order.gst,
    shipping: order.shipping,
    total: order.total,
  });

  /**
   * Paise as rupees, **divided and never multiplied**.
   *
   * The comparison has to run in this direction. `toRupees` is `Number(paise) / 100`, so dividing
   * here produces the identical double and the assertion is exact; multiplying the wire value back
   * up does not — `32.95 * 100` is `3295.0000000000005`, and the first version of this helper failed
   * on `NN-2026-004977` for that reason alone. A `toBeCloseTo` would have hidden it, and hidden a
   * real paise-level error with it.
   */
  const inRupees = (paise: Money): Money => ({
    subtotal: paise.subtotal / 100,
    discount: paise.discount / 100,
    gst: paise.gst / 100,
    shipping: paise.shipping / 100,
    total: paise.total / 100,
  });

  /** One order's line slugs in `id` order — the sequence `ITEMS_IN_ORDER` asks Postgres for. */
  const slugsByIdOf = async (orderNumber: string): Promise<string[]> => {
    const rows = await integration.dataSource.query<{ product_slug: string }[]>(
      `SELECT i."productSlug" AS product_slug
         FROM order_items i
         JOIN orders o ON o.id = i.order_id
        WHERE o."orderNumber" = $1
        ORDER BY i.id`,
      [orderNumber],
    );
    return rows.map((row) => row.product_slug);
  };

  /**
   * `onHand` beside the ledger's own sum for one variant, plus the rows that explain it.
   *
   * The same query `checkout.integration.spec.ts` uses to prove the *decrement*, because a
   * cancellation is that decrement run backwards and the property being protected is identical:
   * `SUM(inventory_transactions.delta) == inventory.onHand`. `cancellationRows` is counted separately
   * from `ledger` so a restock that moved the column without writing its compensating row — the two
   * halves being in one transaction is the whole point of `putStockBack` — fails on the count rather
   * than only on the sum.
   *
   * **Ordered by the caller's list and not by `variant_id`**, which is the one change from
   * `checkout.integration.spec.ts`'s copy. Every assertion below zips the result against a list of
   * expected quantities, and a v4 uuid is re-randomised by every seed run — so `ORDER BY
   * i.variant_id` pairs correctly on some runs and transposes on others. Measured: the happy-path
   * case failed on `[118, 117]` against `[117, 118]` on its first run and would have passed on the
   * next. `array_position` is what makes the pairing the caller's rather than the database's.
   */
  interface StockRow {
    variantId: string;
    onHand: number;
    ledger: number;
    saleRows: number;
    cancellationRows: number;
  }

  const stockFor = async (variantIds: readonly string[]): Promise<StockRow[]> => {
    const rows = await integration.dataSource.query<
      {
        variant_id: string;
        on_hand: number;
        ledger: number;
        sale_rows: number;
        cancellation_rows: number;
      }[]
    >(
      `SELECT i.variant_id AS variant_id,
              i."onHand"::int AS on_hand,
              COALESCE((SELECT SUM(t.delta) FROM inventory_transactions t
                         WHERE t.variant_id = i.variant_id), 0)::int AS ledger,
              (SELECT count(*) FROM inventory_transactions t
                WHERE t.variant_id = i.variant_id AND t.type = 'SALE')::int AS sale_rows,
              (SELECT count(*) FROM inventory_transactions t
                WHERE t.variant_id = i.variant_id AND t.type = 'CANCELLATION')::int
                AS cancellation_rows
         FROM inventory i
        WHERE i.variant_id = ANY($1::uuid[])
        ORDER BY array_position($1::uuid[], i.variant_id)`,
      [[...variantIds]],
    );
    return rows.map((row) => ({
      variantId: row.variant_id,
      onHand: Number(row.on_hand),
      ledger: Number(row.ledger),
      saleRows: Number(row.sale_rows),
      cancellationRows: Number(row.cancellation_rows),
    }));
  };

  const variantIdOf = async (slug: string, size: string): Promise<string> => {
    const rows = await integration.dataSource.query<{ id: string }[]>(
      `SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE p.slug = $1 AND v.size = $2 AND v.channel = 'RETAIL'`,
      [slug, size],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`No retail variant for ${slug} ${size}`);
    return id;
  };

  const userIdOf = async (email: string): Promise<string> => {
    const rows = await integration.dataSource.query<{ id: string }[]>(
      'SELECT id FROM users WHERE email = $1',
      [email],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`users.seed did not create ${email}`);
    return id;
  };

  /**
   * One order's ledger rows, newest last — every `inventory_transactions` row that names it.
   *
   * Read by `order_id` rather than by variant, because the compensating row's whole job is to say
   * *which* order put the stock back: a `CANCELLATION` with a null `order_id` reconciles nothing and
   * would satisfy any assertion made from the variant's side.
   */
  const ledgerOf = async (
    orderNumber: string,
  ): Promise<
    {
      variantId: string;
      delta: number;
      type: string;
      balanceAfter: number;
      actorUserId: string | null;
      reason: string;
    }[]
  > => {
    const rows = await integration.dataSource.query<
      {
        variant_id: string;
        delta: number;
        type: string;
        balance_after: number;
        actor_user_id: string | null;
        reason: string;
      }[]
    >(
      `SELECT t.variant_id     AS variant_id,
              t.delta          AS delta,
              t.type::text     AS type,
              t."balanceAfter" AS balance_after,
              t.actor_user_id  AS actor_user_id,
              t.reason         AS reason
         FROM inventory_transactions t
         JOIN orders o ON o.id = t.order_id
        WHERE o."orderNumber" = $1
        ORDER BY t."createdAt", t.variant_id`,
      [orderNumber],
    );
    return rows.map((row) => ({
      variantId: row.variant_id,
      delta: Number(row.delta),
      type: row.type,
      balanceAfter: Number(row.balance_after),
      actorUserId: row.actor_user_id,
      reason: row.reason,
    }));
  };

  /** One order's timeline as the table holds it, oldest first, with the actor on each row. */
  const eventsOf = async (
    orderNumber: string,
  ): Promise<{ status: string; note: string | null; actorUserId: string | null }[]> => {
    const rows = await integration.dataSource.query<
      { status: string; note: string | null; actor_user_id: string | null }[]
    >(
      `SELECT e.status, e.note, e.actor_user_id AS actor_user_id
         FROM order_events e
         JOIN orders o ON o.id = e.order_id
        WHERE o."orderNumber" = $1
        ORDER BY e."createdAt", e.status`,
      [orderNumber],
    );
    return rows.map((row) => ({
      status: row.status,
      note: row.note,
      actorUserId: row.actor_user_id,
    }));
  };

  /** The three columns a cancellation writes on `orders` itself, beyond the status. */
  const cancellationColumns = async (
    orderNumber: string,
  ): Promise<{ status: string; cancelledAt: string | null; cancelReason: string | null }> => {
    const rows = await integration.dataSource.query<
      { status: string; cancelled_at: string | null; cancel_reason: string | null }[]
    >(
      `SELECT status, "cancelledAt" AS cancelled_at, "cancelReason" AS cancel_reason
         FROM orders WHERE "orderNumber" = $1`,
      [orderNumber],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`No order ${orderNumber}`);
    return { status: row.status, cancelledAt: row.cancelled_at, cancelReason: row.cancel_reason };
  };

  /** Every order this suite seeded, read as its own owner — the fixture as the wire renders it. */
  const readAllAsOwners = async (): Promise<Map<string, AccountOrder>> => {
    const found = new Map<string, AccountOrder>();
    for (const email of [B2C, B2B]) {
      const { client } = await signedIn(email);
      for (const seeded of ownedBy(email)) {
        found.set(seeded.number, await read(client, seeded.number));
      }
    }
    return found;
  };

  const putCart = (client: Client, csrf: string, lines: readonly unknown[]): Test =>
    client.put(CART).set(CSRF_HEADER, csrf).send({ lines }).expect(OK);

  describe('GET /account/orders', () => {
    /**
     * **Four, and never six.** Task 24's checklist originally expected six for this customer, which
     * is the cross-customer leak this whole suite exists to catch dressed as a pass: six is the
     * number of orders in the *table*, and `{ userId }` dropped from the `where` — the shape
     * `{ userId: userId ?? undefined }` produces, since TypeORM silently ignores an `undefined`
     * criterion — answers with all of them.
     *
     * `countOrders()` is asserted for that reason and is not decoration. Without it, "four came
     * back" is satisfied by a database that only holds four, and the scoping is never measured.
     */
    it('lists the four orders the retail customer owns, newest first, and nothing else', async () => {
      const { client } = await signedIn(B2C);

      const found = await list(client);

      expect(found.map((order) => order.id)).toEqual(numbersOf(ownedBy(B2C)));
      expect(await countOrders()).toBe(SEEDED.length);
      // The order *number*, not the uuid — `AccountOrder.id` has no field for the primary key, and
      // mapping `order.id` instead typechecks perfectly because both are `string`.
      for (const order of found) expect(order.id).toMatch(ORDER_NUMBER_PATTERN);
    });

    it('lists the two orders the business customer owns, newest first', async () => {
      const { client } = await signedIn(B2B);

      const found = await list(client);

      expect(found.map((order) => order.id)).toEqual(numbersOf(ownedBy(B2B)));
      expect(found).toHaveLength(2);
    });

    /**
     * The leak assertion, stated as a set operation rather than as a count.
     *
     * A count catches the widened `where` — six instead of four — and would not catch a scoping bug
     * that happened to return the right *number* of the wrong rows. Both directions, because
     * `userId` is one clause and a bug in it is not polite about which way it fails.
     */
    it('does not list another customer’s orders, in either direction', async () => {
      const retail = await signedIn(B2C);
      const business = await signedIn(B2B);

      const theirs = (await list(retail.client)).map((order) => order.id);
      const ours = (await list(business.client)).map((order) => order.id);

      expect(theirs.filter((id) => numbersOf(ownedBy(B2B)).includes(id))).toEqual([]);
      expect(ours.filter((id) => numbersOf(ownedBy(B2C)).includes(id))).toEqual([]);
      expect([...theirs, ...ours].sort()).toEqual(numbersOf(SEEDED).sort());
    });

    /**
     * **Both directions, because one of them cannot fail.**
     *
     * Every one of the retail customer's four orders is `RETAIL` and both of the business
     * customer's are `BULK`, so `?channel=retail` returns 4 for the retail customer with the filter
     * **deleted** — Task 15 measured exactly that. The assertions that distinguish a working filter
     * from an ignored one are the zeroes: a retail customer asking for their bulk orders has none,
     * and a bulk customer asking for their retail orders has none.
     *
     * Neither zero is the empty answer a guest gets, either — the same clients answer four and two
     * without the parameter, which is what makes the zero a filter rather than a missing session.
     */
    it('filters by channel, asserted in both directions', async () => {
      const retail = await signedIn(B2C);
      const business = await signedIn(B2B);

      const retailsRetail = await list(retail.client, '?channel=retail');
      const retailsBulk = await list(retail.client, '?channel=bulk');
      const businessBulk = await list(business.client, '?channel=bulk');
      const businessRetail = await list(business.client, '?channel=retail');

      expect(retailsRetail.map((order) => order.id)).toEqual(numbersOf(ownedBy(B2C)));
      expect(retailsBulk).toEqual([]);
      expect(businessBulk.map((order) => order.id)).toEqual(numbersOf(ownedBy(B2B)));
      expect(businessRetail).toEqual([]);
    });

    /**
     * **The `@IsIn` is what keeps the filter from widening**, and this is the case that proves it
     * runs over the wire rather than only in `order-query.dto.spec.ts`.
     *
     * `OrdersService.list` resolves the wire value through `CHANNEL[filters.channel]`, so a string
     * outside the union resolves to `undefined` — and TypeORM *drops* an `undefined` from a
     * find-options `where` rather than narrowing on it. So `?channel=gold` under an
     * `@IsOptional() @IsString()` would answer with **every** channel: a bulk customer asking for
     * their retail orders shown all of them, with a 200 and no error anywhere. The answer stays
     * inside the caller's own history either way, because `userId` is a separate clause, so this is
     * a wrong answer and never a leak — which is exactly why nothing else would notice it.
     */
    it('refuses a channel outside the union with a 400, rather than widening the query', async () => {
      const { client } = await signedIn(B2B);

      const refusal = refusalOf(await client.get(`${ORDERS}?channel=gold`).expect(BAD_REQUEST));

      expect(refusal.code).toBe('VALIDATION_FAILED');
      // The exact message, because it is the one the client renders and it names both legal values
      // — `ORDER_CHANNELS` is derived from the shared union rather than hand-listed, so a channel
      // added in `shared/` shows up here rather than being quietly rejected.
      expect(refusal.details?.channel).toEqual([
        'channel must be one of the following values: retail, bulk',
      ]);
    });

    /**
     * `forbidNonWhitelisted`, which is the global pipe's setting and not this DTO's: an unexpected
     * query parameter is named in a 400 rather than ignored.
     *
     * Pinned because `OrderQueryDto` deliberately has no `page`/`limit` — the seam it replaces
     * answers a bare array — and "adding pagination later is safe" rests entirely on `?page=2`
     * being a 400 today rather than a parameter quietly dropped while page one comes back.
     */
    it('names an unexpected query parameter rather than ignoring it', async () => {
      const { client } = await signedIn(B2C);

      const refusal = refusalOf(await client.get(`${ORDERS}?page=2`).expect(BAD_REQUEST));

      expect(refusal.details?.page).toEqual(['property page should not exist']);
    });

    /**
     * **Newest by `placedAt`, not by order number** — and the seeded fixture cannot tell those two
     * apart on its own, because its six order numbers descend in exactly the same sequence as its
     * six placement dates. So one is moved.
     *
     * `NN-2026-004650` is the retail customer's numerically lowest order and its oldest; re-dated
     * to the newest it must come **first**, which `ORDER BY "orderNumber" DESC` would answer last.
     * Written as an `UPDATE` rather than a second seeder because it is one column of one row, and
     * the fixture it perturbs is restored by the `TRUNCATE` after every test.
     */
    it('orders by placedAt and not by order number', async () => {
      await integration.dataSource.query(
        `UPDATE orders SET "placedAt" = $2 WHERE "orderNumber" = $1`,
        ['NN-2026-004650', '2026-08-20T00:00:00.000Z'],
      );
      const { client } = await signedIn(B2C);

      const found = await list(client);

      expect(found.map((order) => order.id)).toEqual([
        'NN-2026-004650',
        'NN-2026-005107',
        'NN-2026-004977',
        'NN-2026-004821',
      ]);
    });

    /**
     * **401, and never a 200 with `[]`.** There is no such thing as a guest's order list, and a
     * route that answered an empty array to an anonymous caller would be hiding a missing guard
     * behind it — `OrdersService.list(null)` returns exactly that empty array on purpose, and the
     * global `JwtAuthGuard` is what makes that arm unreachable over HTTP.
     *
     * Not a 403: `CsrfGuard` runs first but `GET` is a safe method and exempt, so the refusal is
     * authentication's.
     *
     * The second half is the one worth having. A client carrying `nn_guest_token` is still
     * anonymous here: a guest token identifies a *basket*, and treating it as an identity would
     * hand every guest every guest order ever placed, since `user_id IS NULL` is a predicate they
     * all share.
     */
    it('refuses an anonymous caller with 401, and a guest token is not an identity', async () => {
      const anonymous = await request(integration.app).get(ORDERS).expect(UNAUTHORIZED);
      expect(expectError(anonymous).success).toBe(false);

      const { client, csrf } = await guest();
      await putCart(client, csrf, [
        { slug: 'premium-california-almonds', mode: 'retail', size: '250g', qty: 1 },
      ]);

      await client.get(ORDERS).expect(UNAUTHORIZED);
    });
  });

  describe('GET /account/orders/:orderNumber', () => {
    /**
     * One order whole: its lines as `order_items` snapshotted them, and its timeline as
     * `order_events` holds it — six entries, oldest first, with the two notes the seeder wrote and
     * no note on the four that carry none.
     *
     * `slug` is asserted on every line because `LineName` in `account/orders/$id.tsx` links to the
     * product exactly when it is present, and `order_items.product_slug` is a non-null snapshot
     * column — so a real order always links, and disagreement 6 disappears the moment this endpoint
     * is the one being read.
     */
    it('returns one order with its snapshotted items and its full timeline, oldest first', async () => {
      const { client } = await signedIn(B2C);

      const order = await read(client, 'NN-2026-005107');

      // Sorted by slug before comparing, because the sequence the endpoint answers in is `id ASC`
      // over v4 uuids — arbitrary, and **re-randomised by every seed run**, so a literal array in
      // source order would pass or fail on a coin toss. That the sequence is nonetheless *stable* is
      // its own case below; this one is about the four snapshot columns per line.
      expect(
        [...order.items].sort((left, right) => (left.slug ?? '').localeCompare(right.slug ?? '')),
      ).toEqual([
        {
          slug: 'premium-pistachios',
          name: 'Premium Pistachios',
          detail: '250g',
          qty: 1,
          total: 509,
        },
        { slug: 'roasted-makhana', name: 'Roasted Makhana', detail: '250g', qty: 3, total: 897 },
      ]);
      expect(order.timeline.map((event) => event.status)).toEqual([
        'pending',
        'confirmed',
        'processing',
        'packed',
        'shipped',
        'out-for-delivery',
      ]);
      // The notes, present where the seeder wrote one and **absent** — not null, not empty — where
      // it did not. `OrderEvent.note` is optional on the wire because a note exists to say
      // something the status does not.
      expect(order.timeline.map((event) => event.note)).toEqual([
        undefined,
        'Payment received.',
        undefined,
        undefined,
        undefined,
        'With the delivery partner for today.',
      ]);
      // Oldest first, and strictly so: `OrderTimeline.tsx` treats the *last* entry as the current
      // step, so a reversed timeline renders the first step as current and looks entirely
      // plausible.
      const at = order.timeline.map((event) => Date.parse(event.at));
      expect(at).toEqual([...at].sort((left, right) => left - right));
    });

    /**
     * **The lines come back in `id` order**, which is the only stable sequence this schema can
     * offer: there is no `position` column, and every line of an order shares one `createdAt`
     * because both the seeder and `CheckoutService.place` write them in a single multi-row insert.
     * Drop the `ORDER BY` and two reads of one order can rearrange a customer's invoice between
     * visits — which reads as a rendering glitch rather than as a missing clause.
     *
     * Compared against the same `ORDER BY i.id` rather than against a literal, so the case is exact
     * rather than lucky: the uuids are re-randomised by every seed run, so a hardcoded sequence
     * would be a coin toss. It is still falsifiable — without the clause the relation comes back in
     * physical order, which coincides with uuid order for a given two-line order about half the
     * time, so five two-line orders agreeing by accident is roughly a 1-in-32 event.
     */
    it('answers an order’s lines in id order, the only stable key the schema offers', async () => {
      const found = await readAllAsOwners();

      const onTheWire: Record<string, string[]> = {};
      const inTheTable: Record<string, string[]> = {};
      for (const seeded of SEEDED) {
        onTheWire[seeded.number] = (found.get(seeded.number)?.items ?? []).map(
          (item) => item.slug ?? '',
        );
        inTheTable[seeded.number] = await slugsByIdOf(seeded.number);
      }

      expect(onTheWire).toEqual(inTheTable);
    });

    /**
     * The address snapshot as the wire's `Address`, field for field, and `email` taken from it.
     *
     * `orders` has no email column and `user_id` is nullable because guest checkout is supported,
     * so the snapshot is the only source that works for the orders that need it most. Note this
     * fixture cannot tell the snapshot's email from the account's — both seeded snapshots carry
     * their owner's address — which is why the placement round-trip below posts a *different* one.
     */
    it('answers with the stored address snapshot, and takes the order’s email from it', async () => {
      const retail = await signedIn(B2C);
      const business = await signedIn(B2B);

      const theirs = await read(retail.client, 'NN-2026-004821');
      const ours = await read(business.client, 'NN-2026-004488');

      expect(theirs.address).toEqual(RETAIL_ADDRESS);
      expect(theirs.email).toBe(B2C);
      expect(ours.address).toEqual(BUSINESS_ADDRESS);
      expect(ours.email).toBe(B2B);
    });

    /**
     * The four optional fields, sent on the orders that have them and **omitted** on the ones that
     * do not — `undefined`, not `null` and not `''`, because the detail page renders each behind a
     * `&&` and `AccountOrder` declares them optional.
     *
     * No seeded order carries a coupon, so `couponCode` is absent on all six; the round-trip case
     * below is where a present one is measured.
     */
    it('carries the business block on a bulk order and omits it on a retail one', async () => {
      const retail = await signedIn(B2C);
      const business = await signedIn(B2B);

      const theirs = await read(retail.client, 'NN-2026-005107');
      const ours = await read(business.client, 'NN-2026-005042');

      expect(ours.companyName).toBe('Anand Sweets & Namkeen');
      expect(ours.gstin).toBe('29ABCDE1234F1Z5');
      expect(ours.poNumber).toBe('ANS/2026/0412');
      expect('companyName' in theirs).toBe(false);
      expect('gstin' in theirs).toBe(false);
      expect('poNumber' in theirs).toBe(false);
      expect('couponCode' in theirs).toBe(false);
      expect('couponCode' in ours).toBe(false);
    });

    /**
     * **404, not 403** — and the same 404, letter for letter, as an order number nobody ever used.
     *
     * `OrdersService.findOne` answers `null` for both "no such order" and "not yours" and cannot
     * tell them apart by design. Order numbers are sequential and walkable, so an endpoint that
     * answered 403 for one and 404 for the other would be an existence oracle: a scan of the range
     * would enumerate the shop's volume. Spec §13. `ErrorCodes` has no `FORBIDDEN` member at all,
     * which is the registry saying the same thing.
     *
     * The two refusals are compared to each other rather than each to a literal, because
     * *indistinguishable* is the property — a message that leaked "this order belongs to someone
     * else" would satisfy two separate assertions and fail this one.
     */
    it('404s another customer’s order exactly as it 404s one that never existed', async () => {
      const { client } = await signedIn(B2C);

      const theirs = refusalOf(await client.get(`${ORDERS}/NN-2026-005042`).expect(NOT_FOUND));
      const nobodys = refusalOf(await client.get(`${ORDERS}/NN-2026-000001`).expect(NOT_FOUND));

      expect(theirs.code).toBe('NOT_FOUND');
      expect(nobodys.code).toBe('NOT_FOUND');
      // The same sentence with the caller's own input echoed into it, and nothing else.
      expect(theirs.message).toBe('No order NN-2026-005042 in your account.');
      expect(nobodys.message).toBe('No order NN-2026-000001 in your account.');
      expect(theirs.code).toBe(nobodys.code);
      // The order the caller could not read is still there — a 404 that had deleted it, or that was
      // really "no such row", would pass every assertion above.
      const business = await signedIn(B2B);
      expect((await read(business.client, 'NN-2026-005042')).id).toBe('NN-2026-005042');
    });

    /**
     * `HttpStatus.NOT_FOUND` is passed to the `DomainError` explicitly, and this is the assertion
     * that says why: `DomainError` defaults to **422**, so omitting it answers a mistyped order
     * number with "unprocessable entity" and the client's not-found branch never runs.
     */
    it('refuses an anonymous caller with 401 on the detail route too', async () => {
      await request(integration.app).get(`${ORDERS}/NN-2026-005107`).expect(UNAUTHORIZED);
    });

    /**
     * **The last timeline entry equals the order's status, for all six.** `AccountOrder.timeline`'s
     * docblock states it as a contract and `OrderTimeline.tsx` renders the last entry as the
     * current step, so an order whose history ends somewhere other than where the order is shows a
     * customer the wrong step with complete confidence.
     *
     * The per-order event and item counts are asserted in the same pass: 38 events across six
     * orders is the fixture, and a mapper that dropped or duplicated one would otherwise only be
     * visible as a timeline that happened to end in the right place.
     */
    it('ends every seeded timeline on the order’s own status, with every event mapped', async () => {
      const found = await readAllAsOwners();

      const shape = SEEDED.map((seeded) => {
        const order = found.get(seeded.number);
        return {
          number: seeded.number,
          status: order?.status,
          last: order?.timeline.at(-1)?.status,
          events: order?.timeline.length,
          items: order?.items.length,
        };
      });

      expect(shape).toEqual(
        SEEDED.map((seeded) => ({
          number: seeded.number,
          status: seeded.status,
          last: seeded.status,
          events: seeded.events,
          items: seeded.items,
        })),
      );
      expect(await countEvents()).toBe(38);
    });

    /**
     * The whole status vocabulary crosses the wire — all 14 values, which is
     * `B2C_ORDER_STATUSES ∪ B2B_ORDER_STATUSES` exactly, the two tuples overlapping on
     * `processing`, `shipped` and `delivered`.
     *
     * This is what keeps `toOrderStatus` honest. `orders.status` and `order_events.status` are
     * `varchar(24)`, so the compiler cannot tell a status from any other string, and the mapper
     * checks membership at that boundary rather than casting — an unknown value reaching
     * `ORDER_STATUS_LABEL` renders a **blank badge** with no error anywhere, which is the hardest
     * kind of wrong answer to trace back. Six orders' timelines exercising every legal value is
     * the strongest available evidence that the check passes what it should.
     */
    it('carries all 14 statuses of the shared vocabulary across the six timelines', async () => {
      const found = await readAllAsOwners();

      const seen = new Set<string>();
      for (const order of found.values()) {
        seen.add(order.status);
        for (const event of order.timeline) seen.add(event.status);
      }

      expect([...seen].sort()).toEqual([...EVERY_STATUS].sort());
      expect(seen.size).toBe(14);
    });

    /**
     * The three enum vocabularies, lowered — and the one that is **not** an enum, left alone.
     *
     * `channel` and `paymentMethod`/`paymentStatus` are `UPPERCASE` Postgres enums that have to be
     * lowered; `orders.status` is a `varchar(24)` already stored in the wire's own lowercase-hyphen
     * spelling. Getting that asymmetry backwards is invisible to the compiler and ships `RETAIL`
     * where a status belongs. Every seeded order is COD, and the six between them cover three of
     * the four payment statuses, so `PAYMENT_STATUS` is measured rather than assumed for those
     * three.
     */
    it('lowers the enum vocabularies and leaves the status spelling alone', async () => {
      const found = await readAllAsOwners();

      expect(
        SEEDED.map((seeded) => {
          const order = found.get(seeded.number);
          return {
            channel: order?.channel,
            paymentMethod: order?.paymentMethod,
            paymentStatus: order?.paymentStatus,
            status: order?.status,
          };
        }),
      ).toEqual(
        SEEDED.map((seeded) => ({
          channel: seeded.channel,
          paymentMethod: 'cod' as const,
          paymentStatus: seeded.paymentStatus,
          status: seeded.status,
        })),
      );
    });

    /**
     * `placedAt` and `estimatedDelivery` as ISO-8601 instants, which is what `AccountOrder`
     * declares and what `new Date(order.placedAt)` on the page needs.
     */
    it('sends both dates as ISO-8601 strings', async () => {
      const { client } = await signedIn(B2C);

      const order = await read(client, 'NN-2026-004977');

      expect(order.placedAt).toBe('2026-08-05T14:10:00.000Z');
      expect(order.estimatedDelivery).toBe('2026-08-09T12:00:00.000Z');
    });

    /**
     * One mapper serves both routes, measured rather than asserted about the source.
     *
     * `GET /account/orders` answers `AccountOrder[]` — the same shape as the detail route, not a
     * lighter header projection — because the account list renders each order's status and its
     * lines. Two shapes for one thing would be two contracts, the second of which nobody updates.
     */
    it('answers the list entry and the detail read with the same order', async () => {
      const { client } = await signedIn(B2C);

      const found = await list(client);
      const detail = await read(client, 'NN-2026-004821');

      expect(found.find((order) => order.id === 'NN-2026-004821')).toEqual(detail);
    });
  });

  /**
   * **Disagreement 5, settled with numbers — and the answer is that neither figure moves.**
   *
   * The premise was that `mocks/orders.ts` rounds a single aggregate (`Math.round(subtotal * 0.05)`)
   * while `orders.seed.ts` and `cart-pricing.service.ts` compute GST **per line and sum**, so
   * pointing the account seam at the server would move the two live frontend assertions "by a
   * rupee". Worked through against the six seeded orders, it does not — for two separate reasons,
   * both of which are properties of this fixture rather than of the arithmetic.
   *
   * *Per line and sum is not the divergence here.* Every seeded line total is a whole number of
   * rupees, so 5% of it is an exact number of paise and no line rounds at all. Per-line and
   * aggregate agree to the paise on all six orders — `NN-2026-004488` sums ₹1,061.25 + ₹690.00 =
   * ₹1,751.25, which is also 5% of its ₹35,025 subtotal. The real difference is that the mock
   * rounds GST to the **rupee** and the server keeps the paise.
   *
   * *And `inr()` rounds, so the paise never reach the screen.* `frontend/src/lib/format.ts` is
   * `"₹" + Math.round(n).toLocaleString("en-IN")`, and every money figure in the account area goes
   * through it. The mock's value is `Math.round(subtotal × 0.05)` and the server's rendered value is
   * `Math.round(subtotal × 0.05)` — the same expression, so the two agree by construction rather
   * than by luck, for any order whose lines are whole rupees.
   *
   * | Order | subtotal | mock GST | server GST | mock total | server total | rendered |
   * | --- | --- | --- | --- | --- | --- | --- |
   * | NN-2026-005107 | ₹1,406 | ₹70 | ₹70.30 | ₹1,476 | ₹1,476.30 | ₹1,476 |
   * | NN-2026-005042 | ₹38,640 | ₹1,932 | ₹1,932.00 | ₹40,572 | ₹40,572.00 | ₹40,572 |
   * | NN-2026-004977 | ₹659 | ₹33 | ₹32.95 | ₹771 | ₹770.95 | ₹771 |
   * | NN-2026-004821 | ₹2,197 | ₹110 | ₹109.85 | ₹2,307 | ₹2,306.85 | ₹2,307 |
   * | NN-2026-004650 | ₹978 | ₹49 | ₹48.90 | ₹1,106 | ₹1,105.90 | ₹1,106 |
   * | NN-2026-004488 | ₹35,025 | ₹1,751 | ₹1,751.25 | ₹36,776 | ₹36,776.25 | ₹36,776 |
   *
   * So the two assertions the plan expected to move keep their present values, and the arithmetic
   * is recorded here so the next reader sees a measurement rather than an omission:
   *
   * - **`routes.smoke.test.tsx` — the business dashboard's `₹77,348`.** The tile sums the two bulk
   *   orders' totals and passes the sum through `inr`. Mock: ₹40,572 + ₹36,776 = ₹77,348. Server:
   *   ₹40,572.00 + ₹36,776.25 = ₹77,348.25, `Math.round` → **₹77,348**. Old and new are the same
   *   number, and the docblock's `(₹40,572 + ₹36,776)` gloss stays true of what is rendered.
   * - **`routes.smoke.test.tsx` — the receipt's `₹329 / ₹16 / ₹79 / ₹424`.** These are not seeded
   *   figures at all: they come from `fromReceipt` reconstructing a hand-written
   *   `nn.order.NN-2026-777777` payload in `sessionStorage`, with `gst = Math.round(329 × 0.05) =
   *   16` and `shipping = 424 − 329 − 16 = 79` as the residue. Nothing on the server produces them,
   *   because no such order exists; Task 19 deletes the receipt, the reconstruction and that test
   *   together and replaces it with a placed order read back through this endpoint. The figures do
   *   not move — the case does.
   *
   * The one thing that *would* move a rendered figure is a line total in fractional rupees, which
   * every path can now produce: a percentage coupon leaves `discountPaise` at ₹89.70 in the
   * round-trip below. No seeded order has one, which is why this table is unanimous and why the
   * general claim is still worth keeping — it is unobservable in this fixture, not false.
   *
   * **Do not adjust the server to match the mock.** An invoice whose tax does not equal the sum of
   * its lines' tax cannot be reconciled, which is why §8 requires per-line GST regardless of
   * whether this fixture can see the difference.
   */
  describe('money', () => {
    /**
     * The paise columns against this file's own table of the seeder's arithmetic. Pins the fixture
     * from the database's side, so a change to a seeded price or quantity fails here — where the
     * expected figures are written down — rather than silently redefining what the wire tests are
     * comparing against.
     */
    it('holds the paise this fixture says it does, per order', async () => {
      const stored = await storedMoney();

      expect(SEEDED.map((seeded) => stored.get(seeded.number))).toEqual(
        SEEDED.map((seeded) => seeded.paise),
      );
    });

    /**
     * **Rupees on the wire, and the paise column divided by 100 — as arithmetic, not as a cast.**
     *
     * Every money column is a `bigint` `@PaiseColumn` and `bigint-json.ts` patches
     * `BigInt.prototype.toJSON`, so an unconverted figure does not throw: it arrives as the
     * **string** `"147630"` with a 200 attached, and renders as `₹NaN` or concatenates. `typeof` is
     * what sees that, and only a real response can — a controller unit test compares an object that
     * never crossed a JSON boundary against itself.
     *
     * The last assertion is the invoice identity. It is not implied by the four conversions: a
     * mapper that read `gstPaise` into `shipping` would satisfy every field-by-field comparison
     * against a fixture whose shipping is zero, and fail this.
     */
    it('sends every money field in rupees, equal to the paise column divided by 100', async () => {
      const stored = await storedMoney();
      const found = await readAllAsOwners();

      for (const seeded of SEEDED) {
        const order = found.get(seeded.number);
        if (order === undefined) throw new Error(`${seeded.number} was not read back`);
        const paise = stored.get(seeded.number);
        if (paise === undefined) throw new Error(`${seeded.number} has no stored money`);
        expect(moneyOf(order)).toEqual(inRupees(paise));
        for (const value of Object.values(moneyOf(order))) expect(typeof value).toBe('number');
        expect(order.total).toBe(order.subtotal - order.discount + order.gst + order.shipping);
      }
    });

    /**
     * The one seeded order whose tax is not a whole number of rupees, asserted as the exact rupee
     * figure rather than through the paise round-trip above.
     *
     * ₹1,751.25 is the whole of disagreement 5 in one number: the mock says ₹1,751, the server says
     * ₹1,751.25, and `inr()` renders both as `₹1,751`. Written out so that a future change to
     * either arithmetic has one place to fail.
     */
    it('sends the fractional GST of the one order that has it', async () => {
      const { client } = await signedIn(B2B);

      const order = await read(client, 'NN-2026-004488');

      expect(order.gst).toBe(1751.25);
      expect(order.total).toBe(36_776.25);
      expect(Math.round(order.total)).toBe(36_776);
    });
  });

  /**
   * The case that keeps Task 16 honest.
   *
   * `POST /checkout/orders` answers `PlaceOrderResult`, which *is* `AccountOrder`, and both routes
   * are supposed to go through `toAccountOrder` — that is the entire argument for there being one
   * mapper. If someone later hand-rolls a second shape on either side, nothing else in either suite
   * notices: `checkout.integration.spec.ts` asserts on the placement response and this file asserts
   * on the account read, and each would keep passing against its own half.
   *
   * It has to be the **signed-in** case, because a guest's order has `userId: null` and cannot be
   * read back at all.
   */
  describe('placement and the account read', () => {
    const shipping = {
      fullName: 'Asha Menon',
      phone: '9876543210',
      // Deliberately not the account's address. `AccountOrder.email` comes from the snapshot, and a
      // fixture where the two agree cannot tell that from `order.user.email`.
      email: 'asha@demo.in',
      line1: '14 Lalbagh Road',
      line2: 'Near the bandstand',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
    };

    /**
     * **Five lines, and the count is the point.**
     *
     * The comparison below is the only test that reads one order down both paths, so it is the only
     * thing that can see the two paths ordering an order's lines differently. `order_items` has no
     * natural order, `id` is a v4 uuid, and an unordered read comes back in physical sequence — so
     * with two lines the two sequences coincide about half the time and the case detects a missing
     * `ORDER BY` on a coin toss. Measured: the reload's clause deleted, this case failed 2 of 4
     * runs. Five lines make the accident a 1-in-120 event instead.
     *
     * One line is in the `almonds` category and the other four are not, so `ALMOND15` discounts
     * ₹598 of a larger basket — which is what makes the discount a *share* rather than the whole
     * subtotal, and what fixes it at ₹89.70 regardless of what else is in the basket.
     *
     * `WELCOME10` is unavailable here and the reason is the fixture: it is `firstOrderOnly`, this
     * customer already owns four seeded orders, and `CouponService` counts *orders* rather than
     * redemptions — so the coupon `checkout.integration.spec.ts` uses is a
     * `COUPON_FIRST_ORDER_ONLY` refusal in this file. `ALMOND15` is category-scoped with no
     * first-order rule.
     */
    const lines = [
      { slug: 'premium-california-almonds', mode: 'retail' as const, size: '250g', qty: 2 },
      { slug: 'w320-cashews', mode: 'retail' as const, size: '100g', qty: 1 },
      { slug: 'roasted-makhana', mode: 'retail' as const, size: '250g', qty: 1 },
      { slug: 'premium-pistachios', mode: 'retail' as const, size: '250g', qty: 1 },
      { slug: 'medjool-dates', mode: 'retail' as const, size: '500g', qty: 1 },
    ];

    it('answers the account read with the placement response, field for field', async () => {
      const { client, csrf } = await signedIn(B2C);
      await putCart(client, csrf, lines);

      const placed = expectSuccess<AccountOrder>(
        await client
          .post(PLACE)
          .set(CSRF_HEADER, csrf)
          // Lower case on purpose: `Coupon.code` is stored uppercase and matched
          // case-insensitively, so the canonical spelling coming back is part of the contract.
          .send({ shipping, paymentMethod: 'cod', couponCode: 'almond15' })
          .expect(CREATED),
      );

      const fetched = expectSuccess<AccountOrder>(
        await client.get(`${ORDERS}/${placed.id}`).expect(OK),
      );

      // Field for field, not body for body: this compares the parsed objects, so key order — which
      // differs across a `jsonb` round-trip — is not part of the assertion.
      expect(fetched).toEqual(placed);

      // And the fields that make the comparison non-trivial. A pair of empty or zeroed objects
      // would satisfy `toEqual` perfectly.
      expect(placed.id).toEqual(expect.stringMatching(ORDER_NUMBER_PATTERN));
      expect(placed.status).toBe('pending');
      expect(placed.timeline).toHaveLength(1);
      expect(placed.items).toHaveLength(lines.length);
      // Both sequences are `id ASC`, stated against the table rather than against each other, so a
      // failure says *which* path lost its `ORDER BY` instead of only that the two disagree.
      const byId = await slugsByIdOf(placed.id);
      expect(placed.items.map((item) => item.slug)).toEqual(byId);
      expect(fetched.items.map((item) => item.slug)).toEqual(byId);
      expect(placed.couponCode).toBe('ALMOND15');
      expect(placed.discount).toBeGreaterThan(0);
      // The snapshot's email, not the account's — the two differ here on purpose.
      expect(placed.email).toBe('asha@demo.in');
      expect(placed.address).toEqual(shipping);
    });

    /**
     * The new order joins the customer's history at the top, and the four seeded ones are still
     * there. `placedAt` is now, which is later than every seeded date, so newest-first puts it
     * first.
     */
    it('adds the placed order to the top of the customer’s own history', async () => {
      const { client, csrf } = await signedIn(B2C);
      await putCart(client, csrf, lines);
      const placed = expectSuccess<AccountOrder>(
        await client
          .post(PLACE)
          .set(CSRF_HEADER, csrf)
          .send({ shipping, paymentMethod: 'cod' })
          .expect(CREATED),
      );

      const found = await list(client);

      expect(found.map((order) => order.id)).toEqual([placed.id, ...numbersOf(ownedBy(B2C))]);
      // And the business customer's history is untouched by it.
      const business = await signedIn(B2B);
      expect((await list(business.client)).map((order) => order.id)).toEqual(
        numbersOf(ownedBy(B2B)),
      );
    });

    /**
     * A discount in fractional rupees survives the round-trip, which no seeded order can show:
     * `ALMOND15` takes 15% of the almond line's ₹598, so `discountPaise` is 8,970 and the wire
     * carries ₹89.70. This is the case that would move a rendered figure — see the note above
     * `describe('money')` — and the only one in this file that has a non-zero discount at all.
     */
    it('carries a fractional discount through to the account read', async () => {
      const { client, csrf } = await signedIn(B2C);
      await putCart(client, csrf, lines);
      const placed = expectSuccess<AccountOrder>(
        await client
          .post(PLACE)
          .set(CSRF_HEADER, csrf)
          .send({ shipping, paymentMethod: 'cod', couponCode: 'ALMOND15' })
          .expect(CREATED),
      );

      const order = await read(client, placed.id);

      expect(order.discount).toBe(89.7);
      expect(order.total).toBe(order.subtotal - order.discount + order.gst + order.shipping);
      const stored = await storedMoney();
      expect(stored.get(placed.id)?.discount).toBe(8_970);
    });
  });

  /**
   * **`POST /account/orders/:orderNumber/cancel` — and the reason it has to be an integration test
   * rather than a unit one.**
   *
   * `OrderStatusService.putStockBack` was **outright broken** from Task 5 until Task 7 (`4f06392`),
   * and 458 unit tests passed either side of the fix. Its restock is a raw statement that reads its
   * own `RETURNING`, and TypeORM's Postgres driver special-cases `UPDATE`: `result.raw` becomes
   * `[rows, rowCount]` rather than `rows`, so `rows[0]?.onHand` was `undefined` on every successful
   * restock, the `undefined` branch threw `NOT_FOUND`, and **no cancellation could ever have
   * succeeded**. The unit doubles answered `[{ onHand }]` — the shape a `SELECT` returns — so they
   * modelled the right thing and the driver was the liar. The fix wraps the write in a data-modifying
   * CTE (`WITH restored AS (UPDATE … RETURNING) SELECT …`), which makes the statement's command
   * `SELECT` while keeping the predicate inside the write.
   *
   * **Nothing pinned that fix until this block.** Task 7's file is concurrency-only by charter and
   * deliberately added no single-threaded case, so reverting the CTE to a bare `UPDATE … RETURNING`
   * failed nothing. It now fails the first case below, on the 200 and on the restored `onHand` and on
   * the missing `CANCELLATION` row — three independent assertions, because the failure mode is a
   * rolled-back transaction and a 404, which is easy to mistake for a routing problem.
   *
   * **The ledger row is asserted alongside the column, and is not a nicety.** `onHand` is
   * denormalised and `inventory_transactions` is append-only, so a restock that moved the counter
   * without writing its compensating row leaves `SUM(delta) = onHand` broken — the invariant
   * `schema-invariants.integration.spec.ts` holds at zero mismatches and that three tasks of this
   * milestone were spent protecting. §10.2 makes the ledger the reconciliation record, not the column.
   *
   * **Every case here places its own order, because no seeded order is cancellable.** The six rest in
   * `out-for-delivery`, `shipped`, `cancelled`, `delivered`, `refunded` and `delivered`, and
   * `RETAIL_TRANSITIONS` offers `cancelled` only from `pending`, `confirmed`, `processing` and
   * `packed`. A fresh placement lands `pending`, which is the only way to reach the happy path at all
   * — and it is also what makes the stock assertions possible, since the seeder writes no `SALE` rows
   * for its own orders (`orders.seed.ts:25-30`) and there is nothing to put back.
   */
  describe('POST /account/orders/:orderNumber/cancel', () => {
    const ALMONDS = 'premium-california-almonds';
    const CASHEWS = 'w320-cashews';

    /**
     * Two lines on two different variants, with different quantities.
     *
     * Two rather than one because `applyStockConsequence` loops the order's lines and sorts them
     * ascending by `variantId` — a single line cannot tell a loop from a `lines[0]`. Different
     * quantities because a restock that credited the wrong line's `qty` would be invisible if both
     * were the same number.
     */
    const lines = [
      { slug: ALMONDS, mode: 'retail' as const, size: '250g', qty: 2 },
      { slug: CASHEWS, mode: 'retail' as const, size: '100g', qty: 3 },
    ];

    /** 560001 is Bengaluru, prefix `5`, serviceable in `pincodes.seed.ts`. */
    const shipping = {
      fullName: 'Asha Menon',
      phone: '9876543210',
      email: 'asha@demo.in',
      line1: '14 Lalbagh Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
    };

    /** No coupon: `ALMOND15` would work here, but a discount is disagreement 5's business and not
     * this block's, and `WELCOME10` is `firstOrderOnly` and refuses a customer with four orders. */
    const placeFresh = async (email = B2C) => {
      const { client, csrf } = await signedIn(email);
      await putCart(client, csrf, lines);
      const placed = expectSuccess<AccountOrder>(
        await client
          .post(PLACE)
          .set(CSRF_HEADER, csrf)
          .send({ shipping, paymentMethod: 'cod' })
          .expect(CREATED),
      );
      expect(placed.status).toBe('pending');
      return { client, csrf, placed };
    };

    const cancelling = (client: Client, csrf: string, orderNumber: string): Test =>
      client.post(`${ORDERS}/${orderNumber}/cancel`).set(CSRF_HEADER, csrf);

    /**
     * **The regression test for `putStockBack`, and the whole of this task's stock contract.**
     *
     * Five things are measured in one pass because they are one transaction and a partial failure is
     * the interesting one:
     *
     * 1. **200 with the cancelled order.** Not 201 — nothing was created — and the body is the order
     *    re-read after the transition, so `status` and the timeline are the committed ones rather
     *    than the row the handler read on the way in.
     * 2. **`onHand` back exactly where it started.** Captured before the placement rather than
     *    assumed to be the seeder's 120, so a change to seeded stock does not silently redefine what
     *    "restored" means.
     * 3. **A `CANCELLATION` row per line**, naming the order, carrying `+qty`, and carrying the
     *    `balanceAfter` the storefront will read. The row comes back from the writing statement, so
     *    `balanceAfter` is the value the `UPDATE` produced and not a second derivation of it.
     * 4. **`SUM(delta) = onHand`** for both variants, which is the invariant the ledger row exists to
     *    keep true.
     * 5. **Exactly one new event, against the customer.** The `pending` event placement wrote carries
     *    `actorUserId: null` because it was system-generated; this one carries the customer's id,
     *    because a cancellation was performed by someone and the timeline the admin reads has to say
     *    who.
     */
    it('cancels a pending order, restores the stock, writes a CANCELLATION row and one event', async () => {
      const variants = [await variantIdOf(ALMONDS, '250g'), await variantIdOf(CASHEWS, '100g')];
      const asha = await userIdOf(B2C);
      const opening = await stockFor(variants);

      const { client, csrf, placed } = await placeFresh();
      const sold = await stockFor(variants);
      // The placement really took the stock, so "restored" below is a movement and not a no-op.
      expect(sold.map((row) => row.onHand)).toEqual(
        opening.map((row, index) => row.onHand - (lines[index]?.qty ?? 0)),
      );

      const response = await cancelling(client, csrf, placed.id).expect(OK);
      const cancelled = expectSuccess<AccountOrder>(response);

      expect(cancelled.id).toBe(placed.id);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.timeline.map((event) => event.status)).toEqual(['pending', 'cancelled']);
      // One mapper, both routes: the body the cancel answers is the body the read answers next.
      expect(await read(client, placed.id)).toEqual(cancelled);

      const restored = await stockFor(variants);
      expect(restored.map((row) => row.onHand)).toEqual(opening.map((row) => row.onHand));
      expect(restored.map((row) => row.ledger)).toEqual(opening.map((row) => row.onHand));
      expect(restored.map((row) => row.saleRows)).toEqual([1, 1]);
      expect(restored.map((row) => row.cancellationRows)).toEqual([1, 1]);

      const ledger = await ledgerOf(placed.id);
      const qtyOf = new Map([
        [variants[0], lines[0]?.qty],
        [variants[1], lines[1]?.qty],
      ]);
      const compensating = ledger.filter((row) => row.type === 'CANCELLATION');
      expect(ledger).toHaveLength(4);
      expect(compensating).toHaveLength(2);
      for (const row of compensating) {
        expect(row.delta).toBe(qtyOf.get(row.variantId));
        expect(row.reason).toBe(`Order ${placed.id} cancelled`);
        // The actor, because a cancellation has one. A null here would be indistinguishable from a
        // system or admin action in the audit trail §32 exists for.
        expect(row.actorUserId).toBe(asha);
        expect(row.balanceAfter).toBe(
          restored.find((stock) => stock.variantId === row.variantId)?.onHand,
        );
      }
      // The sale and its compensation cancel out, per variant — the ledger read as arithmetic
      // rather than as a row count.
      for (const variantId of variants) {
        const forVariant = ledger.filter((row) => row.variantId === variantId);
        expect(forVariant.reduce((sum, row) => sum + row.delta, 0)).toBe(0);
      }

      expect(await eventsOf(placed.id)).toEqual([
        { status: 'pending', note: null, actorUserId: null },
        { status: 'cancelled', note: null, actorUserId: asha },
      ]);
      const columns = await cancellationColumns(placed.id);
      expect(columns.status).toBe('cancelled');
      expect(columns.cancelledAt).not.toBeNull();
      // No reason, because the customer was not asked for one and the endpoint takes no body. A
      // server-invented sentence here would be a claim about why, on a row an admin reads as fact.
      expect(columns.cancelReason).toBeNull();
    });

    /**
     * **The invariant, over the whole table rather than over the two variants this order touched.**
     *
     * `schema-invariants.integration.spec.ts` holds this at zero mismatches for the seeded database;
     * this is the same query after a placement and a cancellation have both run, which is the first
     * time in this milestone that stock moves down and back up again. Asserted separately from the
     * case above because the failure means something different: the assertions there say the
     * cancellation did its two writes, and this one says nothing *else* in the transaction drifted —
     * a restock that credited a line twice, or credited the wrong variant, satisfies every per-line
     * assertion and shows up only here.
     */
    it('leaves SUM(delta) = onHand across every variant after the restore', async () => {
      const { client, csrf, placed } = await placeFresh();

      await cancelling(client, csrf, placed.id).expect(OK);

      const drift = await integration.dataSource.query<
        { variant_id: string; on_hand: number; ledger: number }[]
      >(`
        SELECT i.variant_id,
               i."onHand" AS on_hand,
               COALESCE(SUM(t.delta), 0)::int AS ledger
          FROM inventory i
          LEFT JOIN inventory_transactions t ON t.variant_id = i.variant_id
         GROUP BY i.variant_id, i."onHand"
        HAVING i."onHand" <> COALESCE(SUM(t.delta), 0)::int
      `);
      expect(drift).toEqual([]);
    });

    /**
     * **An order that has left the warehouse is a 422 that names what is possible instead.**
     *
     * `NN-2026-005107` is the retail customer's own `out-for-delivery` order, so this is not an
     * ownership refusal: the caller may read it, and is being told the transition is wrong rather
     * than that the order is not theirs. After dispatch the goods are with a courier and the correct
     * action is a return, which is why `RETAIL_TRANSITIONS` offers `cancelled` only from the four
     * pre-dispatch statuses.
     *
     * `allowed` is the load-bearing half of the body. It is `nextStatuses(channel, from)` — the same
     * function the Cancel button on `account/orders/$id.tsx` hides itself with — so a client can say
     * "this one is out for delivery next" rather than "no". A refusal with no `allowed` leaves the UI
     * with nothing to render but the word.
     *
     * §10.3's "not a silent write": the order is asserted untouched afterwards, timeline included.
     */
    it('refuses to cancel an order that has left the warehouse, naming what is allowed', async () => {
      const { client, csrf } = await signedIn(B2C);

      const refusal = refusalOf(
        await cancelling(client, csrf, 'NN-2026-005107').expect(UNPROCESSABLE),
      );

      expect(refusal.code).toBe('ILLEGAL_STATUS_TRANSITION');
      expect(refusal.message).toBe(
        'An order that is "out-for-delivery" cannot become "cancelled".',
      );
      expect(refusal.details).toEqual({
        orderNumber: 'NN-2026-005107',
        from: 'out-for-delivery',
        to: 'cancelled',
        allowed: ['delivered'],
      });
      // Nothing written: same status, same six events, and no ledger row for an order the seeder
      // gave none.
      expect((await cancellationColumns('NN-2026-005107')).status).toBe('out-for-delivery');
      expect((await cancellationColumns('NN-2026-005107')).cancelledAt).toBeNull();
      expect(await eventsOf('NN-2026-005107')).toHaveLength(6);
      expect(await ledgerOf('NN-2026-005107')).toEqual([]);
    });

    /**
     * **A customer may cancel; a customer may not refund.**
     *
     * `RETAIL_TRANSITIONS.delivered` is `['refunded']`, and `canTransition` would happily approve it
     * — so the only thing stopping this route being a self-service refund is that its target status
     * is hardcoded rather than taken from the request. `NN-2026-004821` is the retail customer's own
     * `delivered` order with `paymentStatus: collected`, which is exactly the order a refund would
     * move money on.
     *
     * The refusal names `refunded` as what is available, which is honest — it *is* the next step, and
     * it is an admin's to take.
     */
    it('will not refund a delivered order through the cancel route', async () => {
      const { client, csrf } = await signedIn(B2C);

      const refusal = refusalOf(
        await cancelling(client, csrf, 'NN-2026-004821').expect(UNPROCESSABLE),
      );

      expect(refusal.details).toEqual({
        orderNumber: 'NN-2026-004821',
        from: 'delivered',
        to: 'cancelled',
        allowed: ['refunded'],
      });
      const order = await read(client, 'NN-2026-004821');
      expect(order.status).toBe('delivered');
      expect(order.paymentStatus).toBe('collected');
      expect(await eventsOf('NN-2026-004821')).toHaveLength(7);
    });

    /**
     * **404, not 403 — and not 422 either, which is the half a reader would miss.**
     *
     * `NN-2026-005042` is the *business* customer's `shipped` bulk order. Both of its refusals are
     * available: it is not this caller's, and it could not be cancelled even by its owner. The
     * ownership check has to win, because a 422 saying `from: "shipped"` would confirm the order
     * exists **and disclose its current status** to someone with no claim on it — an existence oracle
     * with a progress report attached, on order numbers that are sequential and walkable. Spec §13,
     * and `ErrorCodes` has no `FORBIDDEN` member at all.
     *
     * Compared letter for letter against the *read* route's 404 on the same number, because
     * *indistinguishable* is the property: a cancel that worded its refusal differently would leak
     * which of the two endpoints knew something.
     */
    it('refuses another customer’s order with the read’s own 404, never a 403 or a 422', async () => {
      const { client, csrf } = await signedIn(B2C);

      const cancelled = refusalOf(
        await cancelling(client, csrf, 'NN-2026-005042').expect(NOT_FOUND),
      );
      const read404 = refusalOf(await client.get(`${ORDERS}/NN-2026-005042`).expect(NOT_FOUND));

      expect(cancelled.code).toBe('NOT_FOUND');
      expect(cancelled.message).toBe('No order NN-2026-005042 in your account.');
      expect(cancelled.details).toEqual({ orderNumber: 'NN-2026-005042' });
      expect(cancelled.message).toBe(read404.message);
      expect(cancelled.code).toBe(read404.code);
      // Nothing about the order's real status crossed the wire.
      expect(JSON.stringify(cancelled)).not.toContain('shipped');

      // And the order is still there, still shipped, for the customer who owns it.
      const business = await signedIn(B2B);
      expect((await read(business.client, 'NN-2026-005042')).status).toBe('shipped');
      expect(await eventsOf('NN-2026-005042')).toHaveLength(7);
    });

    /**
     * **Cancelling twice is a 422, not a second event** — and it falls out of `canTransition`
     * refusing a no-op rather than out of a guard written on this path.
     *
     * The mutant worth naming is an early return like `if (order.status === 'cancelled') return
     * order;`, which reads as a courtesy, answers **200** to the second click and looks idempotent —
     * while quietly bypassing the guarded `UPDATE` that is the only thing stopping a double
     * cancellation restocking twice. So the event count and the ledger count are both asserted:
     * two events, not three; one `CANCELLATION` per line, not two.
     */
    it('refuses a second cancellation with 422, writing no second event and no second restock', async () => {
      const variants = [await variantIdOf(ALMONDS, '250g'), await variantIdOf(CASHEWS, '100g')];
      const opening = await stockFor(variants);
      const { client, csrf, placed } = await placeFresh();

      await cancelling(client, csrf, placed.id).expect(OK);
      const refusal = refusalOf(await cancelling(client, csrf, placed.id).expect(UNPROCESSABLE));

      expect(refusal.code).toBe('ILLEGAL_STATUS_TRANSITION');
      expect(refusal.details).toEqual({
        orderNumber: placed.id,
        from: 'cancelled',
        to: 'cancelled',
        // Terminal, so there is nothing left to offer — which is itself the answer the UI needs.
        allowed: [],
      });
      expect(await eventsOf(placed.id)).toHaveLength(2);
      const after = await stockFor(variants);
      expect(after.map((row) => row.onHand)).toEqual(opening.map((row) => row.onHand));
      expect(after.map((row) => row.cancellationRows)).toEqual([1, 1]);
      expect(after.map((row) => row.ledger)).toEqual(after.map((row) => row.onHand));
    });

    /**
     * **Two cancellations at once restock once, and no lock was added to make that true.**
     *
     * `transition()` writes with the status it read in the predicate — `update({ id, status: from },
     * patch)` — so under `READ COMMITTED` the second `UPDATE` blocks on the first, re-checks its
     * `WHERE` against the committed row, matches nothing, reports `affected !== 1` and raises
     * **before** `applyStockConsequence` runs. That is why a `SELECT … FOR UPDATE` here would be a
     * downgrade rather than an improvement: it would add a second serialisation point in front of one
     * that already holds.
     *
     * **Which refusal the loser gets is deliberately not pinned.** If the two interleave, both read
     * `pending`, both pass `canTransition`, and the loser is refused by the guarded `UPDATE` — a
     * **409**, because the request was legal when it was made and retrying it is sensible. If the
     * winner commits first, the loser reads `cancelled` and is refused earlier by `canTransition` — a
     * **422**. Pinning one would make this a timing detector; the property is that exactly one
     * succeeded and the stock moved exactly once.
     *
     * Two sessions for one customer rather than two customers, because an order has one owner and
     * this is the double-click a real customer produces with two tabs open.
     */
    it('answers one of two concurrent cancellations and puts the stock back once', async () => {
      const variants = [await variantIdOf(ALMONDS, '250g'), await variantIdOf(CASHEWS, '100g')];
      const opening = await stockFor(variants);
      const { client, csrf, placed } = await placeFresh();
      const second = await signedIn(B2C);

      const responses = await Promise.all([
        cancelling(client, csrf, placed.id),
        cancelling(second.client, second.csrf, placed.id),
      ]);

      const statuses = responses.map((response) => response.status);
      expect(statuses.filter((status) => status === OK)).toHaveLength(1);
      const loser = statuses.find((status) => status !== OK);
      expect([CONFLICT, UNPROCESSABLE]).toContain(loser);

      // One cancellation, one event, one compensating row per line — and `onHand` back where it
      // started rather than above it, which is what a double restock looks like.
      expect(await eventsOf(placed.id)).toHaveLength(2);
      const after = await stockFor(variants);
      expect(after.map((row) => row.onHand)).toEqual(opening.map((row) => row.onHand));
      expect(after.map((row) => row.cancellationRows)).toEqual([1, 1]);
      expect(after.map((row) => row.ledger)).toEqual(after.map((row) => row.onHand));
    });

    /**
     * **Both guards in front of the write, in the order they actually run.**
     *
     * `CsrfGuard` is registered **before** `JwtAuthGuard`, which is why the anonymous half of this
     * case carries a CSRF token: without one the refusal would be the 403, and the test would prove
     * nothing about authentication. `guest()` primes with a `GET` for exactly that reason —
     * `CsrfBootstrapMiddleware` sets the cookie on the *response*, so a brand-new client's first
     * write can never satisfy the guard.
     *
     * The CSRF half matters more on this route than on a read: a cancellation is irreversible —
     * `nextStatuses(channel, 'cancelled')` is `[]` — so a cross-site form post would destroy an order
     * rather than merely disclose one. And a guest token is not an identity here either: it names a
     * basket, and `user_id IS NULL` is a predicate every guest order shares.
     *
     * The order survives both, and the legitimate call then succeeds — so the refusals are the
     * guards' and not a broken route.
     */
    it('refuses an anonymous caller with 401 and a missing CSRF token with 403', async () => {
      const { client, csrf, placed } = await placeFresh();

      const anonymous = await guest();
      const unauthenticated = await anonymous.client
        .post(`${ORDERS}/${placed.id}/cancel`)
        .set(CSRF_HEADER, anonymous.csrf)
        .expect(UNAUTHORIZED);
      // A bare `UnauthorizedException`, so there is a message and no machine-readable `code`.
      expect(expectError(unauthenticated).code).toBeUndefined();

      const forged = refusalOf(
        await client.post(`${ORDERS}/${placed.id}/cancel`).expect(FORBIDDEN),
      );
      expect(forged.code).toBe('CSRF_TOKEN_INVALID');

      // Untouched by either, and then cancellable by the customer who owns it.
      expect((await read(client, placed.id)).status).toBe('pending');
      expect(await eventsOf(placed.id)).toHaveLength(1);
      await cancelling(client, csrf, placed.id).expect(OK);
      expect((await read(client, placed.id)).status).toBe('cancelled');
    });
  });

  /**
   * `OrderStatusService` has no controller — §7.1 puts the admin console in a separate repository,
   * and this is the only place in *this* one that walks an order the whole way. It is here rather
   * than in `checkout.integration.spec.ts` because the thing being pinned is the *sequence*: three
   * notifications across seven writes, and nothing for the four steps in between.
   */
  describe('OrderStatusService.transition — notifications', () => {
    it('queues order.confirmed at placement, order.shipped and order.delivered at those two steps, and nothing else along the way', async () => {
      const { client, csrf } = await signedIn(B2C);
      await putCart(client, csrf, [
        { slug: 'premium-california-almonds', mode: 'retail' as const, size: '250g', qty: 2 },
      ]);
      const placed = expectSuccess<AccountOrder>(
        await client
          .post(PLACE)
          .set(CSRF_HEADER, csrf)
          .send({
            shipping: {
              fullName: 'Asha Menon',
              phone: '9876543210',
              email: 'asha@demo.in',
              line1: '14 Lalbagh Road',
              city: 'Bengaluru',
              state: 'Karnataka',
              pincode: '560001',
            },
            paymentMethod: 'cod',
          })
          .expect(CREATED),
      );

      const statusService = integration.app.get(OrderStatusService);
      for (const to of [
        'confirmed',
        'processing',
        'packed',
        'shipped',
        'out-for-delivery',
        'delivered',
      ] as const) {
        await statusService.transition(placed.id, to);
      }

      const rows = await integration.dataSource.query<{ template: string }[]>(
        `SELECT template FROM notifications
          WHERE payload->>'orderNumber' = $1 ORDER BY "createdAt"`,
        [placed.id],
      );
      expect(rows.map((r) => r.template)).toEqual([
        'order.confirmed',
        'order.shipped',
        'order.delivered',
      ]);
    });
  });
});
