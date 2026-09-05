import { HttpStatus } from '@nestjs/common';
import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { AccountOrder, CartLine, CartTotals } from '@nutwala/shared';
import type { Response, Test } from 'supertest';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedCoupons } from '../../src/database/seeds/coupons.seed';
import { seedPincodes } from '../../src/database/seeds/pincodes.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { seedUsers } from '../../src/database/seeds/users.seed';
import { MAX_IDEMPOTENCY_KEY_LENGTH } from '../../src/common/http/idempotency.interceptor';
import { CHECKOUT_ORDERS_SCOPE } from '../../src/modules/checkout/checkout-idempotency.interceptor';
import { CheckoutService } from '../../src/modules/checkout/checkout.service';
import type { PlaceOrderDto } from '../../src/modules/checkout/dto/place-order.dto';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { ORDER_NUMBER_PATTERN } from '../../src/modules/orders/order-number';
import {
  agent,
  cookieValue,
  expectError,
  expectStatus,
  expectSuccess,
  responseBody,
  useIntegrationApp,
} from './helpers';

/**
 * Cookie and header names are spelled out rather than imported, for the reason
 * `cart.integration.spec.ts` and `auth.integration.spec.ts` both give at length: they are wire
 * contract. `Idempotency-Key` is in the same category — `test-app.ts` names it in `allowedHeaders`
 * and Task 13's `CheckoutForm` will send it by that spelling — so a rename must break a test here
 * rather than typecheck and leave every client failing CORS preflight.
 */
const GUEST_COOKIE = 'nn_guest_token';
const CSRF_COOKIE = 'nn_csrf';
const CSRF_HEADER = 'X-CSRF-Token';
const IDEMPOTENCY_HEADER = 'Idempotency-Key';

const CART = '/api/v1/cart';
const ORDERS = '/api/v1/checkout/orders';
const PREVIEW = '/api/v1/checkout/coupon/preview';
const PINCODE = '/api/v1/checkout/pincode';
const LOGIN = '/api/v1/auth/login';

const ALMONDS = 'premium-california-almonds';
const CASHEWS = 'w320-cashews';
/** `corporate-gift-box` is the one seeded `quoteOnly: true` product — `catalog.seed.ts:472`. */
const QUOTE_ONLY = 'corporate-gift-box';

/**
 * ₹299 for the 250g pack (`buildVariants`: `round(999 * 0.3 / 10) * 10 - 1`), so qty 2 is ₹598, and
 * ₹139 for the 100g cashew pack — ₹737 together, which is deliberately **under** the ₹999
 * `freeShippingThreshold`. A basket over the threshold gets `shipping: 0` from
 * `CartPricingService`, and `CheckoutService.shippingFor` then returns `0n` without ever reading
 * the pincode row, so the free basket cannot tell the per-destination charge from a hardcoded zero.
 */
const almonds = { slug: ALMONDS, mode: 'retail' as const, size: '250g', qty: 2 };
const cashews = { slug: CASHEWS, mode: 'retail' as const, size: '100g', qty: 1 };

/** Prefix `5` is seeded serviceable at four days and ₹79 (`pincodes.seed.ts`). */
const SERVICEABLE_PINCODE = '560001';
/**
 * Prefix `9` is one of the two seeded **unserviceable** rows — `0` and `9` are the prefixes India
 * issues no civilian pincodes under. It matters that this is a *matched* row and not a miss:
 * `PincodeService.resolve` answers `NO_MATCH` for an unknown prefix and a stored refusal for this
 * one, and only the second proves the column is read.
 */
const UNSERVICEABLE_PINCODE = '900001';

/**
 * Widened to `number` deliberately. supertest types `Response.status` as `number`, so comparing it
 * against an `HttpStatus` member is an `no-unsafe-enum-comparison` error — the rule is right in
 * general and the value here really is an untyped number off the wire.
 */
const CREATED: number = HttpStatus.CREATED;
const CONFLICT: number = HttpStatus.CONFLICT;

const WELCOME10 = 'WELCOME10';
const BULK500 = 'BULK500';

interface CartResponse {
  lines: CartLine[];
  totals: CartTotals;
}

/**
 * The refusal envelope with `details` widened.
 *
 * `ErrorBody.details` is `Record<string, string[]>`, which is right for a validation failure and
 * wrong for `refuseBrokenLines`, whose `details.lines` is an array of verdict objects. Read through
 * `responseBody` so the one untyped boundary stays in one place, after `expectError` has checked the
 * envelope.
 */
interface Refusal {
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}

function refusalOf(response: Response): Refusal {
  expectError(response);
  return responseBody<Refusal>(response);
}

/** The slugs a `refuseBrokenLines` refusal named, from `details.lines[].slug`. */
function offendingSlugs(refusal: Refusal): string[] {
  const lines = refusal.details?.lines;
  if (!Array.isArray(lines)) return [];
  return (lines as { slug?: unknown }[])
    .map((line) => line.slug)
    .filter((slug): slug is string => typeof slug === 'string');
}

/**
 * Which of `keys` the body left `undefined`.
 *
 * An array rather than a boolean, because the failure message is the whole point: `expect([]).
 * toEqual([])` against `['timeline']` names the field the mapper dropped, where a
 * `Object.values(...).every(...)` assertion reports only `false`.
 */
function missingFields<T extends object>(body: T, keys: readonly (keyof T)[]): string[] {
  return keys.filter((key) => body[key] === undefined).map((key) => String(key));
}

/**
 * The one response in `responses` carrying `status`, or a thrown error naming what was found.
 *
 * Throwing rather than returning `undefined` keeps the race assertions free of `?.` chains that
 * would quietly pass against a missing response, and the message prints the statuses that did
 * arrive — which is the only interesting question when a race comes out wrong.
 */
function only(responses: readonly Response[], status: number, label: string): Response {
  const matching = responses.filter((response) => response.status === status);
  const [first] = matching;
  if (matching.length !== 1 || first === undefined) {
    throw new Error(
      `Expected exactly one ${label} response (${status}); statuses were ` +
        `${JSON.stringify(responses.map((response) => response.status))}`,
    );
  }
  return first;
}

/** A key of exactly `length` characters — one over the cap is the case under test. */
const keyOfLength = (length: number): string => 'k'.repeat(length);

describe('checkout', () => {
  const integration = useIntegrationApp();

  /**
   * Empties the rate limiter between tests, for the reason `cart.integration.spec.ts:68` records:
   * `useIntegrationApp` boots one application per file, so `ThrottlerGuard`'s in-memory storage is
   * shared, `POST /auth/login` is capped at **five attempts per fifteen minutes per IP**, and every
   * supertest request arrives from 127.0.0.1. This file signs in more than five times, so without
   * this the sixth login 429s and the failure lands on whichever test happens to be sixth. No test
   * here signs in more than once, so the reset cannot weaken one.
   *
   * `onApplicationShutdown()` is called for its documented effect — cancelling the pending per-hit
   * decrement timers.
   */
  beforeEach(() => {
    const throttler = integration.app.get<ThrottlerStorageService>(ThrottlerStorage);
    throttler.onApplicationShutdown();
    throttler.storage.clear();
  });

  beforeEach(async () => {
    await seedSettings(integration.dataSource);
    await seedUsers(integration.dataSource);
    await seedCatalog(integration.dataSource);
    // After `seedCatalog`: `ALMOND15` is category-scoped, so a `category_id` has to exist.
    await seedCoupons(integration.dataSource);
    // Placement refuses every pincode without this, so it is not optional for any case here.
    await seedPincodes(integration.dataSource);
  });

  /** Signs in and returns a cookie-persisting client plus the CSRF token to echo. */
  async function signedIn(email = 'b2c@demo.in') {
    const client = agent(integration.app);
    const login = await client.post(LOGIN).send({ email, password: 'Password123!' }).expect(200);
    return { client, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  }

  /**
   * An anonymous client that already holds `nn_csrf`, plus the token to echo — `cart.integration.
   * spec.ts:101`, and it primes with a `GET` for the reason recorded there.
   *
   * **A cold write can never succeed and must not be written as though it can.** `CsrfGuard` is
   * global and requires both a cookie and a matching header on every method but GET/HEAD/OPTIONS,
   * and a brand-new client has neither. `CsrfBootstrapMiddleware` sets `nn_csrf` on the
   * **response**, so it is available from the *next* request onward and cannot retroactively satisfy
   * the guard on the request that minted it — or an attacker's cross-site POST would be handed a
   * fresh pair too.
   *
   * `GET /cart` is the primer rather than any other safe route because it is also the route the
   * guest tests below read their basket back from.
   */
  async function guest() {
    const client = agent(integration.app);
    // `expectStatus`, not `.expect(200)`: this primer has been seen answering 401 intermittently
    // (`docs/known-issues.md` item 1), which should be impossible — `GET /cart` is `@Public()` and
    // `JwtAuthGuard` swallows an auth failure on a public route. `.expect()` reports the status and
    // discards the body, and the body is the only thing that names which rule refused.
    const primer = expectStatus(await client.get(CART), 200);
    return { client, csrf: cookieValue(primer, CSRF_COOKIE) };
  }

  type Client = Awaited<ReturnType<typeof guest>>['client'];

  /** The address block every placement here posts, with the pincode left to the caller. */
  const shipping = (pincode = SERVICEABLE_PINCODE) => ({
    fullName: 'Asha Menon',
    phone: '9876543210',
    email: 'asha@demo.in',
    line1: '14 Lalbagh Road',
    line2: 'Near the bandstand',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode,
  });

  const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    shipping: shipping(),
    paymentMethod: 'cod',
    ...overrides,
  });

  const putCart = (client: Client, csrf: string, lines: readonly unknown[]): Test =>
    client.put(CART).set(CSRF_HEADER, csrf).send({ lines }).expect(200);

  const cartOf = async (client: Client): Promise<CartResponse> =>
    expectSuccess<CartResponse>(await client.get(CART).expect(200));

  /** One placement. Status left to the caller, so a refusal reads as clearly as a success. */
  const place = (
    client: Client,
    csrf: string,
    payload: Record<string, unknown> = body(),
    headers: Record<string, string> = {},
  ): Test => {
    let request = client.post(ORDERS).set(CSRF_HEADER, csrf);
    for (const [name, value] of Object.entries(headers)) request = request.set(name, value);
    return request.send(payload);
  };

  const countRows = async (sql: string, parameters: unknown[] = []): Promise<number> => {
    const rows = await integration.dataSource.query<{ count: string }[]>(sql, parameters);
    return Number(rows[0]?.count);
  };

  const countOrders = (): Promise<number> => countRows('SELECT count(*)::int AS count FROM orders');

  const countSaleRows = (): Promise<number> =>
    countRows(`SELECT count(*)::int AS count FROM inventory_transactions WHERE type = 'SALE'`);

  /** Every notification a placement queued for one order, read by template and order number. */
  const notificationsFor = (template: string, orderNumber: string) =>
    integration.dataSource.query<{ user_id: string | null; payload: Record<string, unknown> }[]>(
      `SELECT user_id, payload FROM notifications
        WHERE template = $1 AND payload->>'orderNumber' = $2`,
      [template, orderNumber],
    );

  /**
   * The stored order, money read as `::text` and converted with `Number`.
   *
   * Deliberately not read as `bigint`: `jest.config.ts` sets `workerThreads: true` so a raw `BigInt`
   * in a failure no longer destroys the file's whole result set, but a plain number is what reads in
   * a diff, and every basket here is a few hundred rupees.
   */
  interface OrderRow {
    orderNumber: string;
    userId: string | null;
    status: string;
    channel: string;
    paymentMethod: string;
    paymentStatus: string;
    subtotalPaise: number;
    discountPaise: number;
    gstPaise: number;
    shippingPaise: number;
    totalPaise: number;
    couponCode: string | null;
    addressSnapshot: Record<string, unknown>;
    billingSnapshot: Record<string, unknown> | null;
  }

  const storedOrders = async (): Promise<OrderRow[]> => {
    const rows = await integration.dataSource.query<
      {
        order_number: string;
        user_id: string | null;
        status: string;
        channel: string;
        payment_method: string;
        payment_status: string;
        subtotal: string;
        discount: string;
        gst: string;
        shipping: string;
        total: string;
        coupon_code: string | null;
        address_snapshot: Record<string, unknown>;
        billing_snapshot: Record<string, unknown> | null;
      }[]
    >(
      `SELECT "orderNumber"        AS order_number,
              user_id              AS user_id,
              status,
              channel,
              "paymentMethod"      AS payment_method,
              "paymentStatus"      AS payment_status,
              "subtotalPaise"::text AS subtotal,
              "discountPaise"::text AS discount,
              "gstPaise"::text      AS gst,
              "shippingPaise"::text AS shipping,
              "totalPaise"::text    AS total,
              "couponCode"          AS coupon_code,
              "addressSnapshot"     AS address_snapshot,
              "billingSnapshot"     AS billing_snapshot
         FROM orders
        ORDER BY "orderNumber"`,
    );
    return rows.map((row) => ({
      orderNumber: row.order_number,
      userId: row.user_id,
      status: row.status,
      channel: row.channel,
      paymentMethod: row.payment_method,
      paymentStatus: row.payment_status,
      subtotalPaise: Number(row.subtotal),
      discountPaise: Number(row.discount),
      gstPaise: Number(row.gst),
      shippingPaise: Number(row.shipping),
      totalPaise: Number(row.total),
      couponCode: row.coupon_code,
      addressSnapshot: row.address_snapshot,
      billingSnapshot: row.billing_snapshot,
    }));
  };

  const theOnlyOrder = async (): Promise<OrderRow> => {
    const rows = await storedOrders();
    const [only] = rows;
    if (rows.length !== 1 || only === undefined) {
      throw new Error(`Expected exactly one order, found ${rows.length}`);
    }
    return only;
  };

  interface ItemRow {
    productSlug: string;
    name: string;
    hsn: string | null;
    detail: string;
    size: string | null;
    qty: number;
    unitPricePaise: number;
    lineTotalPaise: number | null;
    gstRate: string;
    gstAmountPaise: number;
    variantId: string | null;
  }

  const itemsOf = async (orderNumber: string): Promise<ItemRow[]> => {
    const rows = await integration.dataSource.query<
      {
        product_slug: string;
        name: string;
        hsn: string | null;
        detail: string;
        size: string | null;
        qty: number;
        unit_price: string;
        line_total: string | null;
        gst_rate: string;
        gst_amount: string;
        variant_id: string | null;
      }[]
    >(
      `SELECT i."productSlug"        AS product_slug,
              i.name,
              i.hsn,
              i.detail,
              i.size,
              i.qty,
              i."unitPricePaise"::text AS unit_price,
              i."lineTotalPaise"::text AS line_total,
              i."gstRate"              AS gst_rate,
              i."gstAmountPaise"::text AS gst_amount,
              i.variant_id             AS variant_id
         FROM order_items i
         JOIN orders o ON o.id = i.order_id
        WHERE o."orderNumber" = $1
        ORDER BY i."productSlug"`,
      [orderNumber],
    );
    return rows.map((row) => ({
      productSlug: row.product_slug,
      name: row.name,
      hsn: row.hsn,
      detail: row.detail,
      size: row.size,
      qty: row.qty,
      unitPricePaise: Number(row.unit_price),
      lineTotalPaise: row.line_total === null ? null : Number(row.line_total),
      gstRate: row.gst_rate,
      gstAmountPaise: Number(row.gst_amount),
      variantId: row.variant_id,
    }));
  };

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
        ORDER BY e."createdAt"`,
      [orderNumber],
    );
    return rows.map((row) => ({
      status: row.status,
      note: row.note,
      actorUserId: row.actor_user_id,
    }));
  };

  /** The first event's `createdAt` as the database holds it, ISO-8601 from Postgres itself. */
  const firstEventAt = async (orderNumber: string): Promise<string> => {
    const rows = await integration.dataSource.query<{ at: string }[]>(
      `SELECT to_char(e."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
         FROM order_events e
         JOIN orders o ON o.id = e.order_id
        WHERE o."orderNumber" = $1
        ORDER BY e."createdAt"
        LIMIT 1`,
      [orderNumber],
    );
    const at = rows[0]?.at;
    if (at === undefined) throw new Error(`Order ${orderNumber} has no events`);
    return at;
  };

  const paymentsOf = async (
    orderNumber: string,
  ): Promise<
    { method: string; status: string; amountPaise: number; reference: string | null }[]
  > => {
    const rows = await integration.dataSource.query<
      { method: string; status: string; amount: string; reference: string | null }[]
    >(
      `SELECT p.method, p.status, p."amountPaise"::text AS amount, p.reference
         FROM payments p
         JOIN orders o ON o.id = p.order_id
        WHERE o."orderNumber" = $1`,
      [orderNumber],
    );
    return rows.map((row) => ({
      method: row.method,
      status: row.status,
      amountPaise: Number(row.amount),
      reference: row.reference,
    }));
  };

  /** `onHand` beside the ledger's own sum, per variant — the invariant as one comparison. */
  interface StockRow {
    variantId: string;
    onHand: number;
    ledger: number;
    saleRows: number;
  }

  const stockFor = async (variantIds: readonly string[]): Promise<StockRow[]> => {
    const rows = await integration.dataSource.query<
      { variant_id: string; on_hand: number; ledger: number; sale_rows: number }[]
    >(
      `SELECT i.variant_id AS variant_id,
              i."onHand"::int AS on_hand,
              COALESCE((SELECT SUM(t.delta) FROM inventory_transactions t
                         WHERE t.variant_id = i.variant_id), 0)::int AS ledger,
              (SELECT count(*) FROM inventory_transactions t
                WHERE t.variant_id = i.variant_id AND t.type = 'SALE')::int AS sale_rows
         FROM inventory i
        WHERE i.variant_id = ANY($1)
        ORDER BY i.variant_id`,
      [[...variantIds]],
    );
    return rows.map((row) => ({
      variantId: row.variant_id,
      onHand: Number(row.on_hand),
      ledger: Number(row.ledger),
      saleRows: Number(row.sale_rows),
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
   * Drives stock to `target` **through `InventoryService.adjust`**, never by writing the column.
   *
   * `SUM(inventory_transactions.delta) = inventory.onHand` is the invariant these tests exist to
   * protect, so a fixture that set `onHand` directly would leave the ledger short by the difference
   * and make every invariant assertion below measure the fixture's breakage rather than placement's
   * correctness. Copied in spirit from `checkout-concurrency.integration.spec.ts`, for the same
   * reason.
   */
  const setStock = async (variantId: string, target: number): Promise<void> => {
    const rows = await integration.dataSource.query<{ onHand: number }[]>(
      'SELECT "onHand" FROM inventory WHERE variant_id = $1',
      [variantId],
    );
    const current = rows[0]?.onHand;
    if (current === undefined) throw new Error(`No inventory row for variant ${variantId}`);
    if (Number(current) === target) return;

    const admins = await integration.dataSource.query<{ id: string }[]>(
      `SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1`,
    );
    const actorUserId = admins[0]?.id;
    if (actorUserId === undefined) throw new Error('users.seed did not create an admin');

    await integration.app.get(InventoryService).adjust({
      variantId,
      delta: target - Number(current),
      reason: 'Checkout integration fixture',
      actorUserId,
    });
  };

  /** Switches a seeded boolean setting off, which is the only way to reach some refusals. */
  const setSetting = async (key: string, value: boolean): Promise<void> => {
    await integration.dataSource.query(
      `UPDATE settings SET value = $2::jsonb, "updatedAt" = now() WHERE key = $1`,
      [key, JSON.stringify(value)],
    );
  };

  /**
   * `POST /checkout/pincode` — the seam `PincodeChecker.tsx` on the *product* page calls, and the
   * only checkout endpoint that needs neither a session nor a basket.
   *
   * **Proved over HTTP and not only in `checkout.controller.spec.ts` for one reason above the
   * others: serialisation.** A hand-built controller test returns an object and asserts on it, so a
   * `bigint` that never crossed a JSON boundary compares equal to itself all day. `shippingPaise` is
   * a `bigint`, `bigint-json.ts` patches `BigInt.prototype.toJSON`, and an unconverted figure
   * therefore arrives here as the **string** `"7900"` with a 200 attached. Only a real response can
   * see that, which is why every case below asserts `typeof shipping`.
   */
  describe('pincode check', () => {
    interface PincodeBody {
      pincode: string;
      serviceable: boolean;
      etaDays: number;
      shipping: number;
    }

    const check = (client: Client, csrf: string, payload: Record<string, unknown>): Test =>
      client.post(PINCODE).set(CSRF_HEADER, csrf).send(payload);

    /**
     * The whole answer for a serviceable prefix, compared field for field against what
     * `pincodes.seed.ts` writes: four working days and ₹79. The rupee figure is the one that matters
     * — the row stores 7900 paise, so `79` proves the conversion happened and `typeof` proves it
     * happened as arithmetic rather than as `toJSON`.
     */
    it('answers a serviceable pincode with the seeded ETA and charge, in rupees', async () => {
      const { client, csrf } = await guest();

      const result = expectSuccess<PincodeBody>(
        await check(client, csrf, { pincode: SERVICEABLE_PINCODE }).expect(HttpStatus.OK),
      );

      expect(result).toEqual({
        pincode: SERVICEABLE_PINCODE,
        serviceable: true,
        etaDays: 4,
        shipping: 79,
      });
      expect(typeof result.shipping).toBe('number');
    });

    /**
     * **Disagreement 1, over the wire.** `checkout/api/index.ts:42`'s `/^[2-8]\d{5}$/` refused every
     * Delhi pincode and `routes.smoke.test.tsx:274` pinned that refusal as *"We don't deliver here
     * yet."*; `pincodes.seed.ts` says prefix `1` is serviceable at four days. The table wins —
     * refusing to deliver to Delhi is not a behaviour worth preserving — and this is the assertion
     * that says so where a Phase 1 reader would look for it.
     */
    it('delivers to the Delhi pincode the Phase 1 mock refused as malformed', async () => {
      const { client, csrf } = await guest();

      const result = expectSuccess<PincodeBody>(
        await check(client, csrf, { pincode: '110001' }).expect(HttpStatus.OK),
      );

      expect(result).toEqual({ pincode: '110001', serviceable: true, etaDays: 4, shipping: 79 });
    });

    /**
     * A refusal is a **200 answering "no"**, not a 4xx. The customer is asking a question and "we do
     * not deliver there" is the answer to it; an error status would put this in `ApiRequestError` and
     * leave the checker's success branch unreachable for the case it exists to report.
     *
     * `900001` matters because it is a *matched* refusal rather than a miss — prefix `9` is one of the
     * two seeded unserviceable rows — so it proves `isServiceable` is read off the row. Its
     * `shipping` is the row's own `0`, and its `etaDays` the row's own `4`: a stored refusal keeps
     * its figures, so nothing here would notice if `resolve` started answering `NO_MATCH` instead.
     * That distinction is what `matchedPrefix` exists for and it is not on the wire, so the ETA is
     * the only visible difference — hence asserting it rather than only the flag.
     *
     * **`NO_MATCH` itself is unreachable against the seed**, and worth saying out loud: the ten
     * seeded rows are the ten leading digits, so every six-digit string matches something and
     * `matchedPrefix: null` cannot happen in production data. It is reachable only by deleting a row,
     * which is why `pincode.service.spec.ts` covers it against a fixture table and this file does not.
     */
    it('refuses a seeded unserviceable prefix with a 200, keeping that row own figures', async () => {
      const { client, csrf } = await guest();

      const result = expectSuccess<PincodeBody>(
        await check(client, csrf, { pincode: UNSERVICEABLE_PINCODE }).expect(HttpStatus.OK),
      );

      expect(result).toEqual({
        pincode: UNSERVICEABLE_PINCODE,
        serviceable: false,
        etaDays: 4,
        shipping: 0,
      });
      expect(typeof result.shipping).toBe('number');
    });

    /**
     * Malformed is a **400**, and deliverability is a 200 — the distinction the Phase 1 mock could
     * not make, because `/^[2-8]\d{5}$/` answered "not serviceable" to a five-digit typo and to
     * Delhi alike. `PINCODE_REGEX` is `/^\d{6}$/`, so this is a validation failure with the form's own
     * message, and a customer can tell a typo from a delivery limit.
     */
    it('refuses a malformed pincode as a validation failure, not as unserviceable', async () => {
      const { client, csrf } = await guest();

      const refusal = refusalOf(
        await check(client, csrf, { pincode: '12345' }).expect(HttpStatus.BAD_REQUEST),
      );

      expect(refusal.code).toBe('VALIDATION_FAILED');
      expect(refusal.details?.pincode).toEqual(['Enter a valid 6-digit pincode']);
    });

    /**
     * `forbidNonWhitelisted`, which is the global pipe's setting and not this DTO's: an unexpected
     * property is named in a 400 rather than stripped. Pinned because the checker sends one field and
     * the *next* caller of this endpoint — Task 13's checkout form, per the plan — will be tempted to
     * post the whole address block at it.
     */
    it('names an unexpected property rather than ignoring it', async () => {
      const { client, csrf } = await guest();

      const refusal = refusalOf(
        await check(client, csrf, { pincode: SERVICEABLE_PINCODE, city: 'Bengaluru' }).expect(
          HttpStatus.BAD_REQUEST,
        ),
      );

      expect(refusal.details?.city).toEqual(['property city should not exist']);
    });

    /**
     * **The header is not optional, even though the route is `@Public()` and reads nothing.**
     * `CsrfGuard` is global and applies to every method but GET/HEAD/OPTIONS, so a `POST` without a
     * matching `X-CSRF-Token` is a 403 regardless of what the handler does.
     *
     * That is the reason `PincodeChecker` must keep going through `lib/http`, which echoes the
     * readable `nn_csrf` cookie: a raw `fetch` would be a 403 the component renders as nothing at
     * all. It is also the fidelity gap in `frontend/src/test/checkout-api.stub.ts`, which — like
     * `cart-api.stub.ts` — does not model this check, so a green smoke suite is evidence about the
     * component and this assertion is the evidence about the wire.
     */
    it('refuses a check with no CSRF header, because the guard is global', async () => {
      const client = agent(integration.app);
      await client.get(CART).expect(200);

      const refusal = refusalOf(
        await client
          .post(PINCODE)
          .send({ pincode: SERVICEABLE_PINCODE })
          .expect(HttpStatus.FORBIDDEN),
      );

      expect(refusal.code).toBe('CSRF_TOKEN_INVALID');
    });
  });

  describe('placement, happy path', () => {
    /**
     * The money assertion, and it is the reason this suite exists.
     *
     * Compared against `GET /cart` field for field rather than against figures typed in here.
     * Hardcoded numbers pass while the server and the cart page disagree, which is the entire class
     * of bug spec §8 exists to prevent: the customer confirms one total on the checkout summary and
     * is billed another. `CartTotals` carries no `discount`, so the relation is
     * `order.total + order.discount === cart.total` — asserted here with a zero discount and again,
     * non-trivially, in the coupon case below.
     */
    it('places a COD order from the basket the server holds and prices it as the cart page did', async () => {
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds, cashews]);
      const cart = await cartOf(client);

      const response = await place(client, csrf).expect(HttpStatus.CREATED);
      const order = expectSuccess<AccountOrder>(response);

      expect(order.id).toEqual(expect.stringMatching(ORDER_NUMBER_PATTERN));
      expect({
        subtotal: order.subtotal,
        gst: order.gst,
        shipping: order.shipping,
        totalPlusDiscount: order.total + order.discount,
      }).toEqual({
        subtotal: cart.totals.subtotal,
        gst: cart.totals.gst,
        shipping: cart.totals.shipping,
        totalPlusDiscount: cart.totals.total,
      });
      expect(order.discount).toBe(0);
      // The per-destination charge is read, not defaulted: ₹79 is `serviceable_pincodes`' own
      // `shippingPaise` for prefix `5`, and a basket under the ₹999 threshold is what makes the
      // column observable at all.
      expect(order.shipping).toBe(79);

      expect(order.status).toBe('pending');
      expect(order.channel).toBe('retail');
      expect(order.paymentMethod).toBe('cod');
      expect(order.paymentStatus).toBe('pending');
      // The `estimatedDelivery` the pincode row dictates — `etaDays` 4 from `placedAt`, which is
      // disagreement 3 settled in favour of the one admin-editable figure.
      expect(Date.parse(order.estimatedDelivery) - Date.parse(order.placedAt)).toBe(
        4 * 24 * 60 * 60 * 1000,
      );

      // The stored row carries the same money in paise, so the mapper's rupee conversion is not the
      // only witness to what was billed.
      const stored = await theOnlyOrder();
      expect({
        subtotal: stored.subtotalPaise,
        discount: stored.discountPaise,
        gst: stored.gstPaise,
        shipping: stored.shippingPaise,
        total: stored.totalPaise,
      }).toEqual({
        subtotal: Math.round(cart.totals.subtotal * 100),
        discount: 0,
        gst: Math.round(cart.totals.gst * 100),
        shipping: 7900,
        total: Math.round(cart.totals.total * 100),
      });
      expect(stored.orderNumber).toBe(order.id);
      // The order belongs to the customer who placed it. Asserted because nothing else here would
      // notice a `userId` left null: the guest case below wants exactly that, so a placement that
      // anonymised *every* order would satisfy it and leave this customer's history empty for ever.
      expect(stored.userId).toBe(await userIdOf('b2c@demo.in'));
    });

    /**
     * What was written, as an invoice needs it — and the timeline, which is the assertion that
     * proves `CheckoutController.reload` runs.
     *
     * `place()` returns an entity whose `events` is `undefined`, so a controller that mapped it
     * directly would answer `timeline: []` — a brand-new order rendering a confirmation with no
     * history, in an `<ol>` `OrderTimeline.tsx` draws without complaint. The mapper throws instead,
     * so the failure here is a 500 rather than an empty list; either way this is the assertion that
     * sees it.
     */
    it('writes one snapshotted line per cart line, one pending event and one PENDING payment', async () => {
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds, cashews]);

      const order = expectSuccess<AccountOrder>(
        await place(client, csrf).expect(HttpStatus.CREATED),
      );

      const items = await itemsOf(order.id);
      expect(items).toHaveLength(2);
      // Every snapshot column filled. `hsn` especially: a compliant Indian GST invoice requires it
      // and nothing else can regenerate it once the catalogue row has moved on.
      expect(
        items.map((item) => ({ ...item, variantId: item.variantId === null ? null : 'set' })),
      ).toEqual([
        {
          productSlug: ALMONDS,
          name: 'Premium California Almonds',
          hsn: '0802',
          detail: '250g',
          size: '250g',
          qty: 2,
          unitPricePaise: 29900,
          lineTotalPaise: 59800,
          gstRate: '5.00',
          gstAmountPaise: 2990,
          variantId: 'set',
        },
        {
          productSlug: CASHEWS,
          name: 'W320 Cashews',
          hsn: '0802',
          detail: '100g',
          size: '100g',
          qty: 1,
          unitPricePaise: 13900,
          lineTotalPaise: 13900,
          gstRate: '5.00',
          gstAmountPaise: 695,
          variantId: 'set',
        },
      ]);
      // Spec §8: the order's GST is the sum of its own lines' GST, so an invoice reconciles against
      // the rows it is about. Compared against the lines rather than against 5% of the subtotal,
      // which is the aggregate arithmetic the Phase 1 mock used and disagreement 5 rejects.
      const storedOrder = await theOnlyOrder();
      expect(storedOrder.gstPaise).toBe(items.reduce((sum, item) => sum + item.gstAmountPaise, 0));

      /**
       * The wire's lines carry the slug that makes a fresh order's items link — disagreement 6.
       *
       * **Sorted by slug before comparing, and it has to be.** `ITEMS_IN_ORDER` asks Postgres for
       * `items: { id: 'ASC' }` — a v4 uuid, arbitrary but stable, and **re-randomised by every seed
       * run** — so a literal array in cart order passed or failed on a coin toss. Measured after
       * Task 20 ran the suite four times: three failures out of four runs, with the two lines
       * transposed and nothing else wrong. `orders.integration.spec.ts` sorts for the same reason and
       * says so; this assertion was written before that hazard was understood. Whether the *sequence*
       * is stable is a separate property, and `orders.integration.spec.ts` pins it by comparing both
       * paths against `ORDER BY i.id` rather than against a literal.
       */
      expect(
        [...order.items].sort((left, right) => (left.slug ?? '').localeCompare(right.slug ?? '')),
      ).toEqual([
        { slug: ALMONDS, name: 'Premium California Almonds', detail: '250g', qty: 2, total: 598 },
        { slug: CASHEWS, name: 'W320 Cashews', detail: '100g', qty: 1, total: 139 },
      ]);

      // Exactly one, `pending`, and attributed to nobody: the customer is not an *actor* in their
      // own order's creation, and `OrderEvent`'s own docblock says so.
      expect(await eventsOf(order.id)).toEqual([
        { status: 'pending', note: null, actorUserId: null },
      ]);
      // And the reload put it on the wire. An empty timeline here is the confirmation screen with no
      // history, which is what this assertion exists to catch.
      expect(order.timeline).toHaveLength(1);
      const [event] = order.timeline;
      expect(event?.status).toBe('pending');
      expect(event?.note).toBeUndefined();
      /**
       * `at` is the **row's own `createdAt`**, compared against the stored value rather than against
       * `order.placedAt`.
       *
       * Deliberately not "within a second of `placedAt`", which is the assertion this started as and
       * which compares two different clocks: `orders.placed_at` is a JavaScript `new Date()` computed
       * inside `place`, while `order_events."createdAt"` is left to the column's `DEFAULT now()` and
       * so is Postgres' `transaction_timestamp()`. Under testcontainers those are the host clock and
       * the container's, which is a flake waiting for a drifted VM — and the property actually worth
       * pinning is the mapper's own claim that `at` is the row's timestamp and not a re-derived one.
       */
      expect(Date.parse(event?.at ?? '')).toBe(Date.parse(await firstEventAt(order.id)));

      expect(await paymentsOf(order.id)).toEqual([
        {
          method: 'COD',
          status: 'PENDING',
          amountPaise: storedOrder.totalPaise,
          reference: null,
        },
      ]);

      // What was posted, snapshotted — including the optional second line, which `toAddress` omits
      // only when it is falsy.
      expect(storedOrder.addressSnapshot).toEqual(shipping());
      expect(order.address).toEqual(shipping());
      // `billingSameAsShipping` was not sent, so billing is null — "the same as shipping", which is
      // what Task 21's address book needs to tell apart from an address typed in twice.
      expect(storedOrder.billingSnapshot).toBeNull();
      expect(order.email).toBe(shipping().email);
    });

    it('queues order.confirmed with the order number, the shipping email and the rupee total', async () => {
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds, cashews]);

      const response = await place(client, csrf).expect(HttpStatus.CREATED);
      const order = expectSuccess<AccountOrder>(response);

      // `expect.any()` is typed `any`, widened through an annotated const as
      // `health.integration.spec.ts` does. The id itself is `signedIn`'s, not this test's to know;
      // what matters is that the row is attributed to a user at all rather than to nobody.
      const anyString: unknown = expect.any(String);

      const rows = await notificationsFor('order.confirmed', order.id);
      expect(rows).toEqual([
        {
          user_id: anyString,
          payload: {
            orderNumber: order.id,
            email: shipping().email,
            totalRupees: order.total,
          },
        },
      ]);
    });

    it('empties the basket, decrements exactly what was ordered, and leaves the ledger explaining the stock', async () => {
      const almondVariant = await variantIdOf(ALMONDS, '250g');
      const cashewVariant = await variantIdOf(CASHEWS, '100g');
      const before = await stockFor([almondVariant, cashewVariant]);

      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds, cashews]);
      await place(client, csrf).expect(HttpStatus.CREATED);

      // Emptied inside the transaction, so the basket cannot survive a committed order.
      expect((await cartOf(client)).lines).toEqual([]);

      const after = await stockFor([almondVariant, cashewVariant]);
      const fell = new Map(before.map((row) => [row.variantId, row.onHand]));
      // One object per variant, so a failure says which line moved wrong rather than only that a
      // number was off. `ledger === onHand` is the invariant `schema-invariants.integration.spec.ts`
      // asserts across the whole table, restated per touched variant because this is the first order
      // that ever moves stock and the ledger together.
      expect(
        after.map((row) => ({
          variantId: row.variantId,
          fellBy: (fell.get(row.variantId) ?? 0) - row.onHand,
          saleRows: row.saleRows,
          ledgerMatchesStock: row.ledger === row.onHand,
        })),
      ).toEqual(
        [
          { variantId: almondVariant, fellBy: almonds.qty, saleRows: 1, ledgerMatchesStock: true },
          { variantId: cashewVariant, fellBy: cashews.qty, saleRows: 1, ledgerMatchesStock: true },
        ].sort((left, right) => left.variantId.localeCompare(right.variantId)),
      );
    });

    it('queues stock.low when a placement takes a variant across its threshold', async () => {
      const variantId = await variantIdOf(ALMONDS, '250g');
      const [threshold] = await integration.dataSource.query<{ lowStockThreshold: number }[]>(
        'SELECT "lowStockThreshold" FROM inventory WHERE variant_id = $1',
        [variantId],
      );
      const lowStockThreshold = Number(threshold?.lowStockThreshold);

      /**
       * `almonds` (this file's own fixture) orders 2 packs, so stock is driven to
       * `lowStockThreshold + 1` first and the placement is the exact decrement that crosses it.
       * Through `setStock` rather than a bare `UPDATE`, for the reason its own docblock gives —
       * and `lowStockThreshold + 1` is itself above the threshold, so the fixture's own adjustment
       * crosses nothing and cannot be the notification this asserts.
       */
      await setStock(variantId, lowStockThreshold + 1);

      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds]);
      await place(client, csrf).expect(HttpStatus.CREATED);

      const rows = await integration.dataSource.query<{ payload: Record<string, unknown> }[]>(
        `SELECT payload FROM notifications WHERE template = 'stock.low' AND payload->>'variantId' = $1`,
        [variantId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toMatchObject({ variantId, onHand: lowStockThreshold - 1 });
    });

    /**
     * The discount relation, made non-trivial.
     *
     * With no coupon, `order.total + order.discount === cart.total` holds for any implementation
     * that ignores the discount entirely. `WELCOME10` is 10% capped at ₹200, so on a ₹598 basket the
     * discount is ₹59.80 and the identity is a real constraint. Not in the task's own case list, and
     * added because the money assertion is worth nothing while its only witness is zero.
     */
    it('honours a coupon, and the order total is the cart total less the discount', async () => {
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds]);
      const cart = await cartOf(client);

      const order = expectSuccess<AccountOrder>(
        // Lower case on purpose: `Coupon.code` is stored uppercase and matched case-insensitively.
        await place(client, csrf, body({ couponCode: 'welcome10' })).expect(HttpStatus.CREATED),
      );

      expect(order.discount).toBe(Math.round(cart.totals.subtotal * 10) / 100);
      expect(order.discount).toBeGreaterThan(0);
      expect(order.total).toBe(cart.totals.total - order.discount);
      // The canonical spelling, not what was typed.
      expect(order.couponCode).toBe(WELCOME10);
      expect((await theOnlyOrder()).couponCode).toBe(WELCOME10);
      expect(await countRows('SELECT count(*)::int AS count FROM coupon_redemptions')).toBe(1);
    });

    /**
     * **The ordinary retail path**, because neither `/checkout` nor `/order-success/$id` is guarded
     * in the frontend: most orders this shop takes are placed by someone who never signed in.
     *
     * The last assertion is load-bearing rather than pedantic. Tasks 13 and 23 make a guest's
     * confirmation screen read the **placement response** — they have to, since a guest cannot
     * re-fetch a `userId: null` order — so a field the mapper leaves `undefined` is a broken
     * confirmation for every guest, and the account read that would otherwise have caught it is one
     * a guest never reaches.
     */
    it('places an order for a guest carrying only nn_guest_token, and answers with a whole confirmation', async () => {
      const { client, csrf } = await guest();
      const written = await putCart(client, csrf, [almonds]);
      const token = cookieValue(written, GUEST_COOKIE);
      expect(token).not.toBe('');

      // A second visitor with their own basket, so "the right cart was emptied" is a measurement
      // rather than a tautology about the only cart in the database.
      const other = await guest();
      await putCart(other.client, other.csrf, [cashews]);

      const order = expectSuccess<AccountOrder>(
        await place(client, csrf).expect(HttpStatus.CREATED),
      );

      const stored = await theOnlyOrder();
      expect(stored.userId).toBeNull();
      expect(stored.orderNumber).toBe(order.id);

      // The basket the cookie owns is empty; the other visitor's is untouched.
      expect((await cartOf(client)).lines).toEqual([]);
      expect((await cartOf(other.client)).lines).toHaveLength(1);
      const carts = await integration.dataSource.query<{ guest_token: string; items: number }[]>(
        `SELECT c.guest_token, (SELECT count(*)::int FROM cart_items i WHERE i.cart_id = c.id) AS items
           FROM carts c ORDER BY c.guest_token`,
      );
      expect(carts.find((row) => row.guest_token === token)?.items).toBe(0);

      // Every field the confirmation screen renders, present. Reported as a list of names so a
      // failure says which one the mapper dropped.
      expect(
        missingFields(order, [
          'id',
          'email',
          'channel',
          'status',
          'placedAt',
          'estimatedDelivery',
          'timeline',
          'items',
          'subtotal',
          'discount',
          'gst',
          'shipping',
          'total',
          'address',
          'paymentMethod',
          'paymentStatus',
        ]),
      ).toEqual([]);
      expect(order.items.length).toBeGreaterThan(0);
      expect(order.timeline.length).toBeGreaterThan(0);
      expect(order.address).toEqual(shipping());
      expect([order.subtotal, order.gst, order.shipping, order.total].every(Number.isFinite)).toBe(
        true,
      );
      expect(order.total).toBeGreaterThan(0);
    });
  });

  describe('placement, refusals', () => {
    it('refuses 422 CART_EMPTY when the caller has no basket at all', async () => {
      const { client, csrf } = await guest();

      const refusal = refusalOf(await place(client, csrf).expect(HttpStatus.UNPROCESSABLE_ENTITY));

      expect(refusal.code).toBe('CART_EMPTY');
      expect(refusal.message).toMatch(/basket is empty/i);
      expect(await countOrders()).toBe(0);
    });

    /**
     * The other half of the same guard, and it was unproven until the Milestone 5 verification pass
     * mutated for it. `place` refuses on `cart === null || items.length === 0`; the case above only
     * reaches the first arm, so narrowing the condition to `cart === null` alone left **43 of 43
     * tests passing**. This is the arm that arm covers: a basket the customer filled and then
     * emptied leaves a `carts` row with no `cart_items`, and without the second check that request
     * places an order carrying no lines at all, priced at nothing but the shipping charge.
     */
    it('refuses 422 CART_EMPTY when the basket row exists but holds nothing', async () => {
      const { client, csrf } = await guest();
      await putCart(client, csrf, [almonds]).expect(HttpStatus.OK);
      await putCart(client, csrf, []).expect(HttpStatus.OK);

      const refusal = refusalOf(await place(client, csrf).expect(HttpStatus.UNPROCESSABLE_ENTITY));

      expect(refusal.code).toBe('CART_EMPTY');
      expect(await countOrders()).toBe(0);
    });

    /**
     * The refusal §10.4 names, reached the only way HTTP can reach it.
     *
     * `PlaceOrderDto`'s `@IsIn(['cod'])` rejects `"online"` at the pipe, so **no request carrying
     * `paymentMethod: "online"` can ever reach the service's 422** — see the next case. The 422 is
     * reachable over the wire with a legal `cod` body and the `codEnabled` setting switched off,
     * which is the same `PAYMENT_METHOD_UNAVAILABLE` code and, until this task, the setting was
     * seeded and read by nothing at all.
     */
    it('refuses 422 PAYMENT_METHOD_UNAVAILABLE once an admin switches COD off', async () => {
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds]);
      await setSetting('codEnabled', false);

      const refusal = refusalOf(await place(client, csrf).expect(HttpStatus.UNPROCESSABLE_ENTITY));

      expect(refusal.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
      expect(refusal.details).toEqual({ paymentMethod: 'cod' });
      expect(await countOrders()).toBe(0);
      // The basket survives a refusal, so the customer can come back to it.
      expect((await cartOf(client)).lines).toHaveLength(1);
    });

    /**
     * The DTO answers first, so `"online"` is a **400 and never the service's 422** over HTTP.
     *
     * Stated as a test rather than as a comment because the two rejections protect different
     * callers and the plan's own case list asks for the 422 here: the service branch is proved
     * directly below, and this is the proof that nothing can reach it through the router.
     */
    it('rejects paymentMethod "online" at the DTO, with 400 and the field named', async () => {
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds]);

      const refusal = refusalOf(
        await place(client, csrf, body({ paymentMethod: 'online' })).expect(HttpStatus.BAD_REQUEST),
      );

      expect(refusal.code).toBe('VALIDATION_FAILED');
      expect(refusal.details).toEqual({
        paymentMethod: ['Only cash on delivery is available at the moment'],
      });
      expect(await countOrders()).toBe(0);
    });

    /**
     * The service's own `"online"` refusal, called directly because the pipe makes it unreachable
     * over HTTP.
     *
     * Not a duplicate of the DTO case above: this branch answers an internal caller, a future
     * admin-placed order, or a pipe misconfigured to skip validation, and §10.4 requires the code
     * and the status. `CheckoutService` is taken from the real container, so this is the same
     * instance `POST /checkout/orders` uses.
     */
    it('refuses "online" in the service too, 422 PAYMENT_METHOD_UNAVAILABLE, for a caller that skipped the pipe', async () => {
      const { client, csrf } = await guest();
      const written = await putCart(client, csrf, [almonds]);
      const guestToken = cookieValue(written, GUEST_COOKIE);

      const dto: PlaceOrderDto = { shipping: shipping(), paymentMethod: 'online' };

      await expect(
        integration.app.get(CheckoutService).place({ guestToken }, dto, undefined),
      ).rejects.toMatchObject({
        code: 'PAYMENT_METHOD_UNAVAILABLE',
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
      expect(await countOrders()).toBe(0);
    });

    it('refuses 422 PINCODE_NOT_SERVICEABLE for a pincode the table says it does not deliver to', async () => {
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds]);

      const refusal = refusalOf(
        await place(client, csrf, body({ shipping: shipping(UNSERVICEABLE_PINCODE) })).expect(
          HttpStatus.UNPROCESSABLE_ENTITY,
        ),
      );

      expect(refusal.code).toBe('PINCODE_NOT_SERVICEABLE');
      expect(refusal.details).toEqual({ pincode: UNSERVICEABLE_PINCODE });
      expect(refusal.message).toContain(UNSERVICEABLE_PINCODE);
      expect(await countOrders()).toBe(0);

      // Delhi is the other half of disagreement 1: prefix `1` is seeded serviceable, so the
      // database — not the Phase 1 mock's `/^[2-8]\d{5}$/` — decides, and 110001 places.
      const delhi = await place(client, csrf, body({ shipping: shipping('110001') }));
      expect(delhi.status).toBe(HttpStatus.CREATED);
    });

    it('refuses 422 QUOTE_REQUIRED when the basket holds a quote-only product, and names it', async () => {
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [
        almonds,
        { slug: QUOTE_ONLY, mode: 'retail' as const, size: '250g', qty: 1 },
      ]);

      const refusal = refusalOf(await place(client, csrf).expect(HttpStatus.UNPROCESSABLE_ENTITY));

      expect(refusal.code).toBe('QUOTE_REQUIRED');
      // The offending line named, not a bare failure: the checkout page annotates a basket it is
      // showing, and the almond line must not be reported as a problem it is not.
      expect(offendingSlugs(refusal)).toEqual([QUOTE_ONLY]);
      expect(await countOrders()).toBe(0);
      expect(await countSaleRows()).toBe(0);
    });

    /**
     * 409, the item named, and **nothing written**.
     *
     * Where the refusal fires matters and is worth stating so nobody reads more into this than it
     * proves: with stock lowered before the request, `refuseBrokenLines` refuses on the same
     * snapshot the customer's basket was priced against, *before* the order row exists. So the "no
     * order, no ledger row, onHand unchanged" assertion is real but cannot fail for want of a
     * rollback — nothing has been written by the time it throws. The refusal that fires **after** a
     * partial write is `sell`'s, which needs a second connection to reach, and it is the HTTP race
     * below and `checkout-concurrency.integration.spec.ts`'s Proof B that hold it down.
     */
    it('refuses 409 OUT_OF_STOCK naming the item, and writes nothing at all', async () => {
      const variantId = await variantIdOf(ALMONDS, '250g');
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds]);
      // Lowered after the basket was built, so the line is legal in the cart and refused at
      // checkout — §10.1's "checked at add-to-cart for feedback and re-checked authoritatively at
      // checkout".
      await setStock(variantId, 1);
      const before = await stockFor([variantId]);

      const refusal = refusalOf(await place(client, csrf).expect(HttpStatus.CONFLICT));

      expect(refusal.code).toBe('OUT_OF_STOCK');
      expect(offendingSlugs(refusal)).toEqual([ALMONDS]);

      expect(await countOrders()).toBe(0);
      expect(await countSaleRows()).toBe(0);
      expect(await stockFor([variantId])).toEqual(before);
      expect(before[0]?.onHand).toBe(1);
      expect(before[0]?.ledger).toBe(1);
    });
  });

  /**
   * **The four things only a request through the router can prove**, each measured by hand during
   * Task 9 and deliberately thrown away so it would be written here as a committed assertion.
   */
  describe('the request pipeline around placement', () => {
    /**
     * A cold write is a 403 and that is correct: `CsrfGuard` needs a cookie *and* a matching header
     * on every method but GET/HEAD/OPTIONS. The basket exists first, so this request would otherwise
     * have succeeded — which is what makes the 403 attributable to the missing header rather than to
     * an empty cart.
     */
    it('refuses a placement with no X-CSRF-Token, 403, and writes no order', async () => {
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds]);

      const refusal = refusalOf(
        await client.post(ORDERS).send(body()).expect(HttpStatus.FORBIDDEN),
      );

      expect(refusal.code).toBe('CSRF_TOKEN_INVALID');
      expect(await countOrders()).toBe(0);
      // And the same request with the header placed, so the 403 is about the header and nothing else.
      expect((await place(client, csrf)).status).toBe(HttpStatus.CREATED);
    });

    /**
     * **That the interceptor was found when the route was built.**
     *
     * `checkout.module.spec.ts` proves the container *can* build
     * `CheckoutIdempotencyInterceptor` and `checkout.controller.spec.ts` proves the decorator is
     * *present*, but neither proves `InterceptorsContextCreator` found it —
     * `getInterceptorInstance` returning null leaves `createConcreteContext` filtering the enhancer
     * out **silently**, with the decorator still on the handler for a metadata test to find. Only a
     * request through the router can see it, and the way it sees it is that a stored key exists
     * afterwards in the scope §10.4 names.
     */
    it('mounts the idempotency interceptor on the route, storing the reply under the checkout scope', async () => {
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds]);
      const key = 'mounted-check-0001';

      const order = expectSuccess<AccountOrder>(
        await place(client, csrf, body(), { [IDEMPOTENCY_HEADER]: key }).expect(HttpStatus.CREATED),
      );

      const rows = await integration.dataSource.query<
        { key: string; scope: string; response_body: { id?: unknown } | null }[]
      >('SELECT key, scope, "responseBody" AS response_body FROM idempotency_keys');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.key).toBe(`${CHECKOUT_ORDERS_SCOPE}:${key}`);
      expect(rows[0]?.scope).toBe(CHECKOUT_ORDERS_SCOPE);
      // The reply itself, not merely a claim — a row whose `responseBody` stayed null replays as
      // "an identical request is already in progress" for ever.
      expect(rows[0]?.response_body?.id).toBe(order.id);
    });

    /**
     * An over-long key is a **400 naming the header**, not a 500.
     *
     * The stored key is `` `${scope}:${clientKey}` `` against a `varchar(200)`, so without the cap
     * the insert failed with SQLSTATE `22001`, which `claim()` does not recognise and which
     * therefore surfaced as an Internal Server Error for what is plainly a client error.
     */
    it('answers 400 for an Idempotency-Key over the cap, naming the header rather than 500ing', async () => {
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds]);
      const tooLong = keyOfLength(MAX_IDEMPOTENCY_KEY_LENGTH + 1);

      const refusal = refusalOf(
        await place(client, csrf, body(), { [IDEMPOTENCY_HEADER]: tooLong }).expect(
          HttpStatus.BAD_REQUEST,
        ),
      );

      expect(refusal.code).toBe('VALIDATION_FAILED');
      // Keyed by the header's canonical spelling, in the same `details` shape a rejected body gets,
      // so a client has one envelope to read.
      expect(refusal.details).toEqual({
        [IDEMPOTENCY_HEADER]: [
          `Must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters, and was ${tooLong.length}`,
        ],
      });
      expect(await countOrders()).toBe(0);
      expect(await countRows('SELECT count(*)::int AS count FROM idempotency_keys')).toBe(0);

      // The cap itself is inclusive, so the boundary is a real boundary and not one off.
      expect(
        (
          await place(client, csrf, body(), {
            [IDEMPOTENCY_HEADER]: keyOfLength(MAX_IDEMPOTENCY_KEY_LENGTH),
          })
        ).status,
      ).toBe(HttpStatus.CREATED);
    });

    /**
     * That `ValidationPipe` runs at all, which a controller spec cannot reach: calling a handler
     * directly never runs a pipe.
     *
     * `forbidNonWhitelisted` is spec §13's mass-assignment defence, and the field it must refuse
     * here is the one a client would most plausibly try to send — a total.
     */
    it('runs the DTO through ValidationPipe: an unknown property is 400 and named', async () => {
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds]);

      const refusal = refusalOf(
        await place(client, csrf, body({ totalPaise: 1 })).expect(HttpStatus.BAD_REQUEST),
      );

      expect(refusal.code).toBe('VALIDATION_FAILED');
      expect(Object.keys(refusal.details ?? {})).toEqual(['totalPaise']);
      expect(await countOrders()).toBe(0);
    });

    it('validates the nested address block, reporting the field by dotted path', async () => {
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds]);

      const refusal = refusalOf(
        await place(client, csrf, body({ shipping: { ...shipping(), pincode: '56000' } })).expect(
          HttpStatus.BAD_REQUEST,
        ),
      );

      expect(refusal.code).toBe('VALIDATION_FAILED');
      expect(refusal.details).toEqual({
        'shipping.pincode': ['Enter a valid 6-digit pincode'],
      });
      expect(await countOrders()).toBe(0);
    });
  });

  /**
   * **Idempotency — the four cases Task 1's unit spec could not reach**, because they need the
   * interceptor in front of a real transaction against a real database.
   *
   * **Compared with `toEqual`, never with `JSON.stringify`.** The first response's keys come out in
   * entity order and the replay's come back in `jsonb` round-trip order, so the two are semantically
   * identical and byte-different; `toEqual` is key-order-insensitive and is exactly the field
   * comparison this needs.
   */
  describe('idempotency', () => {
    it('replays the first order for the same Idempotency-Key, and decrements stock once', async () => {
      const variantId = await variantIdOf(ALMONDS, '250g');
      const before = await stockFor([variantId]);
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds]);
      const key = 'double-clicked-place-order';

      const first = await place(client, csrf, body(), { [IDEMPOTENCY_HEADER]: key });
      expect(first.status).toBe(HttpStatus.CREATED);
      const replay = await place(client, csrf, body(), { [IDEMPOTENCY_HEADER]: key });

      expect(replay.status).toBe(HttpStatus.CREATED);
      // Field for field. The status is deliberately *not* the assertion: the interceptor stores
      // `statusCode` and never reads it — a replay takes its status from the route's own
      // `@HttpCode(201)` — so "the replay returns the original 201" passes without the stored value
      // being consulted. The body and the single-order-row invariant are what carry the proof.
      expect(expectSuccess<AccountOrder>(replay)).toEqual(expectSuccess<AccountOrder>(first));

      expect(await countOrders()).toBe(1);
      const after = await stockFor([variantId]);
      expect((before[0]?.onHand ?? 0) - (after[0]?.onHand ?? 0)).toBe(almonds.qty);
      expect(after[0]?.saleRows).toBe(1);
      expect(after[0]?.ledger).toBe(after[0]?.onHand);
      // One event and one payment too: a second run of the handler would have written both again.
      const order = expectSuccess<AccountOrder>(first);
      expect(await eventsOf(order.id)).toHaveLength(1);
      expect(await paymentsOf(order.id)).toHaveLength(1);
    });

    /**
     * The double-click as it really arrives: **two requests genuinely in flight at once**, not one
     * after the other.
     *
     * The outcome is a disjunction and the test says so rather than picking a side, because both arms
     * are correct and which one fires depends on whether the winner has finished by the time the loser
     * reads the row. `claim()` inserts before running the handler, so exactly one insert survives the
     * primary key; the loser then either finds a stored response and replays it, or finds
     * `responseBody: null` — the winner still inside its transaction — and is told an identical
     * request is already in progress. **What is not a disjunction is the invariant**: one order, one
     * decrement, whichever arm fired. That is the property the interceptor exists for.
     *
     * Worth knowing why the sequential case above lands on the replay arm every time and this one need
     * not: the interceptor stores the response with `void this.keys.update(...)` — fire and forget, not
     * awaited — so the reply is on the wire before the row that holds it necessarily is. A round trip
     * plus a guard chain is more than enough head start in the sequential case; two simultaneous
     * requests have none.
     */
    it('collapses two simultaneous requests with one key into a single order', async () => {
      const variantId = await variantIdOf(ALMONDS, '250g');
      const before = await stockFor([variantId]);
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds]);
      const key = 'simultaneous-double-click';

      const responses = await Promise.all([
        place(client, csrf, body(), { [IDEMPOTENCY_HEADER]: key }),
        place(client, csrf, body(), { [IDEMPOTENCY_HEADER]: key }),
      ]);

      const statuses = responses.map((response) => response.status).sort();
      // Exactly one placed outright. Sorted, so 201 is first whichever arm the other took.
      expect(statuses[0]).toBe(CREATED);
      expect([CREATED, CONFLICT]).toContain(statuses[1]);

      const second = only(responses, statuses[1] ?? -1, 'second');
      if (statuses[1] === CONFLICT) {
        expect(refusalOf(second).message).toMatch(/already in progress/i);
      } else {
        const bodies = responses.map((response) => expectSuccess<AccountOrder>(response));
        expect(bodies[1]).toEqual(bodies[0]);
      }

      // The invariant, which holds on either arm: one order, one bag, one ledger row.
      expect(await countOrders()).toBe(1);
      const after = await stockFor([variantId]);
      expect((before[0]?.onHand ?? 0) - (after[0]?.onHand ?? 0)).toBe(almonds.qty);
      expect(after[0]?.saleRows).toBe(1);
      expect(after[0]?.ledger).toBe(after[0]?.onHand);
    });

    it('refuses 409 when the same Idempotency-Key arrives with a different body', async () => {
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds]);
      const key = 'same-key-different-body';

      await place(client, csrf, body(), { [IDEMPOTENCY_HEADER]: key }).expect(HttpStatus.CREATED);

      const refusal = refusalOf(
        await place(client, csrf, body({ specialInstructions: 'Leave with the neighbour' }), {
          [IDEMPOTENCY_HEADER]: key,
        }).expect(HttpStatus.CONFLICT),
      );

      expect(refusal.message).toMatch(/different request body/i);
      expect(await countOrders()).toBe(1);
    });

    /**
     * A different key places a second order — and the two order numbers differ, which is the first
     * thing in this repository to observe `order_number_seq` at all.
     *
     * Asserted as a **pattern and an inequality**, never as literals: `cleanDatabase`'s
     * `TRUNCATE … RESTART IDENTITY` cannot reset a standalone sequence, because no table owns it, so
     * values carry across `beforeEach` and across runs. A test pinning a specific number passes
     * alone and fails in suite order.
     */
    it('places a second order for a different key, with a fresh order number', async () => {
      const { client, csrf } = await signedIn();

      await putCart(client, csrf, [almonds]);
      const first = expectSuccess<AccountOrder>(
        await place(client, csrf, body(), { [IDEMPOTENCY_HEADER]: 'attempt-one' }).expect(
          HttpStatus.CREATED,
        ),
      );
      await putCart(client, csrf, [almonds]);
      const second = expectSuccess<AccountOrder>(
        await place(client, csrf, body(), { [IDEMPOTENCY_HEADER]: 'attempt-two' }).expect(
          HttpStatus.CREATED,
        ),
      );

      expect(first.id).toEqual(expect.stringMatching(ORDER_NUMBER_PATTERN));
      expect(second.id).toEqual(expect.stringMatching(ORDER_NUMBER_PATTERN));
      expect(second.id).not.toBe(first.id);
      expect(await countOrders()).toBe(2);
      expect((await storedOrders()).map((row) => row.orderNumber).sort()).toEqual(
        [first.id, second.id].sort(),
      );
    });

    /**
     * No key at all still works — and, more usefully, does **not** dedupe. An absent header means
     * "not a retryable attempt", which is the ordinary case for every route that is not placement,
     * and an interceptor that keyed on something else would silently collapse two real orders into
     * one.
     */
    it('places two separate orders when neither request carries a key', async () => {
      const { client, csrf } = await signedIn();

      await putCart(client, csrf, [almonds]);
      await place(client, csrf).expect(HttpStatus.CREATED);
      await putCart(client, csrf, [almonds]);
      await place(client, csrf).expect(HttpStatus.CREATED);

      expect(await countOrders()).toBe(2);
      expect(await countRows('SELECT count(*)::int AS count FROM idempotency_keys')).toBe(0);
    });
  });

  /**
   * **The oversell race, re-proved over the wire.**
   *
   * `checkout-concurrency.integration.spec.ts` calls `place()` directly and asserts
   * `DomainError.getStatus()`, so it establishes that the *service* serialises and says nothing
   * about what a client receives. Task 7 explicitly could not assert a 201, because no HTTP layer
   * existed yet. This is also the first point at which the idempotency interceptor sits in front of
   * the decrement.
   *
   * **Which refusal path fires is not determined, and that is deliberate.** Both placements read
   * their basket at the top of their own transaction, so the usual interleaving has both see
   * `onHand = 1` and the loser refused by the conditional `UPDATE` in `sell`; but if the winner
   * commits first, the loser is refused earlier by `refuseBrokenLines`. Both are 409 `OUT_OF_STOCK`.
   * Pinning one would make this a timing detector — the mechanism is Proof B's to hold down.
   */
  describe('two clients, one bag', () => {
    it('answers 201 to one client and 409 OUT_OF_STOCK to the other, selling the bag once', async () => {
      const variantId = await variantIdOf(ALMONDS, '250g');
      const line = { slug: ALMONDS, mode: 'retail' as const, size: '250g', qty: 1 };

      const first = await guest();
      const second = await guest();
      await putCart(first.client, first.csrf, [line]);
      await putCart(second.client, second.csrf, [line]);
      await setStock(variantId, 1);

      const responses = await Promise.all([
        place(first.client, first.csrf),
        place(second.client, second.csrf),
      ]);

      // Sorted, because which client wins is exactly what is not determined. Compared as a pair so
      // a failure prints both statuses rather than only the count of one of them.
      expect(responses.map((response) => response.status).sort()).toEqual([CREATED, CONFLICT]);

      const winner = only(responses, CREATED, 'placed');
      const loser = only(responses, CONFLICT, 'refused');

      const refusal = refusalOf(loser);
      expect(refusal.code).toBe('OUT_OF_STOCK');
      // The refusal names what to fix, from whichever of the two paths fired: `sell`'s names a
      // `variantId`, `refuseBrokenLines`' names the slug.
      const named = [
        ...(typeof refusal.details?.variantId === 'string' ? [refusal.details.variantId] : []),
        ...offendingSlugs(refusal),
      ];
      expect(named.length).toBeGreaterThan(0);
      expect(named.every((name) => name === variantId || name === ALMONDS)).toBe(true);

      expect(expectSuccess<AccountOrder>(winner).id).toEqual(
        expect.stringMatching(ORDER_NUMBER_PATTERN),
      );

      expect(await countOrders()).toBe(1);
      const [stock] = await stockFor([variantId]);
      // 0, not -1: -1 is what overselling looks like, and `ck_inventory_non_negative` should have
      // made it unreachable, so if it appears two independent guards have failed.
      expect(stock?.onHand).toBe(0);
      expect(stock?.ledger).toBe(0);
      expect(stock?.saleRows).toBe(1);
    });

    /**
     * And a replayed key does not decrement twice while a rival is racing the same shelf.
     *
     * The single-threaded replay case above proves the interceptor stops a second decrement; this is
     * the same property with the last bag genuinely contested, which is the state a real
     * double-click arrives in.
     */
    it('does not let a replayed key take a second bag while another client is racing for it', async () => {
      const variantId = await variantIdOf(ALMONDS, '250g');
      const line = { slug: ALMONDS, mode: 'retail' as const, size: '250g', qty: 1 };

      const buyer = await guest();
      const rival = await guest();
      await putCart(buyer.client, buyer.csrf, [line]);
      await putCart(rival.client, rival.csrf, [line]);
      await setStock(variantId, 2);

      const key = 'contended-double-click';
      const first = await place(buyer.client, buyer.csrf, body(), { [IDEMPOTENCY_HEADER]: key });
      expect(first.status).toBe(HttpStatus.CREATED);

      const [replay, rivalResponse] = await Promise.all([
        place(buyer.client, buyer.csrf, body(), { [IDEMPOTENCY_HEADER]: key }),
        place(rival.client, rival.csrf),
      ]);

      expect(replay.status).toBe(HttpStatus.CREATED);
      expect(expectSuccess<AccountOrder>(replay)).toEqual(expectSuccess<AccountOrder>(first));
      expect(rivalResponse.status).toBe(HttpStatus.CREATED);

      // Two orders — the buyer's one and the rival's one — and two bags gone, not three.
      expect(await countOrders()).toBe(2);
      const [stock] = await stockFor([variantId]);
      expect(stock?.onHand).toBe(0);
      expect(stock?.saleRows).toBe(2);
      expect(stock?.ledger).toBe(0);
    });
  });

  /**
   * Coupon preview — read-only, and read from **the caller's own cart**. Spec §13: the client
   * supplies a code and nothing that decides money.
   */
  describe('coupon preview', () => {
    interface PreviewBody {
      eligible: boolean;
      couponCode?: string;
      discount?: number;
      eligibleSubtotal?: number;
      reason?: string;
      minOrderValue?: number;
    }

    const preview = (client: Client, csrf: string, code: string): Test =>
      client.post(PREVIEW).set(CSRF_HEADER, csrf).send({ code });

    it('previews a percentage discount against the caller own cart, in rupees', async () => {
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds]);
      const cart = await cartOf(client);

      const result = expectSuccess<PreviewBody>(
        await preview(client, csrf, 'welcome10').expect(HttpStatus.OK),
      );

      expect(result).toEqual({
        eligible: true,
        // Canonical spelling, not what was typed.
        couponCode: WELCOME10,
        // 10% of the basket the *server* holds, derived from `GET /cart` rather than typed in.
        discount: Math.round(cart.totals.subtotal * 10) / 100,
        eligibleSubtotal: cart.totals.subtotal,
      });
      // Rupees, not stringified paise: `CouponService` answers in `bigint` and an unmapped figure
      // would reach the wire as the string "5980" through `bigint-json.ts`, which the page renders
      // as ₹NaN or concatenates.
      expect(typeof result.discount).toBe('number');
      expect(result.discount).toBeGreaterThan(0);
    });

    /**
     * `BULK500` is `channel: BULK` and `minOrderValuePaise` ₹10,000, and a 10 kg basket of almonds
     * at the seeded 10–24 kg rate is ₹8,990 — under the minimum on the one channel the coupon
     * accepts. The response carries the figure to reach, because that is the one refusal a customer
     * can act on.
     */
    it('refuses below the minimum order value, and says what the minimum is', async () => {
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [{ slug: ALMONDS, mode: 'bulk' as const, kg: 10, qty: 1 }]);
      const cart = await cartOf(client);
      expect(cart.totals.subtotal).toBeGreaterThan(0);
      expect(cart.totals.subtotal).toBeLessThan(10_000);

      const result = expectSuccess<PreviewBody>(
        await preview(client, csrf, BULK500).expect(HttpStatus.OK),
      );

      expect(result).toEqual({
        eligible: false,
        reason: 'COUPON_MIN_ORDER_VALUE',
        minOrderValue: 10_000,
      });
    });

    it('refuses a bulk-only coupon on a retail basket, and carries no minimum with it', async () => {
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds]);

      const result = expectSuccess<PreviewBody>(
        await preview(client, csrf, BULK500).expect(HttpStatus.OK),
      );

      // `minOrderValue` omitted rather than sent as 0, which would read as "spend ₹0 and it works".
      expect(result).toEqual({ eligible: false, reason: 'COUPON_NOT_APPLICABLE' });
      expect(Object.keys(result)).not.toContain('minOrderValue');
    });

    /**
     * The decision recorded in Task 4: a guest is **eligible** for a `firstOrderOnly` coupon,
     * because by definition it is their first order. The other reading — refuse what you cannot
     * verify — blocks precisely the customer a first-order coupon exists to attract, and every guest
     * is that customer.
     */
    it('lets a guest preview a firstOrderOnly coupon', async () => {
      const { client, csrf } = await guest();
      await putCart(client, csrf, [almonds]);

      const result = expectSuccess<PreviewBody>(
        await preview(client, csrf, WELCOME10).expect(HttpStatus.OK),
      );

      expect(result.eligible).toBe(true);
      expect(result.couponCode).toBe(WELCOME10);
      expect(result.discount).toBeGreaterThan(0);
    });

    it('refuses an unknown code as COUPON_INVALID rather than failing the request', async () => {
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds]);

      const result = expectSuccess<PreviewBody>(
        await preview(client, csrf, 'NOSUCHCODE').expect(HttpStatus.OK),
      );

      expect(result).toEqual({ eligible: false, reason: 'COUPON_INVALID' });
    });
  });
});
