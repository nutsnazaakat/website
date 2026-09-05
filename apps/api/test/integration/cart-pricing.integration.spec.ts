import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import { toPaise, type CartValidationResult, type Product as WireProduct } from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { seedUsers } from '../../src/database/seeds/users.seed';
import { CustomerSegment } from '../../src/entities/enums';
import { Business } from '../../src/entities/identity/business.entity';
import { PricingTier } from '../../src/entities/catalog/pricing-tier.entity';
import { Product } from '../../src/entities/catalog/product.entity';
import { TEST_PASSWORD } from '../factories/user.factory';
import { agent, cookieValue, expectSuccess, useIntegrationApp } from './helpers';

/**
 * Cookie and header names spelled out rather than imported — wire contract, same reasoning as
 * `cart.integration.spec.ts` and `auth.integration.spec.ts`.
 */
const CSRF_COOKIE = 'nn_csrf';
const CSRF_HEADER = 'X-CSRF-Token';

const CART = '/api/v1/cart';
const LOGIN = '/api/v1/auth/login';
const REGISTER = '/api/v1/auth/register';
const CATALOG = '/api/v1/catalog';

const ALMONDS = 'premium-california-almonds';

/**
 * Task 4's Step 3 proof — "the leak, as a test" — and Step 2's guest-then-sign-in reprice, over
 * real Postgres and real HTTP.
 *
 * **Why an integration test and not a unit test**, in the plan's own words: "The leak is a
 * disagreement between two code paths over the same database rows, and a unit double models one
 * path." `cart-read.service.spec.ts` and `checkout.service.spec.ts` each prove their own path in
 * isolation; only a real database can prove the two paths — `CartReadService` and
 * `CatalogService` — read the *same* `pricing_tiers` rows and agree.
 *
 * This is deliberately narrower than Task 6's `pricing.integration.spec.ts`, which does not exist
 * yet: no `POST /catalog/bulk/quote-preview` (Task 5) and no placed-order column assertions (Task
 * 6 Step 3). This file proves Task 4 alone closes the leak on the two surfaces Task 4 touches —
 * `GET /cart` / `POST /cart/validate`, plus the catalogue read Task 3 already covers — before
 * Task 6 asserts all four surfaces agree.
 */
describe('cart pricing and the business viewer', () => {
  const integration = useIntegrationApp();

  /** Same reasoning as `cart.integration.spec.ts`: this file signs in and registers more than
   * once, and the throttler is shared across every test in the file. */
  beforeEach(() => {
    const throttler = integration.app.get<ThrottlerStorageService>(ThrottlerStorage);
    throttler.onApplicationShutdown();
    throttler.storage.clear();
  });

  beforeEach(async () => {
    await seedSettings(integration.dataSource);
    await seedUsers(integration.dataSource);
    await seedCatalog(integration.dataSource);
  });

  /** Signs in a seeded account and returns a cookie-persisting client plus its CSRF token. */
  async function signedIn(email: string, password = 'Password123!') {
    const client = agent(integration.app);
    const login = await client.post(LOGIN).send({ email, password }).expect(200);
    return { client, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  }

  /** An anonymous client primed with `nn_csrf`, the same bootstrap `cart.integration.spec.ts` uses. */
  async function guest() {
    const client = agent(integration.app);
    const primer = await client.get(CART).expect(200);
    return { client, csrf: cookieValue(primer, CSRF_COOKIE) };
  }

  /**
   * A second business, created through `POST /auth/register` rather than by raw insert — the
   * same discipline Task 6 states explicitly ("so the fixture is one the application can
   * actually produce"). Its `Business.segment` is whatever the column defaults to, `DEFAULT`,
   * because nothing here promotes it — this business's whole point is to have no ladder of its
   * own, so it falls through to the same rung a guest does.
   */
  async function registerBusiness(email: string) {
    const client = agent(integration.app);
    const response = await client
      .post(REGISTER)
      .send({
        name: 'Second Business Owner',
        email,
        phone: '9876500000',
        password: TEST_PASSWORD,
        isBusiness: true,
        company: {
          companyName: 'Second Business Pvt Ltd',
          contactPerson: 'Second Owner',
          businessType: 'Distributor',
        },
      })
      .expect(201);
    return { client, csrf: expectSuccess<{ csrfToken: string }>(response).csrfToken };
  }

  /**
   * Business #1's negotiated tier plus business #2's account — the arrangement both tests in
   * this file need. The 25–49kg slab is the seeded DEFAULT ladder's own band (₹849/kg —
   * `round(999 * 0.85)`), so the negotiated row at ₹700/kg is undercutting that exact band rather
   * than adding a new one, which is what makes "which tier answered" unambiguous at 30kg.
   */
  async function arrangeNegotiatedTier() {
    const almonds = await integration.dataSource
      .getRepository(Product)
      .findOneOrFail({ where: { slug: ALMONDS }, select: { id: true } });
    const business1 = await integration.dataSource
      .getRepository(Business)
      .findOneOrFail({ where: { companyName: 'Anand Sweets & Namkeen' }, select: { id: true } });

    await integration.dataSource.getRepository(PricingTier).insert({
      productId: almonds.id,
      minKg: '25.00',
      maxKg: '49.00',
      pricePerKgPaise: toPaise(700),
      segment: CustomerSegment.DEFAULT,
      businessId: business1.id,
    });

    return { almondsId: almonds.id, business1Id: business1.id };
  }

  const bulkLine = (kg: number) => ({ slug: ALMONDS, mode: 'bulk' as const, kg, qty: 1 });

  it('prices a negotiated tier for the business it was agreed with, and DEFAULT for everyone else', async () => {
    await arrangeNegotiatedTier();
    const second = await registerBusiness('second-business@demo.in');
    const first = await signedIn('b2b@demo.in');
    const anonymous = await guest();

    const validate = async (client: typeof first.client, csrf: string) =>
      expectSuccess<CartValidationResult>(
        await client
          .post(`${CART}/validate`)
          .set(CSRF_HEADER, csrf)
          .send({ lines: [bulkLine(30)] })
          .expect(200),
      );

    const negotiated = await validate(first.client, first.csrf);
    // ₹700/kg × 30kg — the rate agreed with this business alone.
    expect(negotiated.totals.subtotal).toBe(21_000);
    expect(negotiated.lines[0]?.lineTotal).toBe(21_000);

    // The leak, asserted absent: a second business, with no ladder of its own, must not see
    // the first business's negotiated rate. Unfiltered `toProductRules` would have let both
    // rows — the DEFAULT band and business #1's negotiated row — sit in the same `bulkTiers`
    // array; whichever the verdict matched first would answer, silently, for the wrong buyer.
    const leaked = await validate(second.client, second.csrf);
    expect(leaked.totals.subtotal).toBe(25_470);
    expect(leaked.totals.subtotal).not.toBe(negotiated.totals.subtotal);

    // A guest gets the identical DEFAULT answer — the same rung, reached with no viewer at all.
    const guestPriced = await validate(anonymous.client, anonymous.csrf);
    expect(guestPriced.totals.subtotal).toBe(25_470);

    // And the catalogue — the other surface Task 3 already resolves through the same
    // function — shows the second business the same DEFAULT rung the cart just priced from.
    const product = expectSuccess<WireProduct>(
      await second.client.get(`${CATALOG}/products/${ALMONDS}`).expect(200),
    );
    const band = product.bulkTiers.find((tier) => tier.minKg === 25 && tier.maxKg === 49);
    expect(band?.pricePerKg).toBe(849);
  });

  /**
   * Step 2's second requirement: "the same basket, before and after sign-in, at two prices."
   * `CartService.merge` re-reads the lines and prices are recomputed on every read, so a guest
   * basket that becomes business #1's account on login must reprice from list to negotiated —
   * not keep the guest-side total it was built with.
   */
  it('reprices a guest basket at the negotiated rate the moment its owner signs in', async () => {
    await arrangeNegotiatedTier();
    const visitor = await guest();

    await visitor.client
      .put(CART)
      .set(CSRF_HEADER, visitor.csrf)
      .send({ lines: [bulkLine(30)] })
      .expect(200);

    const asGuest = expectSuccess<{ totals: { subtotal: number } }>(
      await visitor.client.get(CART).expect(200),
    );
    expect(asGuest.totals.subtotal).toBe(25_470);

    // Same cookie jar, so the same guest cart merges into this account on login.
    await visitor.client
      .post(LOGIN)
      .send({ email: 'b2b@demo.in', password: 'Password123!' })
      .expect(200);

    const afterSignIn = expectSuccess<{ totals: { subtotal: number } }>(
      await visitor.client.get(CART).expect(200),
    );
    expect(afterSignIn.totals.subtotal).toBe(21_000);
    expect(afterSignIn.totals.subtotal).not.toBe(asGuest.totals.subtotal);
  });
});
