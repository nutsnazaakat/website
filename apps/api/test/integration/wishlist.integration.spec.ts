import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { Product as WireProduct, WishlistSlugs } from '@nutwala/shared';
import type { Response } from 'supertest';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { seedUsers } from '../../src/database/seeds/users.seed';
import { MERGE_WISHLIST_SQL } from '../../src/modules/wishlist/wishlist.service';
import {
  agent,
  cookieEntry,
  cookieValue,
  expectError,
  expectSuccess,
  request,
  useIntegrationApp,
} from './helpers';

/**
 * Cookie and header names are spelled out rather than imported from `guest-token.ts` and
 * `cookie.service.ts`, for the reason `cart.integration.spec.ts` gives at length: they are wire
 * contract, and importing the constants would make a rename typecheck and keep these tests green
 * while every existing client broke.
 */
const GUEST_COOKIE = 'nn_guest_token';
const CSRF_COOKIE = 'nn_csrf';
const CSRF_HEADER = 'X-CSRF-Token';

const BASE = '/api/v1/wishlist';
const CART = '/api/v1/cart';
const LOGIN = '/api/v1/auth/login';
const REGISTER = '/api/v1/auth/register';

const ALMONDS = 'premium-california-almonds';
const CASHEWS = 'w320-cashews';
const PISTACHIOS = 'premium-pistachios';
/** In the catalogue and never saved by any test here, for the "remove what was never saved" pair. */
const WALNUTS = 'california-walnuts';
/** Not in the catalogue at all. `seedCatalog` has no such slug — checked below before it is used. */
const NO_SUCH_PRODUCT = 'gold-plated-badam';

/** One 250g retail bag, the line `cart.integration.spec.ts` prices at ₹598 for qty 2. */
const cartLine = { slug: ALMONDS, mode: 'retail' as const, size: '250g', qty: 2 };

/**
 * Whether a response sets one named cookie at all — the assertion `cookieEntry` cannot make,
 * because it throws when the cookie is absent. Both polarities are load-bearing here: sign-in
 * *clears* `nn_guest_token` on a complete merge (which is a `Set-Cookie` with an empty value) and
 * leaves it untouched after a partial one, so "was it cleared" is a question about presence and
 * cannot be asked of `cookieValue` alone.
 */
const sets = (response: Response, name: string): boolean =>
  (response.get('Set-Cookie') ?? []).some((cookie) => cookie.startsWith(`${name}=`));

/**
 * The database half of the wishlist, which is the half a repository double cannot reach.
 *
 * `wishlist.service.spec.ts` and `wishlist.controller.spec.ts` pin the branch logic and the owner
 * resolution against mocks, and Task 27 was explicit that five claims are beyond them because they
 * are not about shape at all — only Postgres can answer them:
 *
 * - the merge transfers what the account does not hold and skips what it does, one row each;
 * - `ON CONFLICT (user_id, product_id) WHERE user_id IS NOT NULL` really does infer the *partial*
 *   index `uq_wishlist_items_user_product`, and the statement without the restated predicate really
 *   does fail — an error `auth.controller.ts` swallows, so nothing else would ever notice;
 * - the self-referencing `INSERT ... SELECT` terminates, writing exactly the rows expected into the
 *   table it is reading;
 * - a failure in one of the two sign-in merges does not cost the customer the other one, and does
 *   not clear the only key those rows have;
 * - the duplicate save is refused by a named index in the database, not by the service.
 *
 * Every assertion below is made against rows or response bodies. **Not** against sign-in's status
 * code: `mergeGuestState` catches and logs, so a completely broken merge answers `200` with the
 * customer's saved list gone, and a test asserting `.expect(200)` on the login passes against every
 * implementation, working or not. Where `.expect(200)` appears it is a precondition — proof the
 * request under test was actually served — never the claim.
 */
describe('wishlist', () => {
  const integration = useIntegrationApp();

  /**
   * Empties the rate limiter between tests. `useIntegrationApp` boots one application for the whole
   * file, so `ThrottlerGuard`'s in-memory storage is shared across it; `/auth/login` is capped at
   * five attempts per fifteen minutes per IP and `/auth/register` at three per hour, with every
   * supertest request arriving from 127.0.0.1. This file signs in a dozen times, so without the
   * reset the failure lands on whichever test happens to be sixth rather than on anything it did.
   * No test here signs in more than twice, so the reset cannot weaken one.
   *
   * `onApplicationShutdown()` is called for its documented effect — cancelling the pending per-hit
   * decrement timers — and is not optional; see the longer note in `auth.integration.spec.ts`.
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
  });

  /**
   * An anonymous client that already holds `nn_csrf`, plus the token to echo.
   *
   * **A cold write can never succeed and must not be written as though it can.** `CsrfGuard` is
   * global and requires both a cookie and a matching header on every method but GET/HEAD/OPTIONS,
   * and a brand-new client has neither; `CsrfBootstrapMiddleware` sets `nn_csrf` on the *response*,
   * so it is usable from the next request onward. Hence one priming `GET` first — which also proves
   * in passing that `GET /wishlist` is open to a visitor holding no key at all.
   */
  async function guest() {
    const client = agent(integration.app);
    const primer = await client.get(BASE).expect(200);
    return { client, csrf: cookieValue(primer, CSRF_COOKIE) };
  }

  /** Signs in and returns a cookie-persisting client, its CSRF token, and the login response. */
  async function signedIn(email = 'b2c@demo.in') {
    const client = agent(integration.app);
    const login = await client.post(LOGIN).send({ email, password: 'Password123!' }).expect(200);
    return { client, login, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  }

  const userId = async (email: string): Promise<string> => {
    const rows = await integration.dataSource.query<{ id: string }[]>(
      'SELECT id FROM users WHERE email = $1',
      [email],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`seedUsers wrote no ${email} row`);
    return id;
  };

  const productId = async (slug: string): Promise<string> => {
    const rows = await integration.dataSource.query<{ id: string }[]>(
      'SELECT id FROM products WHERE slug = $1',
      [slug],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`seedCatalog wrote no ${slug} row`);
    return id;
  };

  /**
   * Every wishlist row in the database as `owner -> slug`, which is the shape almost every claim
   * here is really about: the merge's effect is a row count and a change of owner.
   *
   * Ordered by slug rather than by `createdAt`, because these assertions are about *which* rows
   * exist; the two that are about ordering read the API's own answer instead. `owner` is the
   * secondary key and is not optional — a guest row and an account row for the same product is the
   * central case here, and one sort column would leave those two in whatever order the plan
   * produced, so the assertion would pass or fail by luck.
   */
  const rows = async (): Promise<{ owner: string; slug: string }[]> =>
    integration.dataSource.query<{ owner: string; slug: string }[]>(
      `SELECT CASE WHEN w.user_id IS NOT NULL THEN 'user:' || u.email ELSE 'guest' END AS owner,
              p.slug AS slug
         FROM wishlist_items w
         JOIN products p ON p.id = w.product_id
         LEFT JOIN users u ON u.id = w.user_id
        ORDER BY p.slug, owner`,
    );

  const saveDirectly = async (
    owner: { userId: string } | { guestToken: string },
    slug: string,
  ): Promise<void> => {
    await integration.dataSource.query(
      'INSERT INTO wishlist_items (user_id, guest_token, product_id) VALUES ($1, $2, $3)',
      [
        'userId' in owner ? owner.userId : null,
        'guestToken' in owner ? owner.guestToken : null,
        await productId(slug),
      ],
    );
  };

  /**
   * A well-formed guest key: 32 bytes base64url, which is 43 characters and exactly the shape
   * `issueGuestToken` mints and `KEY_PATTERN` accepts. Derived from `seed` rather than random so a
   * failure is reproducible, and so two visitors in one test are two *stated* keys rather than two
   * draws that happen to differ.
   */
  const aGuestKey = (seed = 1): string =>
    Buffer.from(Array.from({ length: 32 }, (_, index) => (index * 7 + 13 * seed) % 256)).toString(
      'base64url',
    );

  describe('a guest saving things', () => {
    it('stores the save against the key it hands back, and reads the product out again', async () => {
      const { client, csrf } = await guest();

      const saved = await client.post(`${BASE}/${ALMONDS}`).set(CSRF_HEADER, csrf).expect(200);
      expect(expectSuccess<WishlistSlugs>(saved).slugs).toEqual([ALMONDS]);

      const entry = cookieEntry(saved, GUEST_COOKIE);
      // The key is a bearer credential for the saved-items list, so script must not read it.
      expect(entry).toMatch(/HttpOnly/i);
      // `SameSite=Lax` and 30 days, matching the cart's key because it *is* the cart's key: a
      // customer arriving from a WhatsApp link must still find what they saved before they left.
      expect(entry).toMatch(/SameSite=Lax/i);
      expect(entry).toMatch(/Max-Age=2592000/);
      expect(entry).toMatch(/Path=\//);

      // The value the customer holds is the name of the row that was created, not merely a
      // well-formed key. A cookie naming no row is an empty list on the very next request.
      const stored = await integration.dataSource.query<
        { guest_token: string | null; user_id: string | null; slug: string }[]
      >(`SELECT w.guest_token, w.user_id, p.slug
           FROM wishlist_items w JOIN products p ON p.id = w.product_id`);
      expect(stored).toEqual([
        { guest_token: cookieValue(saved, GUEST_COOKIE), user_id: null, slug: ALMONDS },
      ]);

      // And `GET /wishlist` answers with the fully priced wire product, not a slug — the reason
      // `list()` goes through the catalogue mapper at all is so the saved-items page can render the
      // shop's own `ProductCard`, SOLD OUT state included.
      const listed = expectSuccess<WireProduct[]>(await client.get(BASE).expect(200));
      expect(listed.map((product) => product.slug)).toEqual([ALMONDS]);
      expect(listed[0]?.variants.length).toBeGreaterThan(0);
    });

    /**
     * The check that scoping is real rather than incidental — and the **second guest holds a key of
     * their own**, which is the part that makes it one.
     *
     * Written first as "a fresh client reads an empty list", and measured to be worthless: with
     * `ownerWhere` replaced by `return {}` — an unscoped `find` that returns every wishlist in the
     * database — that version still passed, because a client that has never written holds no
     * `nn_guest_token` and `WishlistController.list` answers `[]` from its own short-circuit without
     * ever calling the service. The scoping was never exercised.
     *
     * So the second visitor saves something too, and each then reads back only their own. That
     * version fails under the same mutation, and the key-less third visitor below still covers the
     * controller's short-circuit, which is a different claim worth keeping.
     */
    it('scopes each guest to their own key, and answers a key-less visitor with nothing', async () => {
      const first = await guest();
      await first.client.post(`${BASE}/${ALMONDS}`).set(CSRF_HEADER, first.csrf).expect(200);
      const second = await guest();
      await second.client.post(`${BASE}/${CASHEWS}`).set(CSRF_HEADER, second.csrf).expect(200);

      const slugsFor = async (client: ReturnType<typeof agent>): Promise<string[]> =>
        expectSuccess<WishlistSlugs>(await client.get(`${BASE}/slugs`).expect(200)).slugs;
      // Neither list is empty, so neither answer can be an empty table — and neither contains the
      // other's product, so it cannot be an unscoped read either.
      expect(await slugsFor(first.client)).toEqual([ALMONDS]);
      expect(await slugsFor(second.client)).toEqual([CASHEWS]);
      expect(
        expectSuccess<WireProduct[]>(await first.client.get(BASE).expect(200)).map((p) => p.slug),
      ).toEqual([ALMONDS]);

      // A visitor holding no key at all: an empty list, not a 404 — `ownerWhere` throws for an
      // ownerless call, so both read handlers short-circuit before reaching it.
      const stranger = agent(integration.app);
      expect(expectSuccess<WireProduct[]>(await stranger.get(BASE).expect(200))).toEqual([]);
      expect(expectSuccess<WishlistSlugs>(await stranger.get(`${BASE}/slugs`).expect(200))).toEqual(
        {
          slugs: [],
        },
      );

      expect(await rows()).toEqual([
        { owner: 'guest', slug: ALMONDS },
        { owner: 'guest', slug: CASHEWS },
      ]);
    });

    /**
     * `add()` is the one wishlist route that mints a key, and it reuses a returning guest's rather
     * than replacing it — *"minting a fresh one per save would orphan every row saved under the
     * previous key."* Nothing else reaches that `??`: the read and delete handlers short-circuit a
     * key-less visitor instead of minting.
     */
    it('saves a second product under the same key rather than orphaning the first', async () => {
      const { client, csrf } = await guest();
      const first = await client.post(`${BASE}/${ALMONDS}`).set(CSRF_HEADER, csrf).expect(200);
      const key = cookieValue(first, GUEST_COOKIE);

      const second = await client.post(`${BASE}/${CASHEWS}`).set(CSRF_HEADER, csrf).expect(200);

      expect(sets(second, GUEST_COOKIE)).toBe(false);
      // Newest first, which is what "saved" ordering means to a customer.
      expect(expectSuccess<WishlistSlugs>(second).slugs).toEqual([CASHEWS, ALMONDS]);

      const owners = await integration.dataSource.query<{ guest_token: string; count: string }[]>(
        `SELECT guest_token, count(*)::text AS count FROM wishlist_items GROUP BY guest_token`,
      );
      expect(owners).toEqual([{ guest_token: key, count: '2' }]);
    });

    /**
     * The heart is a toggle and a double click must not 409 at the customer. Asserted on the row
     * count as well as the response, because a service that answered 200 and inserted twice would
     * satisfy the response half on its own.
     */
    it('answers a second save with 200 and one row, not a 409', async () => {
      const { client, csrf } = await guest();
      await client.post(`${BASE}/${ALMONDS}`).set(CSRF_HEADER, csrf).expect(200);

      const again = await client.post(`${BASE}/${ALMONDS}`).set(CSRF_HEADER, csrf).expect(200);
      expect(expectSuccess<WishlistSlugs>(again).slugs).toEqual([ALMONDS]);
      expect(await rows()).toEqual([{ owner: 'guest', slug: ALMONDS }]);
    });

    /**
     * And the thing that makes the second save a no-op is a named index in the database, not
     * `orIgnore()` being polite. Inserted directly, with `user_id` left NULL and `guest_token` set
     * so that the row satisfies `ck_wishlist_items_owner_exclusive` — the check constraint is the
     * *other* thing this insert could violate, and a proof that accepted either message would pass
     * with the index absent.
     */
    it('is stopped by uq_wishlist_items_guest_product when the same guest row is inserted twice', async () => {
      const key = aGuestKey();
      await saveDirectly({ guestToken: key }, ALMONDS);

      await expect(saveDirectly({ guestToken: key }, ALMONDS)).rejects.toThrow(
        /uq_wishlist_items_guest_product/,
      );
      expect(await rows()).toEqual([{ owner: 'guest', slug: ALMONDS }]);
    });

    it('is stopped by uq_wishlist_items_user_product for an account row', async () => {
      const b2c = await userId('b2c@demo.in');
      await saveDirectly({ userId: b2c }, ALMONDS);

      await expect(saveDirectly({ userId: b2c }, ALMONDS)).rejects.toThrow(
        /uq_wishlist_items_user_product/,
      );
      expect(await rows()).toEqual([{ owner: 'user:b2c@demo.in', slug: ALMONDS }]);
    });

    /**
     * Removing something that was never saved satisfies the customer's intent either way, so it is
     * a no-op and not a 404. Asserted with a *different* product actually saved, so an
     * implementation that answered 200 by deleting the whole list would fail here.
     */
    it('treats removing a product that was never saved as a no-op, not a 404', async () => {
      const { client, csrf } = await guest();
      await client.post(`${BASE}/${ALMONDS}`).set(CSRF_HEADER, csrf).expect(200);

      const response = await client.delete(`${BASE}/${WALNUTS}`).set(CSRF_HEADER, csrf).expect(200);
      expect(expectSuccess<WishlistSlugs>(response).slugs).toEqual([ALMONDS]);
      expect(await rows()).toEqual([{ owner: 'guest', slug: ALMONDS }]);
    });

    /**
     * The other half of the same branch: `remove()` returns before it ever builds a `delete` when
     * the slug resolves to no product. A different code path from the one above, which does reach
     * the delete and matches nothing.
     */
    it('treats removing a slug no product has as a no-op too', async () => {
      expect(
        await integration.dataSource.query<{ id: string }[]>(
          'SELECT id FROM products WHERE slug = $1',
          [NO_SUCH_PRODUCT],
        ),
      ).toEqual([]);

      const { client, csrf } = await guest();
      await client.post(`${BASE}/${ALMONDS}`).set(CSRF_HEADER, csrf).expect(200);

      const response = await client
        .delete(`${BASE}/${NO_SUCH_PRODUCT}`)
        .set(CSRF_HEADER, csrf)
        .expect(200);
      expect(expectSuccess<WishlistSlugs>(response).slugs).toEqual([ALMONDS]);
      expect(await rows()).toEqual([{ owner: 'guest', slug: ALMONDS }]);
    });

    it('removes what was saved, leaving the rest', async () => {
      const { client, csrf } = await guest();
      await client.post(`${BASE}/${ALMONDS}`).set(CSRF_HEADER, csrf).expect(200);
      await client.post(`${BASE}/${CASHEWS}`).set(CSRF_HEADER, csrf).expect(200);

      const response = await client.delete(`${BASE}/${ALMONDS}`).set(CSRF_HEADER, csrf).expect(200);
      expect(expectSuccess<WishlistSlugs>(response).slugs).toEqual([CASHEWS]);
      expect(await rows()).toEqual([{ owner: 'guest', slug: CASHEWS }]);
    });
  });

  /**
   * An unpublished product is a product the shop does not have — the wishlist's half of the same
   * asymmetry the cart had.
   *
   * Two defects, one filter. `POST /wishlist/:slug` answered **200** for an unpublished slug and
   * **404** for one no product has, while every catalogue route answered 404 for both: an existence
   * oracle over unreleased slugs, readable from the status code alone. And `slugs()` returned an
   * unpublished save while `list()` — which resolves through `CatalogService.productsBySlugs`, and so
   * filters on publication — dropped it, so the heart rendered filled on every listing page for a
   * product the wishlist page then refused to show.
   *
   * `seedCatalog` publishes all 27 products, so each case withdraws one itself. `unpublish` reads the
   * row back rather than trusting the `UPDATE`: a mistyped slug would leave every assertion here
   * testing the published path, and passing.
   */
  describe('unpublished products', () => {
    const unpublish = async (slug: string): Promise<void> => {
      await integration.dataSource.query(
        'UPDATE products SET "isPublished" = false WHERE slug = $1',
        [slug],
      );
      const rows = await integration.dataSource.query<{ isPublished: boolean }[]>(
        'SELECT "isPublished" FROM products WHERE slug = $1',
        [slug],
      );
      if (rows.length !== 1 || rows[0]?.isPublished !== false) {
        throw new Error(`unpublish(${slug}) did not take: ${JSON.stringify(rows)}`);
      }
    };

    /**
     * The oracle, closed. Both probes answer 404 and the two envelopes are compared field for field,
     * minus the ones that are per-request by construction (`errorId`, `requestId`, `timestamp`) and
     * `path`, which names the slug and therefore has to differ.
     *
     * Asserting only the status would be too weak: a route that answered 404 for both but worded the
     * message differently, or carried a `details.slug` on one, leaks the same bit.
     */
    it('refuses a save for an unpublished product exactly as it refuses an unknown slug', async () => {
      await unpublish(PISTACHIOS);
      expect(
        await integration.dataSource.query<{ id: string }[]>(
          'SELECT id FROM products WHERE slug = $1',
          [NO_SUCH_PRODUCT],
        ),
      ).toEqual([]);
      const { client, csrf } = await guest();

      const save = (slug: string) =>
        client.post(`${BASE}/${slug}`).set(CSRF_HEADER, csrf).expect(404);

      const withdrawn = expectError(await save(PISTACHIOS));
      const unknown = expectError(await save(NO_SUCH_PRODUCT));

      const comparable = (body: typeof withdrawn) => ({
        success: body.success,
        statusCode: body.statusCode,
        code: body.code,
        message: body.message,
        details: body.details,
        method: body.method,
      });
      expect(comparable(withdrawn)).toEqual(comparable(unknown));
      expect(comparable(withdrawn)).toEqual({
        success: false,
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'That product may have been renamed or is no longer stocked.',
        details: undefined,
        method: 'POST',
      });
      // Nothing was written by either attempt. A route that inserted and then threw would satisfy
      // every assertion above.
      expect(await rows()).toEqual([]);
    });

    /**
     * The positive control, and it is the one that matters most here.
     *
     * The tempting way to write this filter is an `isPublished` test against the narrowed
     * `select: { id: true }` that `add()` already uses — and a column omitted from a narrowed select
     * comes back `undefined`, which is falsy, so that version 404s **every product in the shop**. The
     * test above passes under it unchanged; this is the one that fails.
     */
    it('still saves a published product', async () => {
      const { client, csrf } = await guest();

      const saved = await client.post(`${BASE}/${ALMONDS}`).set(CSRF_HEADER, csrf).expect(200);

      expect(expectSuccess<WishlistSlugs>(saved).slugs).toEqual([ALMONDS]);
      expect(await rows()).toEqual([{ owner: 'guest', slug: ALMONDS }]);
    });

    /**
     * `slugs()` and `list()` agree about a save that has since been withdrawn: both drop it. The heart
     * and the wishlist page are the two things reading them, and they were disagreeing.
     *
     * A second, still-published product is saved throughout, so neither empty answer can be an empty
     * table or a broken query — the same reasoning the guest-scoping test above records.
     */
    it('hides a since-unpublished save from both the slugs and the list', async () => {
      const { client, csrf } = await guest();
      await client.post(`${BASE}/${ALMONDS}`).set(CSRF_HEADER, csrf).expect(200);
      await client.post(`${BASE}/${PISTACHIOS}`).set(CSRF_HEADER, csrf).expect(200);
      expect(
        expectSuccess<WishlistSlugs>(await client.get(`${BASE}/slugs`).expect(200)).slugs,
      ).toEqual([PISTACHIOS, ALMONDS]);

      await unpublish(PISTACHIOS);

      expect(
        expectSuccess<WishlistSlugs>(await client.get(`${BASE}/slugs`).expect(200)).slugs,
      ).toEqual([ALMONDS]);
      expect(
        expectSuccess<WireProduct[]>(await client.get(BASE).expect(200)).map((p) => p.slug),
      ).toEqual([ALMONDS]);

      // Hidden, not deleted. Republishing the product gives the customer their save back, which is
      // the whole reason `remove()` is not filtered either.
      expect(await rows()).toEqual([
        { owner: 'guest', slug: ALMONDS },
        { owner: 'guest', slug: PISTACHIOS },
      ]);
    });

    /**
     * And the stranded row is still removable, because `remove()` is deliberately **not** filtered.
     * Reached directly rather than through the heart — which no longer offers it — which is exactly
     * the state a customer would be in.
     */
    it('still removes a save whose product has been unpublished', async () => {
      const { client, csrf } = await guest();
      await client.post(`${BASE}/${PISTACHIOS}`).set(CSRF_HEADER, csrf).expect(200);
      await unpublish(PISTACHIOS);

      const response = await client
        .delete(`${BASE}/${PISTACHIOS}`)
        .set(CSRF_HEADER, csrf)
        .expect(200);

      expect(expectSuccess<WishlistSlugs>(response).slugs).toEqual([]);
      expect(await rows()).toEqual([]);
    });
  });

  describe('one account against another', () => {
    it("cannot read another customer's saved items", async () => {
      const b2c = await signedIn('b2c@demo.in');
      await b2c.client.post(`${BASE}/${ALMONDS}`).set(CSRF_HEADER, b2c.csrf).expect(200);

      const b2b = await signedIn('b2b@demo.in');
      expect(expectSuccess<WireProduct[]>(await b2b.client.get(BASE).expect(200))).toEqual([]);
      expect(
        expectSuccess<WishlistSlugs>(await b2b.client.get(`${BASE}/slugs`).expect(200)).slugs,
      ).toEqual([]);

      // Again the non-empty half: b2c's row exists throughout, so b2b's empty list is scoping.
      expect(
        expectSuccess<WishlistSlugs>(await b2c.client.get(`${BASE}/slugs`).expect(200)).slugs,
      ).toEqual([ALMONDS]);
    });

    it("cannot delete another customer's saved items", async () => {
      const b2c = await signedIn('b2c@demo.in');
      await b2c.client.post(`${BASE}/${ALMONDS}`).set(CSRF_HEADER, b2c.csrf).expect(200);

      const b2b = await signedIn('b2b@demo.in');
      const response = await b2b.client
        .delete(`${BASE}/${ALMONDS}`)
        .set(CSRF_HEADER, b2b.csrf)
        .expect(200);
      expect(expectSuccess<WishlistSlugs>(response).slugs).toEqual([]);

      // `delete({ ...ownerWhere, productId })` — the owner half of that `where` is the whole point.
      // Without it b2b's toggle silently empties b2c's list.
      expect(await rows()).toEqual([{ owner: 'user:b2c@demo.in', slug: ALMONDS }]);
    });

    /**
     * `WishlistController.owner` reads the session first and the cookie second, and says why: a
     * customer who saved things as a guest and then signed in may still hold `nn_guest_token` — the
     * merge clears it, but a *failed* merge leaves it behind, and that failure is swallowed by
     * design, so this state is reachable in production.
     *
     * Built by hand rather than through an agent, because no honest client reaches it in one jar: a
     * live session cookie *and* a live guest key naming rows that were never merged.
     */
    it('prefers the session over a stale guest key', async () => {
      const key = aGuestKey();
      await saveDirectly({ guestToken: key }, CASHEWS);
      const account = await signedIn('b2c@demo.in');
      await account.client.post(`${BASE}/${ALMONDS}`).set(CSRF_HEADER, account.csrf).expect(200);
      const access = cookieValue(account.login, 'nn_access_token');

      const served = expectSuccess<WishlistSlugs>(
        await request(integration.app)
          .get(`${BASE}/slugs`)
          .set('Cookie', `nn_access_token=${access}; ${GUEST_COOKIE}=${key}`)
          .expect(200),
      );
      expect(served.slugs).toEqual([ALMONDS]);
    });
  });

  describe('the merge on sign-in', () => {
    /**
     * The case the whole feature exists to get right, and the one a repository double cannot reach.
     *
     * The account already holds A; the guest holds A and B. Afterwards the account must hold A and
     * B, **exactly one row each**, and no guest row may survive. Every assertion is on the rows:
     * `mergeGuestState` catches and logs, so an implementation that merged nothing at all would
     * still answer this sign-in with 200.
     */
    it('transfers what the account lacks, skips what it has, and deletes the guest rows', async () => {
      const account = await signedIn('b2c@demo.in');
      await account.client.post(`${BASE}/${ALMONDS}`).set(CSRF_HEADER, account.csrf).expect(200);

      const visitor = await guest();
      await visitor.client.post(`${BASE}/${ALMONDS}`).set(CSRF_HEADER, visitor.csrf).expect(200);
      await visitor.client.post(`${BASE}/${CASHEWS}`).set(CSRF_HEADER, visitor.csrf).expect(200);
      expect(await rows()).toEqual([
        { owner: 'guest', slug: ALMONDS },
        { owner: 'user:b2c@demo.in', slug: ALMONDS },
        { owner: 'guest', slug: CASHEWS },
      ]);

      const login = await visitor.client
        .post(LOGIN)
        .send({ email: 'b2c@demo.in', password: 'Password123!' })
        .expect(200);

      // Two rows, both the account's, one per product. Not three, not four, and no guest row left
      // for a second sign-in to fold again.
      expect(await rows()).toEqual([
        { owner: 'user:b2c@demo.in', slug: ALMONDS },
        { owner: 'user:b2c@demo.in', slug: CASHEWS },
      ]);
      expect(
        expectSuccess<WishlistSlugs>(await visitor.client.get(`${BASE}/slugs`).expect(200)).slugs,
      ).toHaveLength(2);

      // Both merges completed, so the key is cleared — `clearCookie` emits a `Set-Cookie` with an
      // empty value, which is why this is `cookieValue` and not `sets`.
      expect(cookieValue(login, GUEST_COOKIE)).toBe('');
    });

    /** `/auth/register` calls the same `mergeGuestState`, and nothing had exercised that end of it. */
    it('folds the guest list into a brand-new account on registration', async () => {
      const visitor = await guest();
      await visitor.client.post(`${BASE}/${ALMONDS}`).set(CSRF_HEADER, visitor.csrf).expect(200);

      await visitor.client
        .post(REGISTER)
        .send({
          name: 'New Customer',
          email: 'saved@demo.in',
          phone: '9876543219',
          password: 'Password123!',
          isBusiness: false,
        })
        .expect(201);

      expect(await rows()).toEqual([{ owner: 'user:saved@demo.in', slug: ALMONDS }]);
    });

    /**
     * The `WHERE` on the conflict target is required, not decorative, and this is the measurement
     * `MERGE_WISHLIST_SQL`'s docblock records.
     *
     * `uq_wishlist_items_user_product` is a **partial** unique index, and Postgres infers a partial
     * index only when the predicate is restated in the `ON CONFLICT` clause. Dropping it — the
     * obvious simplification — raises `there is no unique or exclusion constraint matching the ON
     * CONFLICT specification`, which `auth.controller.ts` swallows: sign-in still answers 200, one
     * line goes to a log, and the customer's saved list is simply gone.
     *
     * The stripped variant is derived from the constant rather than retyped, and the derivation is
     * asserted to have *changed* something. A `replace()` whose needle no longer exists is a
     * silent no-op, and the proof would then be running the working statement twice and passing.
     */
    it('infers the partial index from the restated predicate, and fails without it', async () => {
      const b2c = await userId('b2c@demo.in');
      const key = aGuestKey();
      await saveDirectly({ userId: b2c }, ALMONDS);
      await saveDirectly({ guestToken: key }, ALMONDS);
      await saveDirectly({ guestToken: key }, CASHEWS);

      const stripped = MERGE_WISHLIST_SQL.replace(
        ' WHERE user_id IS NOT NULL DO NOTHING',
        ' DO NOTHING',
      );
      expect(stripped).not.toBe(MERGE_WISHLIST_SQL);
      expect(stripped).not.toContain('WHERE user_id IS NOT NULL');
      expect(stripped).toContain('ON CONFLICT (user_id, product_id) DO NOTHING');

      await expect(integration.dataSource.query(stripped, [b2c, key])).rejects.toThrow(
        /no unique or exclusion constraint matching the ON CONFLICT specification/,
      );
      // Nothing was written by the failed statement, so the real one runs against identical state.
      expect(await rows()).toEqual([
        { owner: 'guest', slug: ALMONDS },
        { owner: 'user:b2c@demo.in', slug: ALMONDS },
        { owner: 'guest', slug: CASHEWS },
      ]);

      await integration.dataSource.query(MERGE_WISHLIST_SQL, [b2c, key]);
      // A skipped, B transferred: the account gained exactly one row.
      expect(await rows()).toEqual([
        { owner: 'guest', slug: ALMONDS },
        { owner: 'user:b2c@demo.in', slug: ALMONDS },
        { owner: 'guest', slug: CASHEWS },
        { owner: 'user:b2c@demo.in', slug: CASHEWS },
      ]);
    });

    /**
     * The statement reads the same table it writes, and the claim in its docblock is that the
     * snapshot taken at statement start is why that terminates rather than looping.
     *
     * Run bare — no wrapping transaction, no follow-up delete — so the guest rows the `SELECT` reads
     * are still present alongside the rows the `INSERT` just made. The assertion is the resulting
     * set: three guest rows in, three account rows out, and the *second* guest's row untouched. A
     * statement that could see its own output would not stop at six.
     *
     * The second guest is what makes the count load-bearing rather than a tautology. Without a row
     * belonging to somebody else, `WHERE w.guest_token = $2` could be deleted from the `SELECT`
     * altogether and every number here would still come out the same — measured, and the reason this
     * fixture has four keys' worth of rows rather than one.
     *
     * Run twice, too. The second pass reads the same three guest rows and inserts nothing, which is
     * what makes the retry after a swallowed failure harmless — and is the only reason
     * `auth.controller.ts` can leave `nn_guest_token` in place and let the next sign-in try again.
     */
    it('writes exactly the guest rows once, though it selects from the table it inserts into', async () => {
      const b2c = await userId('b2c@demo.in');
      const key = aGuestKey();
      for (const slug of [ALMONDS, CASHEWS, PISTACHIOS]) {
        await saveDirectly({ guestToken: key }, slug);
      }
      // A different visitor entirely, whose saved item must not be folded into this account.
      await saveDirectly({ guestToken: aGuestKey(2) }, WALNUTS);

      await integration.dataSource.query(MERGE_WISHLIST_SQL, [b2c, key]);
      expect(await rows()).toEqual([
        { owner: 'guest', slug: WALNUTS },
        { owner: 'guest', slug: ALMONDS },
        { owner: 'user:b2c@demo.in', slug: ALMONDS },
        { owner: 'guest', slug: PISTACHIOS },
        { owner: 'user:b2c@demo.in', slug: PISTACHIOS },
        { owner: 'guest', slug: CASHEWS },
        { owner: 'user:b2c@demo.in', slug: CASHEWS },
      ]);

      await integration.dataSource.query(MERGE_WISHLIST_SQL, [b2c, key]);
      expect(await rows()).toHaveLength(7);
    });
  });

  /**
   * The two sign-in merges are caught **separately**, and these two tests are the only things that
   * can tell that apart from one shared `try`. With a shared block, the first failure returns before
   * the second merge is ever called, so a customer whose basket merge deadlocked would silently
   * lose their saved list as well — a second loss caused by nothing to do with the wishlist.
   *
   * Both faults are injected into Postgres rather than by stubbing a provider: `createTestApp`
   * offers no `overrideProvider`, and a mocked service would take the merge SQL — the thing actually
   * under test — out of the picture.
   */
  describe('when one of the two merges fails', () => {
    /**
     * A guest holding both a basket and a saved item, which is what both tests below need.
     *
     * The key comes from the **cart** write, not the wishlist one: `PUT /cart` mints it first, and
     * the wishlist `POST` then reuses it and sets no cookie at all — the two features share one key
     * precisely so that one sign-in merges both. Reading it off the second response instead throws
     * `Response set no nn_guest_token cookie`, which is how this was found.
     */
    async function visitorWithBoth() {
      const visitor = await guest();
      const basket = await visitor.client
        .put(CART)
        .set(CSRF_HEADER, visitor.csrf)
        .send({ lines: [cartLine] })
        .expect(200);
      const saved = await visitor.client
        .post(`${BASE}/${ALMONDS}`)
        .set(CSRF_HEADER, visitor.csrf)
        .expect(200);
      expect(sets(saved, GUEST_COOKIE)).toBe(false);
      return { ...visitor, key: cookieValue(basket, GUEST_COOKIE) };
    }

    const cartOwners = async (): Promise<{ owner: string; items: string }[]> =>
      integration.dataSource.query<{ owner: string; items: string }[]>(
        `SELECT CASE WHEN c.user_id IS NOT NULL THEN 'user' ELSE 'guest' END AS owner,
                count(i.id)::text AS items
           FROM carts c LEFT JOIN cart_items i ON i.cart_id = c.id
          GROUP BY 1 ORDER BY 1`,
      );

    /**
     * The direction that distinguishes the two `catch` blocks from one. `CHECK (false) NOT VALID`
     * lets the guest's existing `cart_items` rows stand while making the merge's re-insert fail, so
     * the cart merge throws exactly where a deadlock would and nothing else is disturbed.
     */
    it('still merges the wishlist when the cart merge throws, and keeps the key', async () => {
      const visitor = await visitorWithBoth();
      await integration.dataSource.query(
        `ALTER TABLE cart_items ADD CONSTRAINT ck_tmp_break_cart_merge CHECK (false) NOT VALID`,
      );
      try {
        const login = await visitor.client
          .post(LOGIN)
          .send({ email: 'b2c@demo.in', password: 'Password123!' })
          .expect(200);

        // The wishlist merge ran regardless, which is the claim.
        expect(await rows()).toEqual([{ owner: 'user:b2c@demo.in', slug: ALMONDS }]);
        // The cart merge's transaction rolled back whole: the guest basket and its line survive,
        // and no empty account cart was left behind holding nothing.
        expect(await cartOwners()).toEqual([{ owner: 'guest', items: '1' }]);
        // And the key is not cleared, because it is the only name those basket rows have. Left
        // cleared, they would be unreachable forever; left alone, the next sign-in retries.
        expect(sets(login, GUEST_COOKIE)).toBe(false);
      } finally {
        await integration.dataSource.query(
          `ALTER TABLE cart_items DROP CONSTRAINT ck_tmp_break_cart_merge`,
        );
      }
    });

    /**
     * The reverse, injected as the production failure `MERGE_WISHLIST_SQL` names: without
     * `uq_wishlist_items_user_product` there is no partial index for the `ON CONFLICT` clause to
     * infer, so the statement raises before it writes anything.
     *
     * This one also demonstrates why every assertion in this file is on rows. The `.expect(200)`
     * below holds — sign-in succeeds — while the customer's saved list is not merged at all. A test
     * whose *claim* was that status code would pass against exactly this state.
     */
    it('still merges the cart when the wishlist merge throws, and keeps the key', async () => {
      const visitor = await visitorWithBoth();
      await integration.dataSource.query(`DROP INDEX uq_wishlist_items_user_product`);
      try {
        const login = await visitor.client
          .post(LOGIN)
          .send({ email: 'b2c@demo.in', password: 'Password123!' })
          .expect(200);

        // Not merged, and the guest row is still there — which is exactly what makes it recoverable.
        expect(await rows()).toEqual([{ owner: 'guest', slug: ALMONDS }]);
        // The basket made it across all the same: one cart, the account's, still holding its line.
        expect(await cartOwners()).toEqual([{ owner: 'user', items: '1' }]);
        expect(sets(login, GUEST_COOKIE)).toBe(false);
      } finally {
        await integration.dataSource.query(
          `CREATE UNIQUE INDEX uq_wishlist_items_user_product
             ON wishlist_items (user_id, product_id) WHERE user_id IS NOT NULL`,
        );
      }
    });
  });

  describe('ck_wishlist_items_owner_exclusive', () => {
    /**
     * The service always sets exactly one owner. These two assert the constraint would catch a
     * future writer that forgot, which is why it exists rather than a comment. Both use a product
     * no other row here holds, so the unique indexes cannot be what rejects them.
     */
    it('rejects a row belonging to nobody', async () => {
      await expect(
        integration.dataSource.query(
          'INSERT INTO wishlist_items (user_id, guest_token, product_id) VALUES (NULL, NULL, $1)',
          [await productId(ALMONDS)],
        ),
      ).rejects.toThrow(/ck_wishlist_items_owner_exclusive/);
      expect(await rows()).toEqual([]);
    });

    /**
     * The worse of the two. A row with both owners is returned by `find({ userId })` *and* by
     * `find({ guestToken })`, so one customer's saved list would answer to a cookie any visitor
     * could hold.
     */
    it('rejects a row claiming both owners', async () => {
      await expect(
        integration.dataSource.query(
          'INSERT INTO wishlist_items (user_id, guest_token, product_id) VALUES ($1, $2, $3)',
          [await userId('b2c@demo.in'), aGuestKey(), await productId(ALMONDS)],
        ),
      ).rejects.toThrow(/ck_wishlist_items_owner_exclusive/);
      expect(await rows()).toEqual([]);
    });
  });

  describe('deleting a product', () => {
    /**
     * A seeded product cannot actually be deleted, and `wishlist-item.entity.ts` says the opposite.
     *
     * Its docblock closes with *"Nothing referencing `products` uses RESTRICT, so a product can
     * actually be deleted — which is what makes Task 29's cascade test runnable at all."* Nothing
     * references `products` with RESTRICT, true; the restriction is one hop further out.
     * `product_variants.product_id` is `ON DELETE CASCADE`, so a product delete tries to take its
     * variants — and `inventory_transactions.variant_id` is `ON DELETE RESTRICT`
     * (`20260819120000-InitialSchema.ts:352`). Measured here, `DELETE FROM products WHERE slug =
     * 'premium-california-almonds'` raises:
     *
     *     update or delete on table "product_variants" violates foreign key constraint
     *     "FK_aeb0f3a59ed2fd95e1a13097eda" on table "inventory_transactions"
     *
     * and `seedCatalog` writes one opening `RECEIPT` per variant, so this is true of *every* seeded
     * product. So the ledger rows go first, and that statement is part of the fixture rather than
     * part of the claim. The claim is still the one Task 29 asks for: `fk_wishlist_items_product` is
     * `ON DELETE CASCADE`, so both owner kinds' saved rows go with the product and the rows for
     * other products stay.
     */
    it('takes its saved rows with it, whoever saved them', async () => {
      const b2c = await userId('b2c@demo.in');
      const key = aGuestKey();
      await saveDirectly({ userId: b2c }, ALMONDS);
      await saveDirectly({ guestToken: key }, ALMONDS);
      await saveDirectly({ guestToken: key }, CASHEWS);

      await expect(
        integration.dataSource.query('DELETE FROM products WHERE slug = $1', [ALMONDS]),
      ).rejects.toThrow(/violates foreign key constraint .* on table "inventory_transactions"/);

      await integration.dataSource.query(
        `DELETE FROM inventory_transactions WHERE variant_id IN
           (SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
             WHERE p.slug = $1)`,
        [ALMONDS],
      );
      await integration.dataSource.query('DELETE FROM products WHERE slug = $1', [ALMONDS]);

      expect(await rows()).toEqual([{ owner: 'guest', slug: CASHEWS }]);
      // Nothing orphaned either — no row survives pointing at a product that is gone. `rows()`
      // inner-joins `products`, so it could not see one.
      const orphans = await integration.dataSource.query<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM wishlist_items w
           WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = w.product_id)`,
      );
      expect(orphans).toEqual([{ count: '0' }]);
    });

    /**
     * And it leaves **no snapshot**, which is the intended difference from `order_items` — measured
     * against that table rather than asserted, so the contrast is real.
     *
     * `order_items` keeps the product's `name`, its `hsn` and the price it was bought at precisely
     * so a GST invoice can be reprinted after the product is delisted, and its `product_id` is
     * `SET NULL` for the same reason. `wishlist_items` has nowhere to keep any of that: its columns
     * are the id, the two timestamps, the two owner columns and the FK. There is nothing a delete
     * could strand, so there is no stale name or price to show a customer later.
     */
    it('leaves nothing behind to snapshot, unlike order_items', async () => {
      const columns = async (table: string): Promise<string[]> => {
        const found = await integration.dataSource.query<{ column_name: string }[]>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`,
          [table],
        );
        return found.map((row) => row.column_name);
      };

      expect(await columns('wishlist_items')).toEqual([
        'createdAt',
        'guest_token',
        'id',
        'product_id',
        'updatedAt',
        'user_id',
      ]);
      // The comparison that makes the claim mean something: the table that *does* snapshot keeps
      // the product's name, its HSN code and the price paid, and this one keeps none of them.
      expect(await columns('order_items')).toEqual(
        expect.arrayContaining(['name', 'hsn', 'unitPricePaise']),
      );
      for (const snapshot of ['name', 'hsn', 'unitPricePaise']) {
        expect(await columns('wishlist_items')).not.toContain(snapshot);
      }
    });
  });
});
