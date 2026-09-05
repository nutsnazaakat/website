import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type {
  CatalogFacets,
  Category,
  Combo,
  Paginated,
  Product,
  Review,
  ReviewSummary,
} from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedContent } from '../../src/database/seeds/content.seed';
import { IMAGES } from '../../src/database/seeds/seed-context';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { seedUsers } from '../../src/database/seeds/users.seed';
import {
  agent,
  cookieValue,
  expectError,
  expectSuccess,
  request,
  useIntegrationApp,
} from './helpers';

const BASE = '/api/v1/catalog';

/**
 * Phase 1's per-kg figure, restated: the 1kg variant's price, else the first variant's.
 *
 * `catalog.service.ts` reproduces this in SQL with a `DISTINCT ON` derived table. Spelling it here
 * in TypeScript is the point — the sort assertions compare the server's ordering against the rule
 * the frontend used, not against the server's own SQL.
 */
const kgPrice = (product: Product): number =>
  product.variants.find((variant) => variant.grams === 1000)?.price ??
  product.variants[0]?.price ??
  0;

/**
 * Spec §10.1's rule, restated rather than imported.
 *
 * Importing `variantSoldOut` would compare the implementation against itself: a helper changed to
 * `<= 5` would move every mapper *and* this assertion together, and the invariant test could not
 * fail — which is exactly the class of test the binding constraints forbid.
 *
 * The parameter is named `stock`, not `available`, because `eslint.config.mjs`'s
 * `no-restricted-syntax` guard fires on `available === 0` in every TypeScript file in this
 * workspace, this one included. The guard exists to stop a second derivation *shipping*; this one deliberately never
 * leaves the spec, and renaming the parameter is how it stays lintable without an override.
 *
 * `=== 0` and not `<= 0`: `ck_inventory_non_negative` keeps `onHand >= reserved`, so availability
 * read back out of the database cannot be negative, and this is the stricter of the two rules.
 */
const soldOutByRule = (stock: number): boolean => stock === 0;

describe('catalog', () => {
  const integration = useIntegrationApp();

  /**
   * Empties the rate limiter between tests.
   *
   * `useIntegrationApp` boots one application for the whole file, so `ThrottlerGuard`'s in-memory
   * storage is shared by every test in it — and `POST …/reviews` is capped at **five an hour** per
   * IP, with every supertest request arriving from 127.0.0.1. Four tests below post to that route;
   * without this the fifth would 429, and the failure would land on whichever test happened to be
   * fifth rather than on anything that test did. The same reset guards the two logins against the
   * five-per-fifteen-minutes limit on `/auth/login`.
   *
   * `onApplicationShutdown()` is called for its documented effect — cancelling the pending
   * per-hit decrement timers — not because anything is shutting down, and it is not optional.
   * Every hit schedules a `setTimeout` that reads `storage.get(key)` when it fires, so emptying
   * the map without cancelling them leaves callbacks that destructure `undefined` and take the
   * worker down a minute later, mid-test, nowhere near the cause.
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
    /**
     * `seedContent` is **required**, not optional garnish. An earlier version of this block omitted
     * it, which would have run every review test in this file against a database with **zero
     * reviews** — so the summary assertions would have compared empty to empty and passed for the
     * wrong reason, and the rating test would have failed on `ratingAvg` being 0 rather than 3.67
     * with no obvious cause.
     *
     * It is also what recomputes `Product.ratingAvg` / `reviewCount` from approved rows, which is
     * what makes 3.67 the correct expectation. Order matters: it needs `seedCatalog` to have run.
     */
    await seedContent(integration.dataSource);
  });

  describe('GET /products', () => {
    it('is public — the shop must render for a visitor with no session', async () => {
      const response = await request(integration.app).get(`${BASE}/products`).expect(200);
      expect(expectSuccess<Paginated<Product>>(response).total).toBe(27);
    });

    it('paginates, and page 2 does not repeat page 1', async () => {
      const first = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/products?page=1&limit=10`).expect(200),
      );
      const second = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/products?page=2&limit=10`).expect(200),
      );

      expect(first.items).toHaveLength(10);
      expect(second.items).toHaveLength(10);
      expect(first.total).toBe(27);
      // The reason every sort carries a `product.id` tiebreak. Without it Postgres may return the
      // same row on two pages and a customer scrolling the shop sees a duplicate and a gap.
      const overlap = first.items.filter((item) =>
        second.items.some((other) => other.slug === item.slug),
      );
      expect(overlap).toEqual([]);
    });

    it('serves the last, short page rather than clamping to a full one', async () => {
      const last = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/products?page=3&limit=10`).expect(200),
      );
      expect(last.items).toHaveLength(7);
      expect(last.page).toBe(3);
    });

    /**
     * The DTO caps `limit` at 60 with `@Max(60)`, so an over-large page size is a 400 — **not** a
     * 200 quietly answering a different question. That is deliberate, and it is the opposite of
     * what the plan's version of this test asserted: it expected `limit=5000` to come back 200
     * with `limit: 60`, which the DTO rejects before the service's clamp is ever reached.
     */
    it('refuses an over-large page size instead of silently answering a smaller one', async () => {
      const response = await request(integration.app)
        .get(`${BASE}/products?limit=5000`)
        .expect(400);
      const error = expectError(response);
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.details?.limit).toBeDefined();
    });

    it('defaults to a page size of 24, so an unpaged shop request is not a table dump', async () => {
      const response = await request(integration.app).get(`${BASE}/products`).expect(200);
      const page = expectSuccess<Paginated<Product>>(response);
      expect(page.limit).toBe(24);
      expect(page.page).toBe(1);
      expect(page.items).toHaveLength(24);
    });

    it('rejects an unknown query parameter rather than ignoring it', async () => {
      // `forbidNonWhitelisted: true` is deliberate: a typo'd filter that is silently dropped looks
      // like a broken filter, and a filter that silently does nothing is how `inStockOnly` stayed
      // a no-op through all of Phase 1.
      const response = await request(integration.app)
        .get(`${BASE}/products?sortt=price-asc`)
        .expect(400);
      expect(expectError(response).code).toBe('VALIDATION_FAILED');
    });

    it('filters by category slug and treats "all" as no filter', async () => {
      const almonds = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/products?category=almonds`).expect(200),
      );
      expect(almonds.total).toBe(3);
      expect(almonds.items.every((item) => item.category === 'almonds')).toBe(true);

      const all = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/products?category=all`).expect(200),
      );
      expect(all.total).toBe(27);
    });

    it('searches name, subtitle and origin', async () => {
      const byName = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/products?q=mamra`).expect(200),
      );
      expect(byName.items.map((item) => item.slug)).toContain('mamra-almonds');

      const byOrigin = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/products?q=bihar`).expect(200),
      );
      // Two seeded products carry `origin: 'Bihar, India'`, and no name, subtitle, grade or
      // category slug contains the word — so this figure only holds if `origin` is searched.
      expect(byOrigin.total).toBe(2);

      const byGrade = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/products?q=independence`).expect(200),
      );
      expect(byGrade.items.map((item) => item.slug)).toEqual(['premium-california-almonds']);
    });

    it('sorts by the per-kg price, ascending and descending', async () => {
      const asc = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/products?sort=price-asc&limit=60`).expect(200),
      );
      const ascending = asc.items.map(kgPrice);
      expect([...ascending].sort((a, b) => a - b)).toEqual(ascending);
      // The cheapest per-kg product in the seed is sunflower seeds at 449.
      expect(ascending[0]).toBe(449);
      expect(asc.items[0]?.slug).toBe('sunflower-seeds');

      const desc = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/products?sort=price-desc&limit=60`).expect(200),
      );
      const descending = desc.items.map(kgPrice);
      expect([...descending].sort((a, b) => b - a)).toEqual(descending);
      // And the dearest is mamra almonds at 3499 — the same two figures the facets endpoint must
      // report as the slider's ends.
      expect(descending[0]).toBe(3499);
      expect(desc.items[0]?.slug).toBe('mamra-almonds');
    });

    it('filters on the per-kg price in rupees, not paise', async () => {
      const response = await request(integration.app)
        .get(`${BASE}/products?minPrice=3000&limit=60`)
        .expect(200);
      const page = expectSuccess<Paginated<Product>>(response);
      // A bound compared against the paise column without conversion would match everything.
      expect(page.items.map((item) => item.slug)).toEqual(['mamra-almonds']);
      expect(page.total).toBe(1);
    });

    it('emits rupees, never paise, and numbers where the column is numeric', async () => {
      const response = await request(integration.app).get(`${BASE}/products?limit=60`).expect(200);
      for (const product of expectSuccess<Paginated<Product>>(response).items) {
        for (const variant of product.variants) {
          /**
           * Per **kilogram**, not per pack — and that correction matters. The plan's version of
           * this test asserted `variant.price < 100_000` over every variant, which fails on the
           * seeded catalogue: mamra almonds' 50kg bulk pack costs ₹143,450, a perfectly correct
           * rupee figure. A flat ceiling cannot tell a large pack from a paise value.
           *
           * The implied per-kg rate can. The dearest seeded product is ₹3,499/kg and the smallest
           * retail pack marks that up to about 1.5× on an MRP basis, so every legitimate variant
           * lands well under ₹10,000/kg — while a paise value lands a hundred times higher.
           */
          const perKg = (rupees: number): number => rupees / (variant.grams / 1000);
          expect(perKg(variant.price)).toBeLessThan(10_000);
          expect(perKg(variant.mrp)).toBeLessThan(10_000);
          expect(variant.mrp).toBeGreaterThanOrEqual(variant.price);
        }

        /**
         * `bulkTiers` non-empty is load-bearing rather than cosmetic. `baseQuery` selects
         * `pricingTiers` whole so the mapper can filter on `segment` and `businessId`; a narrowed
         * select that dropped either column makes every tier fail the filter and empties this
         * array — silently, and `isQuoteRequired` then reports every bulk weight as quote-required
         * and takes the product page's bulk calculator down with it.
         */
        expect(product.bulkTiers).toHaveLength(5);
        for (const tier of product.bulkTiers) {
          if (tier.pricePerKg !== null) expect(tier.pricePerKg).toBeLessThan(100_000);
        }
        // The open-ended 50kg+ slab carries no rate for any product, which is what routes a 50kg
        // enquiry to the RFQ form.
        expect(product.bulkTiers.at(-1)?.pricePerKg).toBeNull();

        // `gstRate`, `moqKg` and `ratingAvg` are Postgres `numeric`, which the driver hands back as
        // strings. `cart-math.ts` multiplies by `gstRate`, so a string here is an arithmetic bug.
        expect(typeof product.gstRate).toBe('number');
        expect(product.gstRate).toBe(5);
        expect(typeof product.moqKg).toBe('number');
        expect(typeof product.rating).toBe('number');
        expect(typeof product.reviewCount).toBe('number');
      }
    });
  });

  /**
   * Spec §10.1's required invariant. This is the test that turns "one derivation, reused
   * everywhere" from a convention into a build failure.
   */
  describe('sold-out derivation', () => {
    it('agrees with available on every seeded variant and product', async () => {
      /**
       * The drains come first, and they are what make this test able to fail at all.
       *
       * Every seeded variant carries opening stock, so a sweep over the untouched fixture compares
       * `false` to `false` on all 216 variants and all 27 products — it would stay green against a
       * mapper that hardcoded `soldOut: false`, which is precisely the "test that cannot fail" the
       * binding constraints forbid. Draining one variant of one product and every variant of
       * another puts both answers in the data, and the two `toContain` assertions below fail if a
       * future fixture change takes either back out.
       */
      await integration.dataSource.query(`
        UPDATE inventory SET "onHand" = 0, reserved = 0
         WHERE variant_id = (
           SELECT v.id FROM product_variants v
             JOIN products p ON p.id = v.product_id
            WHERE p.slug = 'premium-california-almonds' AND v.size = '250g'
         )
      `);
      await integration.dataSource.query(`
        UPDATE inventory SET "onHand" = 0, reserved = 0
         WHERE variant_id IN (
           SELECT v.id FROM product_variants v
             JOIN products p ON p.id = v.product_id
            WHERE p.slug = 'golden-raisins'
         )
      `);

      const response = await request(integration.app).get(`${BASE}/products?limit=60`).expect(200);
      const products = expectSuccess<Paginated<Product>>(response).items;
      expect(products).toHaveLength(27);

      for (const product of products) {
        for (const variant of product.variants) {
          expect(variant.soldOut).toBe(soldOutByRule(variant.available));
        }
        expect(product.soldOut).toBe(
          product.variants.every((variant) => soldOutByRule(variant.available)),
        );
      }

      const variantFlags = products.flatMap((product) =>
        product.variants.map((variant) => variant.soldOut),
      );
      expect(variantFlags).toContain(true);
      expect(variantFlags).toContain(false);
      const productFlags = products.map((product) => product.soldOut);
      expect(productFlags).toContain(true);
      expect(productFlags).toContain(false);
    });

    it('reports a variant sold out once its stock is drained, and not before', async () => {
      // Drain one 250g pack and leave its siblings alone, so the product must stay in stock while
      // that one variant goes out. This is brief §11's per-variant requirement.
      await integration.dataSource.query(`
        UPDATE inventory SET "onHand" = 0
         WHERE variant_id = (
           SELECT v.id FROM product_variants v
             JOIN products p ON p.id = v.product_id
            WHERE p.slug = 'premium-california-almonds' AND v.size = '250g'
         )
      `);

      const response = await request(integration.app)
        .get(`${BASE}/products/premium-california-almonds`)
        .expect(200);
      const product = expectSuccess<Product>(response);

      const drained = product.variants.find((variant) => variant.size === '250g');
      const sibling = product.variants.find((variant) => variant.size === '500g');
      expect(drained?.available).toBe(0);
      expect(drained?.soldOut).toBe(true);
      expect(sibling?.soldOut).toBe(false);
      expect(product.soldOut).toBe(false);
      // A drained variant still has to be *present*, or the product page cannot render the pack as
      // SOLD OUT — which is why `inStockOnly` filters with `EXISTS` and not on the mapper's join.
      expect(product.variants).toHaveLength(8);
    });

    it('reports the product sold out only when every active variant is drained', async () => {
      await integration.dataSource.query(`
        UPDATE inventory SET "onHand" = 0, reserved = 0
         WHERE variant_id IN (
           SELECT v.id FROM product_variants v
             JOIN products p ON p.id = v.product_id
            WHERE p.slug = 'golden-raisins'
         )
      `);

      const response = await request(integration.app)
        .get(`${BASE}/products/golden-raisins`)
        .expect(200);
      expect(expectSuccess<Product>(response).soldOut).toBe(true);
    });

    it('counts reserved stock against availability', async () => {
      await integration.dataSource.query(`
        UPDATE inventory SET "onHand" = 5, reserved = 5
         WHERE variant_id = (
           SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
            WHERE p.slug = 'w320-cashews' AND v.size = '1kg'
         )
      `);
      const response = await request(integration.app)
        .get(`${BASE}/products/w320-cashews`)
        .expect(200);
      const variant = expectSuccess<Product>(response).variants.find((v) => v.size === '1kg');
      expect(variant?.available).toBe(0);
      expect(variant?.soldOut).toBe(true);
    });
  });

  describe('inStockOnly', () => {
    it('actually filters, and respects the channel', async () => {
      // Drain every retail variant of one product, leaving its bulk packs stocked. Phase 1's filter
      // used `some` across *all* variants, so this product wrongly survived a retail stock filter.
      await integration.dataSource.query(`
        UPDATE inventory SET "onHand" = 0, reserved = 0
         WHERE variant_id IN (
           SELECT v.id FROM product_variants v
             JOIN products p ON p.id = v.product_id
            WHERE p.slug = 'kimia-dates' AND v.channel = 'RETAIL'
         )
      `);

      const retail = expectSuccess<Paginated<Product>>(
        await request(integration.app)
          .get(`${BASE}/products?inStockOnly=true&channel=retail&limit=60`)
          .expect(200),
      );
      expect(retail.items.map((item) => item.slug)).not.toContain('kimia-dates');
      expect(retail.total).toBe(26);

      const bulk = expectSuccess<Paginated<Product>>(
        await request(integration.app)
          .get(`${BASE}/products?inStockOnly=true&channel=bulk&limit=60`)
          .expect(200),
      );
      expect(bulk.items.map((item) => item.slug)).toContain('kimia-dates');
      expect(bulk.total).toBe(27);
    });

    it('reads "false" as off rather than as a ticked checkbox', async () => {
      await integration.dataSource.query(`UPDATE inventory SET "onHand" = 0, reserved = 0`);
      const response = await request(integration.app)
        .get(`${BASE}/products?inStockOnly=false&limit=60`)
        .expect(200);
      // `@Type(() => Boolean)` would make the string 'false' truthy and empty this page.
      expect(expectSuccess<Paginated<Product>>(response).total).toBe(27);
    });
  });

  describe('GET /products/facets', () => {
    it('describes the whole catalogue, not one page', async () => {
      const facets = expectSuccess<CatalogFacets>(
        await request(integration.app).get(`${BASE}/products/facets`).expect(200),
      );

      // 27 products across 12 categories, so the counts must sum to 27 — the assertion that catches
      // a facets query accidentally scoped to a page.
      expect(facets.categories).toHaveLength(12);
      expect(facets.categories.reduce((sum, c) => sum + c.productCount, 0)).toBe(27);
      expect(facets.origins).toHaveLength(13);
      expect(facets.grades).toHaveLength(19);
      // Bounds in rupees, matching the per-kg figure the price filter uses. `MIN()` over a bigint
      // column arrives as a string, so a missing `BigInt()` renders ₹449 as ₹4.49.
      expect(facets.minPrice).toBe(449);
      expect(facets.maxPrice).toBe(3499);
      // `combos` holds 8 products, two of which are not combos — see the combos test below.
      expect(facets.categories.find((c) => c.slug === 'combos')?.productCount).toBe(8);
    });

    it('is reachable at its own path rather than being matched as a product slug', async () => {
      // Route order: `products/facets` must be declared before `products/:slug`.
      await request(integration.app).get(`${BASE}/products/facets`).expect(200);
      // The same trap for the other literal path under `products/`.
      const bestsellers = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/products/bestsellers`).expect(200),
      );
      expect(bestsellers.total).toBe(5);
      expect(bestsellers.items.every((item) => item.badge === 'BESTSELLER')).toBe(true);
    });
  });

  describe('GET /products/:slug', () => {
    it('404s with a customer-readable message for an unknown slug', async () => {
      const response = await request(integration.app)
        .get(`${BASE}/products/no-such-thing`)
        .expect(404);
      expect(expectError(response).code).toBe('NOT_FOUND');
    });

    it('includes every image in sortOrder', async () => {
      const product = expectSuccess<Product>(
        await request(integration.app).get(`${BASE}/products/mamra-almonds`).expect(200),
      );
      // Three rows, `sortOrder` 0..2, and the product's own photograph is the first. Asserting the
      // values and not just the length is what makes this a test of the *order*.
      expect(product.images).toEqual([IMAGES.almonds, IMAGES.placeholder, IMAGES.placeholder]);
    });

    it('serves related products from the same category, excluding the product itself', async () => {
      const related = expectSuccess<Paginated<Product>>(
        await request(integration.app)
          .get(`${BASE}/products/premium-california-almonds/related`)
          .expect(200),
      );
      expect(related.items.map((item) => item.slug)).toEqual(
        expect.arrayContaining(['mamra-almonds', 'gurbandi-almonds']),
      );
      expect(related.items.map((item) => item.slug)).not.toContain('premium-california-almonds');
    });

    it('answers an empty rail rather than a 404 for an unknown slug', async () => {
      const related = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/products/no-such-thing/related`).expect(200),
      );
      expect(related.items).toEqual([]);
      expect(related.total).toBe(0);
    });
  });

  describe('GET /categories and /combos', () => {
    it('returns the twelve seeded categories in display order', async () => {
      const categories = expectSuccess<Category[]>(
        await request(integration.app).get(`${BASE}/categories`).expect(200),
      );
      expect(categories).toHaveLength(12);
      expect(categories[0]?.slug).toBe('almonds');
      expect(categories[1]?.slug).toBe('cashews');
    });

    it('404s for an unknown category', async () => {
      const response = await request(integration.app)
        .get(`${BASE}/categories/no-such-thing`)
        .expect(404);
      expect(expectError(response).code).toBe('NOT_FOUND');
    });

    it('assembles combos with savings derived from live prices', async () => {
      const combos = expectSuccess<Combo[]>(
        await request(integration.app).get(`${BASE}/combos`).expect(200),
      );
      /**
       * Six, not the eight products in the `combos` *category*. `corporate-gift-box` and
       * `festive-gift-box` sit in that category without being combos — they have no component list
       * — so the category count and this figure are both right and differ by two. A test asserting
       * eight here would be asserting the category count, which the facets test already covers.
       */
      expect(combos).toHaveLength(6);
      for (const combo of combos) {
        expect(combo.components.length).toBeGreaterThan(0);
        expect(combo.savings).toBeGreaterThanOrEqual(0);
        expect(combo.partsPrice).toBeGreaterThan(0);
        // Every figure in rupees.
        expect(combo.price).toBeLessThan(100_000);
        /**
         * Savings are derived, not stored, and they are measured against the components' **MRP**,
         * floored at zero — the figure a "save ₹X (Y%)" badge is allowed to claim. Against
         * `partsPrice` the numbers do not reconcile (measured: 497 where parts-minus-box is 307),
         * so this pins the derivation the card actually renders.
         */
        expect(combo.savings).toBe(Math.max(0, combo.partsMrp - combo.price));
        expect(combo.savingsPercent).toBe(Math.round((combo.savings / combo.partsMrp) * 100));
        expect(combo.partsMrp).toBeGreaterThanOrEqual(combo.partsPrice);
        expect(combo.totalGrams).toBe(
          combo.components.reduce((sum, component) => sum + component.grams, 0),
        );
      }
    });
  });
  describe('reviews', () => {
    const PCA = 'premium-california-almonds';

    /** A body long enough for the DTO's `@MinLength(20)`. */
    const BODY = 'A perfectly reasonable twenty-plus character body.';

    /** Inserts a PENDING row directly, bypassing the service and its recompute. */
    const insertPending = (author: string, rating: number): Promise<unknown> =>
      integration.dataSource.query(
        `INSERT INTO reviews (product_id, "productSlug", author, rating, body, "verifiedPurchase", status)
         SELECT p.id, p.slug, $1, $2, 'A review awaiting moderation.', false, 'PENDING'
           FROM products p WHERE p.slug = $3`,
        [author, rating, PCA],
      );

    /** Logs in as the seeded b2c fixture and returns a cookie-persisting client plus its token. */
    const signIn = async (): Promise<{
      client: ReturnType<typeof agent>;
      csrfToken: string;
    }> => {
      const client = agent(integration.app);
      const login = await client
        .post('/api/v1/auth/login')
        .send({ email: 'b2c@demo.in', password: 'Password123!' })
        .expect(200);
      return { client, csrfToken: expectSuccess<{ csrfToken: string }>(login).csrfToken };
    };

    it('returns the seeded approved reviews, newest first', async () => {
      const reviews = expectSuccess<Review[]>(
        await request(integration.app).get(`${BASE}/products/${PCA}/reviews`).expect(200),
      );
      // Three on this product out of the seed's fourteen, and the order is part of the contract.
      expect(reviews).toHaveLength(3);
      const timestamps = reviews.map((review) => Date.parse(review.createdAt));
      expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
    });

    it('returns only approved reviews', async () => {
      // The seeder's 14 reviews are all APPROVED. Insert a PENDING one and prove it stays hidden.
      await insertPending('Nobody', 1);

      const reviews = expectSuccess<Review[]>(
        await request(integration.app).get(`${BASE}/products/${PCA}/reviews`).expect(200),
      );
      expect(reviews).toHaveLength(3);
      expect(reviews.every((review) => review.status === 'approved')).toBe(true);
      expect(reviews.map((review) => review.author)).not.toContain('Nobody');
    });

    it('summarises the seeded fixture', async () => {
      const summary = expectSuccess<ReviewSummary>(
        await request(integration.app).get(`${BASE}/products/${PCA}/reviews/summary`).expect(200),
      );
      // Three approved reviews at 5, 4 and 2 stars: mean 3.6667, one decimal place. The
      // denormalised column holds 3.67; both render as "3.7" through `toFixed(1)`.
      expect(summary.average).toBe(3.7);
      expect(summary.total).toBe(3);
      expect(summary.verifiedCount).toBe(3);
      // Five buckets always, so the histogram renders short bars rather than missing ones.
      expect(summary.distribution.map((bucket) => bucket.stars)).toEqual([5, 4, 3, 2, 1]);
      expect(summary.distribution.map((bucket) => bucket.count)).toEqual([1, 1, 0, 1, 0]);
    });

    it('answers zeroes rather than NaN for a product nobody has reviewed', async () => {
      const summary = expectSuccess<ReviewSummary>(
        await request(integration.app)
          .get(`${BASE}/products/sunflower-seeds/reviews/summary`)
          .expect(200),
      );
      expect(summary.average).toBe(0);
      expect(summary.total).toBe(0);
      expect(summary.distribution).toHaveLength(5);
    });

    it('excludes pending reviews from the summary, so one unmoderated star cannot move the rating', async () => {
      const before = expectSuccess<ReviewSummary>(
        await request(integration.app).get(`${BASE}/products/${PCA}/reviews/summary`).expect(200),
      );
      // Guards the comparison below against passing by comparing empty to empty — which is exactly
      // what this test did in the version that omitted `seedContent`.
      expect(before.total).toBe(3);

      await insertPending('Nobody', 1);

      const after = expectSuccess<ReviewSummary>(
        await request(integration.app).get(`${BASE}/products/${PCA}/reviews/summary`).expect(200),
      );
      expect(after).toEqual(before);
    });

    it('refuses an anonymous submission', async () => {
      const response = await request(integration.app)
        .post(`${BASE}/products/${PCA}/reviews`)
        .send({ author: 'Asha', rating: 5, body: BODY })
        // 403, not 401: `CsrfGuard` runs before `JwtAuthGuard` deliberately, so a state-changing
        // request with no CSRF token is refused before any session lookup happens.
        .expect(403);
      expect(expectError(response).code).toBe('CSRF_TOKEN_INVALID');
    });

    /**
     * Measured, and the answer the plan left open: a client that sends `verifiedPurchase` is
     * **rejected with a 400**, not silently stripped. `whitelist: true` alone would drop the field;
     * `forbidNonWhitelisted: true` is what turns it into an error naming the property, so a caller
     * who thinks they set the badge is told they cannot rather than left to assume it worked.
     */
    it('rejects a client-supplied verifiedPurchase rather than ignoring it', async () => {
      const { client, csrfToken } = await signIn();

      const response = await client
        .post(`${BASE}/products/${PCA}/reviews`)
        .set('X-CSRF-Token', csrfToken)
        .send({ author: 'Asha', rating: 5, body: BODY, verifiedPurchase: true })
        .expect(400);
      const error = expectError(response);
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.details?.verifiedPurchase).toBeDefined();
    });

    it('never lets a client mint its own verified-purchase badge', async () => {
      const { client, csrfToken } = await signIn();

      const created = expectSuccess<Review>(
        await client
          .post(`${BASE}/products/${PCA}/reviews`)
          .set('X-CSRF-Token', csrfToken)
          // A plausible body with the flag left out, since sending it is a 400 (above). Asserting
          // the flag on what comes back is what proves the server derives it.
          .send({ author: 'Asha', rating: 5, body: BODY })
          .expect(201),
      );

      expect(created.verifiedPurchase).toBe(false);
      expect(created.status).toBe('pending');
      expect(created.productSlug).toBe(PCA);

      // And it is invisible to the next shopper until a moderator approves it.
      const visible = expectSuccess<Review[]>(
        await request(integration.app).get(`${BASE}/products/${PCA}/reviews`).expect(200),
      );
      expect(visible).toHaveLength(3);
    });

    it('404s a submission against a slug nobody stocks', async () => {
      const { client, csrfToken } = await signIn();

      const response = await client
        .post(`${BASE}/products/no-such-thing/reviews`)
        .set('X-CSRF-Token', csrfToken)
        .send({ author: 'Asha', rating: 5, body: BODY })
        .expect(404);
      expect(expectError(response).code).toBe('NOT_FOUND');
    });

    it('validates the body it was given rather than storing whatever arrives', async () => {
      const { client, csrfToken } = await signIn();

      const response = await client
        .post(`${BASE}/products/${PCA}/reviews`)
        .set('X-CSRF-Token', csrfToken)
        .send({ author: 'A', rating: 9, body: 'Too short.' })
        .expect(400);
      const error = expectError(response);
      expect(Object.keys(error.details ?? {}).sort()).toEqual(['author', 'body', 'rating']);
    });

    /**
     * The approved-only recompute, tested through the path that actually triggers it.
     *
     * The summary test above inserts a `PENDING` row with raw SQL, which never calls
     * `recomputeAggregates` — so it cannot catch a recompute that counted pending rows, which is the
     * property it looks like it guards. This one posts through the API, where the recompute runs, and
     * asserts the **denormalised columns the product page reads** are untouched.
     *
     * Measured seed state: `ratingAvg` 3.67 across 3 approved reviews on this product. A one-star
     * pending submission would drag it to 3.0 if status filtering were dropped — a visible drop
     * caused by a review nobody has read yet.
     */
    it('does not let a pending submission move the product rating', async () => {
      const before = await integration.dataSource.query<{ avg: string; n: number }[]>(
        `SELECT "ratingAvg" AS avg, "reviewCount" AS n FROM products WHERE slug = $1`,
        [PCA],
      );
      expect(before[0]?.avg).toBe('3.67');
      expect(before[0]?.n).toBe(3);

      const { client, csrfToken } = await signIn();

      await client
        .post(`${BASE}/products/${PCA}/reviews`)
        .set('X-CSRF-Token', csrfToken)
        .send({
          author: 'Asha',
          rating: 1,
          body: 'A one-star body of more than twenty characters.',
        })
        .expect(201);

      const after = await integration.dataSource.query<{ avg: string; n: number }[]>(
        `SELECT "ratingAvg" AS avg, "reviewCount" AS n FROM products WHERE slug = $1`,
        [PCA],
      );
      expect(after[0]?.avg).toBe('3.67');
      expect(after[0]?.n).toBe(3);
      // The row is there — the recompute ignored it, rather than the write having failed.
      const pending = await integration.dataSource.query<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM reviews WHERE "productSlug" = $1 AND status = 'PENDING'`,
        [PCA],
      );
      expect(pending[0]?.count).toBe('1');
    });

    /**
     * The other half of the same guarantee, and the reason the recompute is not simply skipped: a
     * review that *is* approved has to move both columns. Approving through SQL and re-posting is
     * what forces the recompute to run over the new state.
     */
    it('moves the product rating once a review is approved', async () => {
      const { client, csrfToken } = await signIn();

      await client
        .post(`${BASE}/products/${PCA}/reviews`)
        .set('X-CSRF-Token', csrfToken)
        .send({
          author: 'Asha',
          rating: 1,
          body: 'A one-star body of more than twenty characters.',
        })
        .expect(201);

      await integration.dataSource.query(
        `UPDATE reviews SET status = 'APPROVED' WHERE "productSlug" = $1 AND status = 'PENDING'`,
        [PCA],
      );

      // A second submission recomputes over the now-approved row: (5 + 4 + 2 + 1) / 4 = 3.00.
      await client
        .post(`${BASE}/products/${PCA}/reviews`)
        .set('X-CSRF-Token', csrfToken)
        .send({ author: 'Asha', rating: 5, body: BODY })
        .expect(201);

      const rows = await integration.dataSource.query<{ avg: string; n: number }[]>(
        `SELECT "ratingAvg" AS avg, "reviewCount" AS n FROM products WHERE slug = $1`,
        [PCA],
      );
      expect(rows[0]?.avg).toBe('3.00');
      expect(rows[0]?.n).toBe(4);
    });
  });

  /**
   * Milestone 7, Task 5. Both routes are new — the routing-table enumeration in
   * `catalog.controller.spec.ts` is what pins declaration order; this proves the two actually
   * answer over HTTP, with the validation pipe and the exception filter in front of them, which a
   * `CatalogService` unit test cannot exercise.
   */
  describe('POST /bulk/quote-preview', () => {
    const ALMONDS = 'premium-california-almonds';
    const QUOTE_ONLY = 'corporate-gift-box';

    /**
     * A cookie-persisting client that already holds `nn_csrf`, plus the token to echo — the same
     * bootstrap `cart.integration.spec.ts`'s `guest()` uses. `CsrfGuard` is global and requires
     * both a cookie and a matching header on every method but GET/HEAD/OPTIONS, `@Public()`
     * notwithstanding — measured directly here: the first draft of this block sent no CSRF pair at
     * all and every one of these tests failed with a bare 403 before the assertion it meant to
     * make ever ran.
     */
    const anonymous = async (): Promise<{ client: ReturnType<typeof agent>; csrf: string }> => {
      const client = agent(integration.app);
      const primer = await client.get(`${BASE}/products`).expect(200);
      return { client, csrf: cookieValue(primer, 'nn_csrf') };
    };

    it('prices a real weight in a real rung', async () => {
      const { client, csrf } = await anonymous();
      const preview = expectSuccess<{
        pricePerKg: number | null;
        total: number | null;
        quoteRequired: boolean;
        tier: { minKg: number; maxKg: number | null } | null;
      }>(
        await client
          .post(`${BASE}/bulk/quote-preview`)
          .set('X-CSRF-Token', csrf)
          .send({ slug: ALMONDS, kg: 10 })
          .expect(200),
      );

      // The 5-9kg slab (`round(999 * 0.95)`), and 10kg lands in 10-24kg instead — `round(999 * 0.9)`.
      expect(preview.quoteRequired).toBe(false);
      expect(preview.pricePerKg).toBe(899);
      expect(preview.total).toBe(8990);
      expect(preview.tier).toEqual({ minKg: 10, maxKg: 24 });
    });

    /** Independent of the ladder — `corporate-gift-box`'s 25kg slab is priced, and the flag still wins. */
    it('reports quoteRequired for a quote-only product inside a priced slab', async () => {
      const { client, csrf } = await anonymous();
      const preview = expectSuccess<{ quoteRequired: boolean; pricePerKg: number | null }>(
        await client
          .post(`${BASE}/bulk/quote-preview`)
          .set('X-CSRF-Token', csrf)
          .send({ slug: QUOTE_ONLY, kg: 25 })
          .expect(200),
      );

      expect(preview.quoteRequired).toBe(true);
      expect(preview.pricePerKg).toBeNull();
    });

    it('reports quoteRequired, not an error, for the open-ended 50kg+ slab', async () => {
      const { client, csrf } = await anonymous();
      const preview = expectSuccess<{ quoteRequired: boolean }>(
        await client
          .post(`${BASE}/bulk/quote-preview`)
          .set('X-CSRF-Token', csrf)
          .send({ slug: ALMONDS, kg: 50 })
          .expect(200),
      );

      expect(preview.quoteRequired).toBe(true);
    });

    it('404s an unknown slug rather than answering quoteRequired for it', async () => {
      const { client, csrf } = await anonymous();
      const response = await client
        .post(`${BASE}/bulk/quote-preview`)
        .set('X-CSRF-Token', csrf)
        .send({ slug: 'no-such-thing', kg: 10 })
        .expect(404);
      expect(expectError(response).code).toBe('NOT_FOUND');
    });

    /** `@Min(0.01)` — a zero-kilogram quote is refused before the service ever runs. */
    it('rejects kg: 0 rather than pricing an empty order', async () => {
      const { client, csrf } = await anonymous();
      const response = await client
        .post(`${BASE}/bulk/quote-preview`)
        .set('X-CSRF-Token', csrf)
        .send({ slug: ALMONDS, kg: 0 })
        .expect(400);
      expect(expectError(response).code).toBe('VALIDATION_FAILED');
    });

    /** `@Max(10_000)` — the SQLSTATE-22003 sibling this DTO's own docblock names. */
    it('rejects an unbounded weight rather than overflowing the numeric column', async () => {
      const { client, csrf } = await anonymous();
      const response = await client
        .post(`${BASE}/bulk/quote-preview`)
        .set('X-CSRF-Token', csrf)
        .send({ slug: ALMONDS, kg: 100_000 })
        .expect(400);
      expect(expectError(response).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /bulk/products', () => {
    it('serves published products with their resolved ladder attached', async () => {
      const page = expectSuccess<Paginated<Product>>(
        await request(integration.app).get(`${BASE}/bulk/products?limit=60`).expect(200),
      );

      // Every seeded product gets a full DEFAULT ladder unconditionally (`buildTiers`), so the
      // bulk listing for a guest is the whole 27-product catalogue — the same total `GET
      // /products` asserts, proving this route omits nothing rather than merely omitting nothing
      // *today* by coincidence.
      expect(page.total).toBe(27);
      for (const product of page.items) {
        expect(product.bulkTiers.length).toBeGreaterThan(0);
      }
    });

    /** The DTO's own cap, reused rather than a second one — proved the same way `GET /products` is. */
    it('refuses an over-large page size, the same as the main listing', async () => {
      const response = await request(integration.app)
        .get(`${BASE}/bulk/products?limit=5000`)
        .expect(400);
      expect(expectError(response).code).toBe('VALIDATION_FAILED');
    });
  });
});
