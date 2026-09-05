import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import {
  toPaise,
  type AccountOrder,
  type Product as WireProduct,
  type QuotePreviewResponse,
} from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedPincodes } from '../../src/database/seeds/pincodes.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { seedUsers } from '../../src/database/seeds/users.seed';
import { CustomerSegment } from '../../src/entities/enums';
import { Business } from '../../src/entities/identity/business.entity';
import { PricingTier } from '../../src/entities/catalog/pricing-tier.entity';
import { Product } from '../../src/entities/catalog/product.entity';
import { TEST_PASSWORD } from '../factories/user.factory';
import { agent, cookieValue, expectSuccess, useIntegrationApp } from './helpers';

/**
 * Milestone 7's own integration proof — 7a's Task 6. Everything Tasks 2 through 5 built, against
 * real Postgres, over real HTTP. Written last, after Task 5, so it can assert **agreement between
 * surfaces** rather than any one implementation: `CatalogService` (Task 3), `CartReadService` and
 * `CheckoutService` (Task 4), and the bulk quote-preview (Task 5) each resolve pricing
 * independently, and the leak this milestone exists to close was exactly two of those disagreeing
 * about the same database rows. A unit double models one path; only a real database run through
 * every route proves the four agree.
 */
const CSRF_COOKIE = 'nn_csrf';
const CSRF_HEADER = 'X-CSRF-Token';

const CATALOG = '/api/v1/catalog';
const CART = '/api/v1/cart';
const PLACE = '/api/v1/checkout/orders';
const LOGIN = '/api/v1/auth/login';
const REGISTER = '/api/v1/auth/register';

const ALMONDS = 'premium-california-almonds';

/** Serviceable — prefix `5` — and irrelevant to every total compared here: every basket here is
 * well past the ₹999 free-shipping threshold, so shipping is always ₹0 and cannot smuggle a
 * disagreement into a total that looks right for the wrong reason. */
const ADDRESS = {
  fullName: 'Test Buyer',
  phone: '9876543210',
  email: 'buyer@example.in',
  line1: '1 Test Lane',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};

describe('pricing — one kilogram, four surfaces, one price', () => {
  const integration = useIntegrationApp();

  /**
   * Empties the rate limiter between tests — this file signs in, registers and places orders
   * repeatedly, and `useIntegrationApp` boots one application for the whole file, so
   * `ThrottlerGuard`'s in-memory storage is shared across every test in it. Same reasoning as
   * `cart.integration.spec.ts` and `orders.integration.spec.ts`.
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
    await seedPincodes(integration.dataSource);
  });

  /** Signs in a seeded account and returns a cookie-persisting client plus its CSRF token. */
  async function signedIn(email: string, password = 'Password123!') {
    const client = agent(integration.app);
    const login = await client.post(LOGIN).send({ email, password }).expect(200);
    return { client, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  }

  /** An anonymous client primed with `nn_csrf`, the bootstrap every other integration spec uses. */
  async function guest() {
    const client = agent(integration.app);
    const primer = await client.get(`${CATALOG}/products`).expect(200);
    return { client, csrf: cookieValue(primer, CSRF_COOKIE) };
  }

  /**
   * A new business, created through `POST /auth/register` rather than by raw insert — the plan's
   * own instruction for this task, "so the fixture is one the application can actually produce."
   * Its `Business.segment` defaults to `DEFAULT`, because nothing here promotes it — self-declared
   * `businessType` never chooses a price band, and there is no admin endpoint yet that could.
   */
  async function registerBusiness(email: string) {
    const client = agent(integration.app);
    const response = await client
      .post(REGISTER)
      .send({
        name: 'A Business Owner',
        email,
        phone: '9876500001',
        password: TEST_PASSWORD,
        isBusiness: true,
        company: {
          companyName: 'A Registered Business',
          contactPerson: 'Owner',
          businessType: 'Distributor',
        },
      })
      .expect(201);
    return { client, csrf: expectSuccess<{ csrfToken: string }>(response).csrfToken };
  }

  type Viewer = { client: ReturnType<typeof agent>; csrf: string };

  /**
   * The four surfaces, for one viewer and one weight, each read independently rather than derived
   * from one another — the whole point of the comparison below. Placing a real order on every row
   * (including the guest one) is what Step 2's table asks for: "four times", not three plus an
   * assumption about the fourth.
   */
  async function priceAcrossSurfaces(
    viewer: Viewer,
    kg: number,
    /**
     * Who reads the catalogue, when it differs from `viewer` — only for a weight past a capped
     * business ladder. `GET /catalog/products/:slug` takes no weight and calls `resolveTiers`
     * alone, never `resolveTiersForWeight`, so a business whose own ladder stops at 20kg has
     * nothing covering 30kg in *their own* `bulkTiers` at all — that is `resolveTiers` working
     * exactly as designed, rendering one whole ladder rather than composing a rung for a weight it
     * was never asked about. `resolveTiersForWeight`'s fallback is defined as `resolveTiers(product,
     * null)` — literally the public catalogue's own ladder — so that is the reading being compared
     * against, not a nonsensical "this business's catalogue page at 30kg".
     */
    catalogueViewer: Viewer = viewer,
  ): Promise<{ catalogue: number; quotePreview: number; cart: number; order: number }> {
    const { client, csrf } = viewer;

    const product = expectSuccess<WireProduct>(
      await catalogueViewer.client.get(`${CATALOG}/products/${ALMONDS}`).expect(200),
    );
    const tier = product.bulkTiers.find(
      (candidate) => candidate.minKg <= kg && (candidate.maxKg === null || kg <= candidate.maxKg),
    );
    if (tier === undefined || tier.pricePerKg === null) {
      throw new Error(`Test setup error: no priced tier covers ${kg}kg for this viewer`);
    }
    const catalogue = tier.pricePerKg * kg;

    const preview = expectSuccess<QuotePreviewResponse>(
      await client
        .post(`${CATALOG}/bulk/quote-preview`)
        .set(CSRF_HEADER, csrf)
        .send({ slug: ALMONDS, kg })
        .expect(200),
    );
    if (preview.total === null) {
      throw new Error(`Test setup error: quote-preview answered quoteRequired at ${kg}kg`);
    }
    const quotePreview = preview.total;

    await client
      .put(CART)
      .set(CSRF_HEADER, csrf)
      .send({ lines: [{ slug: ALMONDS, mode: 'bulk', kg, qty: 1 }] })
      .expect(200);
    const cartBody = expectSuccess<{ totals: { subtotal: number } }>(
      await client.get(CART).expect(200),
    );
    const cart = cartBody.totals.subtotal;

    const placed = expectSuccess<AccountOrder>(
      await client
        .post(PLACE)
        .set(CSRF_HEADER, csrf)
        .send({ shipping: ADDRESS, paymentMethod: 'cod' })
        .expect(201),
    );
    const line = placed.items[0];
    if (line === undefined || line.total === null) {
      throw new Error(`Test setup error: the placed order carries no priced line at ${kg}kg`);
    }
    const order = line.total;

    return { catalogue, quotePreview, cart, order };
  }

  /** Every surface answered the same figure, and that figure is the one this test expected. */
  function expectAgreement(
    result: { catalogue: number; quotePreview: number; cart: number; order: number },
    expected: number,
  ): void {
    expect(result.catalogue).toBe(expected);
    expect(result.quotePreview).toBe(expected);
    expect(result.cart).toBe(expected);
    expect(result.order).toBe(expected);
  }

  /**
   * Step 1: the ladders the seed does not have. All 135 seeded tiers are `DEFAULT`/null, which is
   * the state 7a must not change — so it cannot be tested against alone, and every scenario below
   * is arranged by hand on top of it.
   */
  async function arrangeLadders(): Promise<{
    almondsId: string;
    business1Id: string;
    business2Id: string;
  }> {
    const almonds = await integration.dataSource
      .getRepository(Product)
      .findOneOrFail({ where: { slug: ALMONDS }, select: { id: true } });
    const business1 = await integration.dataSource
      .getRepository(Business)
      .findOneOrFail({ where: { companyName: 'Anand Sweets & Namkeen' }, select: { id: true } });

    const tiers = integration.dataSource.getRepository(PricingTier);

    // A RETAILER ladder, segment-wide (no business of its own), cheaper than DEFAULT at every rung
    // it covers. DEFAULT's 10-24kg rung is ₹899/kg; this one covers 1-49kg at a flat ₹750/kg.
    await tiers.insert({
      productId: almonds.id,
      minKg: '1.00',
      maxKg: '49.00',
      pricePerKgPaise: toPaise(750),
      segment: CustomerSegment.RETAILER,
      businessId: null,
    });

    // `b2b@demo.in`'s own negotiated ladder — cheaper still, and deliberately capped at 20kg so
    // the non-merge rule is observable at 30kg: this business's own agreement says nothing about a
    // weight past what it covers, and the honest answer there is `DEFAULT`'s, not this rate.
    await tiers.insert({
      productId: almonds.id,
      minKg: '1.00',
      maxKg: '20.00',
      pricePerKgPaise: toPaise(700),
      segment: CustomerSegment.DEFAULT,
      businessId: business1.id,
    });

    // A second business, registered through the API, with a `DEFAULT`-segment ladder scoped to
    // its own `businessId` — the exact row `product.mapper.ts`'s docblock warns about: a
    // `DEFAULT`-segment tier scoped to one business is a legitimate row ("this business also gets
    // ordinary list pricing"), and `segment` alone would leak it to every other buyer in that
    // segment. Priced identically to the real `DEFAULT` ladder, rung for rung, so this business's
    // own resolution and the generic fallback are numerically indistinguishable — "the no-op
    // guarantee" the plan's matrix names, proved through the `mine` branch rather than by simply
    // giving this business no ladder at all.
    const secondEmail = 'second-bulk-business@demo.in';
    const second = await registerBusiness(secondEmail);
    const secondUser = await integration.dataSource.query<{ id: string }[]>(
      `SELECT id FROM users WHERE email = $1`,
      [secondEmail.toLowerCase()],
    );
    const business2 = await integration.dataSource
      .getRepository(Business)
      .findOneOrFail({ where: { userId: secondUser[0]?.id }, select: { id: true } });

    await tiers.insert([
      {
        productId: almonds.id,
        minKg: '1.00',
        maxKg: '4.00',
        pricePerKgPaise: toPaise(999),
        segment: CustomerSegment.DEFAULT,
        businessId: business2.id,
      },
      {
        productId: almonds.id,
        minKg: '5.00',
        maxKg: '9.00',
        pricePerKgPaise: toPaise(949),
        segment: CustomerSegment.DEFAULT,
        businessId: business2.id,
      },
      {
        productId: almonds.id,
        minKg: '10.00',
        maxKg: '24.00',
        pricePerKgPaise: toPaise(899),
        segment: CustomerSegment.DEFAULT,
        businessId: business2.id,
      },
      {
        productId: almonds.id,
        minKg: '25.00',
        maxKg: '49.00',
        pricePerKgPaise: toPaise(849),
        segment: CustomerSegment.DEFAULT,
        businessId: business2.id,
      },
      {
        productId: almonds.id,
        minKg: '50.00',
        maxKg: null,
        pricePerKgPaise: null,
        segment: CustomerSegment.DEFAULT,
        businessId: business2.id,
      },
    ]);

    void second; // its client is not needed again; only the row it created is.

    return { almondsId: almonds.id, business1Id: business1.id, business2Id: business2.id };
  }

  /**
   * Step 2: the agreement matrix. One product, five viewers, and — for the first four rows — one
   * weight. `guest`, the `DEFAULT` business and the `RETAILER` business are asserted together
   * because they share that weight; the ladder-holding business gets its own two-row test since it
   * alone exercises `resolveTiersForWeight`'s fallback.
   *
   * Compared against each other and against one pinned anchor, never against a second set of
   * hand-typed figures for every row — a hardcoded number passes while two surfaces disagree, which
   * is the entire class of bug this task exists to close.
   */
  it('prices a guest, a DEFAULT business and a RETAILER business identically at 10kg', async () => {
    await arrangeLadders();

    const guestViewer = await guest();
    const secondBusiness = await signedIn('second-bulk-business@demo.in', TEST_PASSWORD);
    const retailerBusiness = await registerBusiness('retailer-business@demo.in');
    await integration.dataSource.query(
      `UPDATE businesses SET segment = 'RETAILER'
         WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      ['retailer-business@demo.in'],
    );

    const guestResult = await priceAcrossSurfaces(guestViewer, 10);
    // The anchor: DEFAULT's 10-24kg rung is ₹899/kg (`round(999 * 0.9)`), so 10kg is ₹8,990.
    expectAgreement(guestResult, 8_990);

    const defaultBusinessResult = await priceAcrossSurfaces(secondBusiness, 10);
    expectAgreement(defaultBusinessResult, 8_990);

    const retailerResult = await priceAcrossSurfaces(retailerBusiness, 10);
    expectAgreement(retailerResult, 7_500);

    // And the three agree with each other exactly where the plan says they must, and disagree
    // exactly where a negotiated rate says they should.
    expect(defaultBusinessResult.order).toBe(guestResult.order);
    expect(retailerResult.order).not.toBe(guestResult.order);
  });

  it("prices the ladder-holding business at its own rate inside its ladder, and DEFAULT's past it", async () => {
    await arrangeLadders();
    const business1 = await signedIn('b2b@demo.in');

    const inside = await priceAcrossSurfaces(business1, 10);
    // ₹700/kg × 10kg — the negotiated rate, inside the 1-20kg agreement.
    expectAgreement(inside, 7_000);

    // The catalogue at 30kg is read as a guest: `GET /catalog/products/:slug` renders this
    // business's own whole ladder, which simply does not extend to 30kg — `resolveTiers` has no
    // weight to test coverage against and correctly never composes one. `resolveTiersForWeight`'s
    // fallback is defined as `resolveTiers(product, null)`, so the public catalogue's own ladder is
    // what the comparison is against, not a page this business's own product view cannot render.
    const past = await priceAcrossSurfaces(business1, 30, await guest());
    // 30kg is past the 20kg ceiling this business agreed to. The honest answer is DEFAULT's
    // 25-49kg rung (₹849/kg × 30kg = ₹25,470) — not this business's own ₹700, and not some
    // interpolation between the two. `resolveTiersForWeight` swaps the whole ladder; it does not
    // stitch two together.
    expectAgreement(past, 25_470);
    expect(past.order).not.toBe(inside.order);
  });

  /**
   * Step 3: the order is what actually got billed, pinned in paise rather than rupees. Plan 3
   * measured that a server figure and a client figure can render the same string while differing
   * by 25 paise — the column is the only place that disagreement cannot hide. Builds on the order
   * the previous test's "inside" case places, but places its own rather than reading that one back,
   * so this test stands on its own under `-t`.
   */
  it("bills the ladder-holding business's order in the exact paise the ladder names", async () => {
    await arrangeLadders();
    const business1 = await signedIn('b2b@demo.in');

    await business1.client
      .put(CART)
      .set(CSRF_HEADER, business1.csrf)
      .send({ lines: [{ slug: ALMONDS, mode: 'bulk', kg: 10, qty: 1 }] })
      .expect(200);
    const placed = expectSuccess<AccountOrder>(
      await business1.client
        .post(PLACE)
        .set(CSRF_HEADER, business1.csrf)
        .send({ shipping: ADDRESS, paymentMethod: 'cod' })
        .expect(201),
    );

    const rows = await integration.dataSource.query<
      { unit_price: string; line_total: string; subtotal: string }[]
    >(
      `SELECT oi."unitPricePaise"::text  AS unit_price,
              oi."lineTotalPaise"::text  AS line_total,
              o."subtotalPaise"::text    AS subtotal
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE o."orderNumber" = $1`,
      [placed.id],
    );

    expect(rows).toHaveLength(1);
    // ₹700/kg, in paise, and 10kg of it — the negotiated rate the ladder named, off the columns.
    expect(rows[0]?.unit_price).toBe('70000');
    expect(rows[0]?.line_total).toBe('700000');
    expect(rows[0]?.subtotal).toBe('700000');
  });
});
