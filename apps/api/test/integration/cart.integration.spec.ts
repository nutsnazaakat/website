import { randomBytes } from 'node:crypto';
import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { CartLine, CartTotals, CartValidationResult } from '@nutwala/shared';
import type { Response } from 'supertest';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { seedUsers } from '../../src/database/seeds/users.seed';
import {
  agent,
  cookieEntry,
  cookieValue,
  expectError,
  expectStatus,
  expectSuccess,
  request,
  useIntegrationApp,
  waitForABlockedWriter,
} from './helpers';

/**
 * Cookie and header names are spelled out rather than imported from `guest-token.ts` and
 * `cookie.service.ts`, for the reason `auth.integration.spec.ts` gives at length: they are wire
 * contract. The Phase 1 frontend reads `nn_csrf` by name and echoes it in `X-CSRF-Token`, and
 * `pii-redactor.ts` scrubs `nn_guest_token` only because that spelling contains `token`. Importing
 * the constants would make a rename typecheck and keep these tests green while every existing
 * client broke.
 */
const GUEST_COOKIE = 'nn_guest_token';
const CSRF_COOKIE = 'nn_csrf';
const CSRF_HEADER = 'X-CSRF-Token';
const ACCESS_COOKIE = 'nn_access_token';

const BASE = '/api/v1/cart';
const LOGIN = '/api/v1/auth/login';

interface CartResponse {
  lines: CartLine[];
  totals: CartTotals;
}

const ALMONDS = 'premium-california-almonds';
/** ₹299 for the 250g pack (`buildVariants`: round(999 * 0.3 / 10) * 10 - 1), so qty 2 is ₹598. */
const almonds = { slug: ALMONDS, mode: 'retail' as const, size: '250g', qty: 2 };

/**
 * Whether a response sets one named cookie at all — the assertion `cookieEntry` cannot make,
 * because it throws when the cookie is absent.
 */
const sets = (response: Response, name: string): boolean =>
  (response.get('Set-Cookie') ?? []).some((cookie) => cookie.startsWith(`${name}=`));

describe('cart', () => {
  const integration = useIntegrationApp();

  /**
   * Empties the rate limiter between tests.
   *
   * `useIntegrationApp` boots one application for the whole file, so `ThrottlerGuard`'s in-memory
   * storage is shared by every test in it, and `POST /auth/login` is capped at **five attempts per
   * fifteen minutes per IP** with every supertest request arriving from 127.0.0.1. This file signs
   * in eleven times, so without this the sixth login 429s and the failure lands on whichever test
   * happens to be sixth rather than on anything that test did. No test here signs in more than
   * twice, so the reset cannot weaken one.
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

  /** Signs in and returns a cookie-persisting client, its CSRF token, and the login response. */
  async function signedIn(email = 'b2c@demo.in') {
    const client = agent(integration.app);
    const login = await client.post(LOGIN).send({ email, password: 'Password123!' }).expect(200);
    return { client, login, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  }

  /**
   * An anonymous client that already holds `nn_csrf`, plus the token to echo.
   *
   * **A cold write can never succeed and must not be written as though it can.** `CsrfGuard` is
   * registered globally and requires both a cookie and a matching header on every method but
   * GET/HEAD/OPTIONS — `if (!cookie || !header) throw this.reject()` (`csrf.guard.ts:40`) — and a
   * brand-new client has neither. `CsrfBootstrapMiddleware` sets `nn_csrf` on the **response**, so
   * it is available from the *next* request onward; it cannot retroactively satisfy the guard on the
   * request that minted it, and it must not, or an attacker's cross-site POST would be handed a
   * fresh pair too.
   *
   * So one priming request first — any safe method will do, since the middleware runs on all of
   * them. Every write and every `POST /cart/validate` in this file goes through here or through
   * `signedIn()`, whose token comes from `CookieService.issue()` instead.
   */
  async function guest() {
    const client = agent(integration.app);
    const primer = await client.get(BASE).expect(200);
    return { client, csrf: cookieValue(primer, CSRF_COOKIE) };
  }

  const countCarts = async (): Promise<string> => {
    const rows = await integration.dataSource.query<{ count: string }[]>(
      'SELECT count(*)::text AS count FROM carts WHERE guest_token IS NOT NULL',
    );
    return rows[0]?.count ?? 'no rows';
  };

  const countItems = async (): Promise<string> => {
    const rows = await integration.dataSource.query<{ count: string }[]>(
      'SELECT count(*)::text AS count FROM cart_items',
    );
    return rows[0]?.count ?? 'no rows';
  };

  /** Rewrites the 250g almond pack's stock, for the out-of-stock paths. */
  const setStock = async (onHand: number): Promise<void> => {
    await integration.dataSource.query(
      `UPDATE inventory SET "onHand" = $1, reserved = 0
        WHERE variant_id = (
          SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
           WHERE p.slug = $2 AND v.size = '250g')`,
      [onHand, ALMONDS],
    );
  };

  describe('guest carts', () => {
    it('creates a basket for a visitor with no session and hands back a cookie', async () => {
      const { client, csrf } = await guest();
      const response = await client
        .put(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ lines: [almonds] })
        .expect(200);

      const body = expectSuccess<CartResponse>(response);
      expect(body.lines).toHaveLength(1);
      expect(body.totals.subtotal).toBe(598);

      const entry = cookieEntry(response, GUEST_COOKIE);
      // The key is a bearer credential for the basket, so script must not be able to read it.
      expect(entry).toMatch(/HttpOnly/i);
      /**
       * `SameSite=Lax`, not `Strict`, and pinned because nothing else pins it: a customer arriving
       * from a Google result or a WhatsApp link must still find the basket they built before they
       * left, which `Strict` would silently break on exactly the traffic the shop depends on.
       * 30 days, matching `THIRTY_DAYS_MS` — a basket has to survive a device being closed.
       */
      expect(entry).toMatch(/SameSite=Lax/i);
      expect(entry).toMatch(/Max-Age=2592000/);
      expect(entry).toMatch(/Path=\//);

      // The value the customer holds is the name of the row that was created — not merely a
      // well-formed key. A cookie naming no row is an empty basket on the very next request.
      const rows = await integration.dataSource.query<{ guest_token: string }[]>(
        'SELECT guest_token FROM carts',
      );
      expect(rows).toEqual([{ guest_token: cookieValue(response, GUEST_COOKIE) }]);
    });

    it('returns the same basket to the same cookie and nothing to a different visitor', async () => {
      const { client: first, csrf } = await guest();
      await first
        .put(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ lines: [almonds] })
        .expect(200);
      expect(expectSuccess<CartResponse>(await first.get(BASE).expect(200)).lines).toHaveLength(1);

      // A fresh client is a different visitor. If this returns the first basket, the cart is not
      // actually scoped by the key and every guest shares one.
      const second = agent(integration.app);
      expect(expectSuccess<CartResponse>(await second.get(BASE).expect(200)).lines).toEqual([]);
    });

    /**
     * Not in the plan's own list, and the one thing `replace()`'s `readGuestToken(request) ??
     * this.issue(response)` exists for: *"minting a fresh one per write would orphan the previous
     * cart row on every save."* Nothing else reaches it — the returning-visitor test above writes
     * once and then only reads, and a `GET` never mints.
     */
    it('reuses the guest key on a second write rather than orphaning the first cart', async () => {
      const { client, csrf } = await guest();
      const first = await client
        .put(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ lines: [almonds] })
        .expect(200);
      const key = cookieValue(first, GUEST_COOKIE);

      const second = await client
        .put(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ lines: [{ ...almonds, qty: 5 }] })
        .expect(200);

      expect(sets(second, GUEST_COOKIE)).toBe(false);
      expect(expectSuccess<CartResponse>(second).lines[0]?.qty).toBe(5);
      // One row, still the one the first write created — not a second, orphaned basket.
      const rows = await integration.dataSource.query<{ guest_token: string }[]>(
        'SELECT guest_token FROM carts',
      );
      expect(rows).toEqual([{ guest_token: key }]);
    });

    /**
     * `readGuestToken` validates the value against the shape this service issues rather than passing
     * it through, because the key goes straight into a `WHERE guest_token = $1`.
     *
     * **The read half cannot fail and is kept only as documentation.** A forged key is simply a key
     * no row has, so the basket is empty whether `KEY_PATTERN` is enforced or not — measured, by
     * deleting the check and watching this whole suite stay green. The **write** half is what the
     * check earns: without it the forgery is stored as the cart's `guest_token`, and the customer's
     * basket is then named by a value an attacker chose and can therefore replay. With it the forgery
     * is discarded and a fresh 43-character key is minted.
     */
    it('refuses a forged guest key rather than adopting it', async () => {
      const forged = '../../etc/passwd';
      const read = await request(integration.app)
        .get(BASE)
        .set('Cookie', `${GUEST_COOKIE}=${forged}`)
        .expect(200);
      // Treated as no key at all: an empty basket, not an error and not someone else's cart.
      expect(expectSuccess<CartResponse>(read).lines).toEqual([]);

      const csrf = cookieValue(read, CSRF_COOKIE);
      const write = await request(integration.app)
        .put(BASE)
        .set('Cookie', `${CSRF_COOKIE}=${csrf}; ${GUEST_COOKIE}=${forged}`)
        .set(CSRF_HEADER, csrf)
        .send({ lines: [almonds] })
        .expect(200);

      const issued = cookieValue(write, GUEST_COOKIE);
      expect(issued).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const rows = await integration.dataSource.query<{ guest_token: string }[]>(
        'SELECT guest_token FROM carts',
      );
      expect(rows).toEqual([{ guest_token: issued }]);
      expect(rows[0]?.guest_token).not.toBe(forged);
    });

    /**
     * `CartService.find` deliberately does not create on read, and `CartController.owner` returns
     * `{}` for a visitor with no cookie: *"a crawler cannot be handed a 30-day identifier by reading
     * the shop."* Both halves are asserted here because nothing else asserts either.
     */
    it('mints no guest key and writes no row for a visitor who only reads', async () => {
      const response = await request(integration.app).get(BASE).expect(200);

      expect(sets(response, GUEST_COOKIE)).toBe(false);
      expect(await countCarts()).toBe('0');
    });

    /**
     * Removing the last item. `replace` guards its `insert` with `resolved.length > 0`, and nothing
     * else exercises the empty side of it — an unguarded `insert([])` is a TypeORM error, so this is
     * the difference between "basket emptied" and a 500 on the last Remove click.
     *
     * The exact-shape `toEqual` is deliberate: `CartTotals` has six fields, and a totals object that
     * quietly grew or lost one is a Phase 1 wire-contract break that a field-by-field assertion
     * would not see.
     */
    it('empties the basket when sent no lines, keeping the cart row', async () => {
      const { client, csrf } = await guest();
      await client
        .put(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ lines: [almonds] })
        .expect(200);

      const emptied = expectSuccess<CartResponse>(
        await client.put(BASE).set(CSRF_HEADER, csrf).send({ lines: [] }).expect(200),
      );

      expect(emptied.lines).toEqual([]);
      expect(emptied.totals).toEqual({
        subtotal: 0,
        gst: 0,
        // Zero, not the ₹79 flat rate: `shippingPaise` guards on `subtotalPaise === 0n`, so an
        // empty basket is not quoted postage.
        shipping: 0,
        total: 0,
        hasQuoteLines: false,
        hasUnpriceableLines: false,
      });
      expect(await countItems()).toBe('0');
      expect(await countCarts()).toBe('1');
    });

    /**
     * A bulk line's weight makes a round trip only a real database can test. `kg` is
     * `numeric(8,2)`, which `pg` hands back as the **string** `'25.00'`, and `toCartLine` converts
     * it: left as a string the wire type would be wrong and the line id would read
     * `b:premium-california-almonds:25.00`, matching no optimistic line the browser holds. A unit
     * test passing `'25.00'` as a literal is asserting its own fixture; this asserts Postgres.
     */
    it("round-trips a stored bulk line's weight as a number", async () => {
      const { client, csrf } = await guest();
      const body = expectSuccess<CartResponse>(
        await client
          .put(BASE)
          .set(CSRF_HEADER, csrf)
          .send({ lines: [{ slug: ALMONDS, mode: 'bulk', kg: 25, qty: 1 }] })
          .expect(200),
      );

      // No `size` and no `grams`: a bulk line is not variant-bound, and `CartLine` omits the two
      // rather than sending null, because the frontend branches on `line.kg !== undefined`.
      expect(body.lines).toEqual([
        { id: `b:${ALMONDS}:25`, slug: ALMONDS, mode: 'bulk', kg: 25, qty: 1 },
      ]);
      // The 25–49kg slab is ₹849/kg (round(999 * 0.85)), so 25kg is ₹21,225 and shipping is free.
      expect(body.totals.subtotal).toBe(21225);
      expect(body.totals.shipping).toBe(0);
    });
  });

  describe('merge on sign-in', () => {
    /**
     * The case this milestone exists to get right. A guest builds a basket, signs in at checkout,
     * and must find it intact — losing it there is the most expensive bug available, because it
     * happens at the moment the customer was about to pay.
     */
    it('folds a guest basket into the account on sign-in', async () => {
      const { client, csrf } = await guest();
      await client
        .put(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ lines: [almonds] })
        .expect(200);

      await client.post(LOGIN).send({ email: 'b2c@demo.in', password: 'Password123!' }).expect(200);

      const after = expectSuccess<CartResponse>(await client.get(BASE).expect(200));
      expect(after.lines).toHaveLength(1);
      expect(after.lines[0]?.qty).toBe(2);
    });

    it('sums quantities when both baskets hold the same line', async () => {
      // Put one bag in the account first.
      const account = await signedIn();
      await account.client
        .put(BASE)
        .set(CSRF_HEADER, account.csrf)
        .send({ lines: [{ ...almonds, qty: 1 }] })
        .expect(200);

      // Then a separate anonymous visit adds two more and signs in.
      const visitor = await guest();
      await visitor.client
        .put(BASE)
        .set(CSRF_HEADER, visitor.csrf)
        .send({ lines: [{ ...almonds, qty: 2 }] })
        .expect(200);
      await visitor.client
        .post(LOGIN)
        .send({ email: 'b2c@demo.in', password: 'Password123!' })
        .expect(200);

      const merged = expectSuccess<CartResponse>(await visitor.client.get(BASE).expect(200));
      expect(merged.lines).toHaveLength(1);
      // Summed, not maxed: two bags added as a guest plus one added after signing in is three.
      expect(merged.lines[0]?.qty).toBe(3);
    });

    /**
     * `mergeLines` clamps to `MAX_LINE_QTY`, and the consequence it exists for is reachable only
     * through the API. Unclamped, 999 as a guest plus 999 signed in stores 1998 in an `int` column
     * quite happily — and then **every** subsequent `PUT /cart` fails validation on
     * `@Max(999)`, because the client echoes the basket back as it read it. The customer's cart
     * becomes unmodifiable and they discover it at checkout. The follow-up `PUT` below is the half a
     * unit test on the arithmetic cannot make.
     */
    it('clamps a merged quantity to the cap so the basket stays modifiable', async () => {
      const account = await signedIn();
      await account.client
        .put(BASE)
        .set(CSRF_HEADER, account.csrf)
        .send({ lines: [{ ...almonds, qty: 999 }] })
        .expect(200);

      const visitor = await guest();
      await visitor.client
        .put(BASE)
        .set(CSRF_HEADER, visitor.csrf)
        .send({ lines: [{ ...almonds, qty: 999 }] })
        .expect(200);
      const login = await visitor.client
        .post(LOGIN)
        .send({ email: 'b2c@demo.in', password: 'Password123!' })
        .expect(200);

      const merged = expectSuccess<CartResponse>(await visitor.client.get(BASE).expect(200));
      expect(merged.lines[0]?.qty).toBe(999);

      // And the quantity the customer was just shown is one they can still save. Rebuilt as a DTO
      // rather than echoing `merged.lines` verbatim: `CartLine` carries `id` and `grams`, which
      // `forbidNonWhitelisted` refuses, so echoing it would 400 for a reason unrelated to the cap.
      await visitor.client
        .put(BASE)
        .set(CSRF_HEADER, expectSuccess<{ csrfToken: string }>(login).csrfToken)
        .send({ lines: [{ ...almonds, qty: merged.lines[0]?.qty }] })
        .expect(200);
    });

    it('deletes the guest cart so a second merge cannot double the quantity', async () => {
      const { client, csrf: guestCsrf } = await guest();
      await client
        .put(BASE)
        .set(CSRF_HEADER, guestCsrf)
        .send({ lines: [almonds] })
        .expect(200);
      const login = await client
        .post(LOGIN)
        .send({ email: 'b2c@demo.in', password: 'Password123!' })
        .expect(200);
      const csrf = expectSuccess<{ csrfToken: string }>(login).csrfToken;

      // Calling merge again explicitly must be a no-op.
      await client.post(`${BASE}/merge`).set(CSRF_HEADER, csrf).expect(200);
      const after = expectSuccess<CartResponse>(await client.get(BASE).expect(200));
      expect(after.lines[0]?.qty).toBe(2);

      expect(await countCarts()).toBe('0');
      // One line total, so the guest cart's items went with it. Without `ON DELETE CASCADE` on
      // `cart_items.cart_id` the delete inside `mergeInto` would have failed outright.
      expect(await countItems()).toBe('1');
    });

    it("keeps one customer out of another customer's basket", async () => {
      const b2c = await signedIn('b2c@demo.in');
      await b2c.client
        .put(BASE)
        .set(CSRF_HEADER, b2c.csrf)
        .send({ lines: [almonds] })
        .expect(200);

      const b2b = await signedIn('b2b@demo.in');
      expect(expectSuccess<CartResponse>(await b2b.client.get(BASE).expect(200)).lines).toEqual([]);
    });

    /**
     * `CartController.owner` reads the session first and the cookie second, and says why: *"a
     * customer who built a basket as a guest and then signed in may still hold `nn_guest_token` —
     * the merge clears it, but a failed merge or a second tab leaves it behind — so a cookie that
     * outranked the session would serve them the wrong basket."* A failed merge is logged and
     * swallowed by design, so this state is reachable in production and nothing else covered it.
     *
     * Built by hand rather than through an agent, because the state under test is one no honest
     * client reaches in a single jar: a live session cookie *and* a live guest key for a cart that
     * was never merged.
     */
    it('prefers the session over a stale guest cookie', async () => {
      const visitor = await guest();
      const guestWrite = await visitor.client
        .put(BASE)
        .set(CSRF_HEADER, visitor.csrf)
        .send({ lines: [{ ...almonds, qty: 7 }] })
        .expect(200);
      const stale = cookieValue(guestWrite, GUEST_COOKIE);

      const account = await signedIn();
      await account.client
        .put(BASE)
        .set(CSRF_HEADER, account.csrf)
        .send({ lines: [{ ...almonds, qty: 3 }] })
        .expect(200);
      const access = cookieValue(account.login, ACCESS_COOKIE);

      const served = expectSuccess<CartResponse>(
        await request(integration.app)
          .get(BASE)
          .set('Cookie', `${ACCESS_COOKIE}=${access}; ${GUEST_COOKIE}=${stale}`)
          .expect(200),
      );
      expect(served.lines[0]?.qty).toBe(3);
    });

    /**
     * `POST /cart/merge` is the one cart route without `@Public()`, because there is nothing to
     * merge *into* without a session — so the guard answers rather than the handler guessing. Made
     * `@Public()` by mistake, `@CurrentUser()` throws and this becomes a 500.
     */
    it('refuses an anonymous merge', async () => {
      const { client, csrf } = await guest();
      await client.post(`${BASE}/merge`).set(CSRF_HEADER, csrf).expect(401);
    });
  });

  /**
   * Task 20 requires these four directly, and an earlier version of this spec had none of them:
   * every CSRF token in it came from `signedIn()`, so nothing exercised the anonymous bootstrap at
   * all. Task 20 predicted precisely that — *"a spec that only ever uses `agent()` after a `GET`
   * would pass without proving any of it."*
   */
  describe('the anonymous CSRF bootstrap', () => {
    it('hands a brand-new client an nn_csrf cookie on its very first request', async () => {
      const response = await request(integration.app).get(BASE).expect(200);
      const entry = cookieEntry(response, CSRF_COOKIE);
      // Readable by script on purpose — the frontend has to echo it in a header, which is the whole
      // mechanism. It is not a credential: it proves only that the caller could read a same-site
      // cookie.
      expect(entry).not.toMatch(/HttpOnly/i);
    });

    it('lets a guest write once it holds the cookie-and-header pair', async () => {
      const { client, csrf } = await guest();
      await client
        .put(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ lines: [almonds] })
        .expect(200);
    });

    it('refuses the same write without the header', async () => {
      const { client } = await guest();
      const response = await client
        .put(BASE)
        .send({ lines: [almonds] })
        .expect(403);
      expect(expectError(response).code).toBe('CSRF_TOKEN_INVALID');
    });

    /**
     * **The one a naive implementation gets wrong.** If `CsrfBootstrapMiddleware` mints a token
     * unconditionally instead of only when the cookie is absent, it overwrites the one
     * `CookieService.issue()` set at sign-in — invalidating the header the client is already
     * sending, so every subsequent write from a signed-in customer 403s. Nothing else in this suite
     * would notice: `signedIn()` reads its token once, and each test makes one write.
     */
    it("does not rotate a signed-in client's token on a later request", async () => {
      const { client, csrf } = await signedIn();
      const later = await client.get(BASE).expect(200);

      // Either the response re-sets the identical value, or it sets no nn_csrf at all. What it must
      // not do is set a different one.
      if (sets(later, CSRF_COOKIE)) expect(cookieValue(later, CSRF_COOKIE)).toBe(csrf);

      // And the original token must still be accepted, which is the consequence that actually
      // matters.
      await client
        .put(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ lines: [almonds] })
        .expect(200);
    });
  });

  /**
   * The race `upsertCart`'s insert-or-ignore exists to close, and **nothing else in this plan covers
   * it.** Task 18's unit test pins the code *shape*, and it says so: a single-threaded fake cannot
   * tell insert-or-ignore from `findOne`-then-`save`, because the latter passes too. Only real
   * Postgres can — and only if the two inserts genuinely overlap.
   *
   * **`Promise.all` of identical writes does not reliably make them overlap, so it is not what this
   * test does.** Measured against a `findOne`-then-`save` mutant: four concurrent `PUT /cart` for one
   * key are caught 3/3 in a cold single-test run and missed 2/2 in a warm full-suite run, where each
   * request finishes before the next one's insert is dispatched. Calling `CartService.replace`
   * directly is no better (1/2). A test whose verdict depends on how hot the JIT is proves nothing,
   * and this one has to prove something: it is the only place in the plan that can.
   *
   * So the rival is held open deliberately. A second connection inserts the same `guest_token` and
   * does **not** commit; the request goes out, blocks on `uq_carts_guest_token`, and only then does
   * the rival commit. That is the exact interleaving the docstring on `upsertCart` describes — a key
   * whose row is being created by someone else right now — with the test controlling it instead of
   * hoping for it. Reachable in production two ways: a key issued in one tab while another tab's
   * first write is still in flight, and the `nn_guest_token` a browser still holds after a merge
   * deleted its row.
   *
   * Under `findOne`-then-`save` the read returns nothing, because the rival is uncommitted; the
   * insert then blocks, and the rival's commit turns it into `23505` — a 500 on a guest's Add to
   * Cart. Under insert-or-ignore the loser blocks on the index, does nothing, and reads the winner's
   * row.
   *
   * **A separate concurrency defect is deliberately not covered here, because it is not fixed and
   * pinning it would freeze it.** `replace()` deletes and re-inserts `cart_items` with no lock on the
   * cart, so genuinely overlapping whole-basket writes each delete on a snapshot in which their
   * rivals' inserts are invisible and every insert survives. Measured 3/3: four concurrent
   * `PUT /cart` for one owner — guest or signed-in, new cart or existing — leave **three** copies of
   * one line and a subtotal of ₹1,794 in place of ₹598. A `FOR UPDATE` on the cart row inside the
   * transaction is the small fix; it belongs with `CartService` and its unit spec, not here.
   */
  it('survives a first write whose row is being created by a rival', async () => {
    const primer = await request(integration.app).get(BASE).expect(200);
    const csrf = cookieValue(primer, CSRF_COOKIE);
    // 32 random bytes, base64url — the shape `issueGuestToken` produces and `readGuestToken`
    // accepts. A key of any other shape is discarded as forged and would never reach `upsertCart`.
    const key = randomBytes(32).toString('base64url');

    const rival = integration.dataSource.createQueryRunner();
    try {
      await rival.connect();
      await rival.startTransaction();
      await rival.query('INSERT INTO carts (guest_token) VALUES ($1)', [key]);

      const inFlight = request(integration.app)
        .put(BASE)
        .set('Cookie', `${CSRF_COOKIE}=${csrf}; ${GUEST_COOKIE}=${key}`)
        .set(CSRF_HEADER, csrf)
        .send({ lines: [almonds] })
        .then((response) => response);

      // Waited for, not slept through. If the request were merely slow rather than blocked,
      // committing early would let a check-then-insert read the row as already committed and this
      // test would pass for the wrong reason — the exact failure mode it exists to rule out.
      await waitForABlockedWriter(integration.dataSource);
      await rival.commitTransaction();

      const response = await inFlight;
      expect(response.status).toBe(200);
      expect(expectSuccess<CartResponse>(response).lines).toHaveLength(1);
    } finally {
      if (rival.isTransactionActive) await rival.rollbackTransaction();
      await rival.release();
    }

    // The rival's row, adopted rather than duplicated.
    expect(await countCarts()).toBe('1');
    expect(await countItems()).toBe('1');
  });

  /**
   * A whole-basket `PUT` is last-writer-wins, so overlapping writes must converge on **one** copy of
   * each line. They did not: `replace()` deleted and re-inserted `cart_items` with no lock on the cart,
   * so under READ COMMITTED each transaction deleted on a snapshot in which its rivals' inserts were
   * invisible, and every insert survived. Four concurrent writes of a single ₹299 × 2 line left three
   * copies and a subtotal of ₹1,794 in place of ₹598 — a customer charged three times for one basket.
   *
   * Task 23 measured it 3/3 and deliberately left it unpinned, because pinning a defect freezes it.
   * This is the test for the fix: a `FOR UPDATE` on the cart row inside the transaction, which makes
   * the second writer wait for the first to commit and then delete rows it can actually see.
   */
  it('converges on one copy of a line when whole-basket writes overlap', async () => {
    const { client, csrf } = await guest();
    // Establish the cart first, so every request in the burst takes the same contended path rather
    // than racing to create the row — that race is the previous test's subject, not this one's.
    await client
      .put(BASE)
      .set(CSRF_HEADER, csrf)
      .send({ lines: [almonds] })
      .expect(200);

    const write = (): Promise<unknown> =>
      client
        .put(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ lines: [almonds] });
    const settled = await Promise.all([write(), write(), write(), write()]);

    for (const response of settled) {
      expect((response as { status: number }).status).toBe(200);
    }

    expect(await countCarts()).toBe('1');
    expect(await countItems()).toBe('1');

    // The money is the point. One line of two 250g bags at ₹299 is ₹598, whatever the interleaving.
    const after = await client.get(BASE).expect(200);
    expect(expectSuccess<CartResponse>(after).totals.subtotal).toBe(598);
  });

  describe('the owner exclusivity constraint', () => {
    it('is enforced by the database, not only by the service', async () => {
      // The service always sets exactly one owner. This asserts the constraint would catch a future
      // writer that forgot — which is the reason it exists rather than a comment.
      await expect(
        integration.dataSource.query(
          `INSERT INTO carts (user_id, guest_token) VALUES (NULL, NULL)`,
        ),
      ).rejects.toThrow(/ck_carts_owner_exclusive/);
    });

    /**
     * The other half the migration names: *"a row belonging to nobody and a row belonging to both,
     * and both would be resolved by whichever `WHERE` clause happened to run first."* A row with
     * both owners is the worse of the two — `find({ userId })` and `find({ guestToken })` would each
     * return it, so one customer's basket would answer to a cookie any visitor could hold.
     */
    it('refuses a row that claims both owners', async () => {
      const [user] = await integration.dataSource.query<{ id: string }[]>(
        `SELECT id FROM users WHERE email = 'b2c@demo.in'`,
      );
      await expect(
        integration.dataSource.query(`INSERT INTO carts (user_id, guest_token) VALUES ($1, $2)`, [
          user?.id,
          randomBytes(32).toString('base64url'),
        ]),
      ).rejects.toThrow(/ck_carts_owner_exclusive/);
    });
  });

  describe('POST /cart/validate', () => {
    it('reports availability per line and stays open to guests', async () => {
      const { client, csrf } = await guest();
      const result = expectSuccess<CartValidationResult>(
        await client
          .post(`${BASE}/validate`)
          .set(CSRF_HEADER, csrf)
          .send({ lines: [{ ...almonds, qty: 2 }] })
          .expect(200),
      );

      expect(result.ok).toBe(true);
      // `onHand - reserved` from the seeded opening stock, computed rather than stored.
      expect(result.lines[0]?.availableQty).toBe(120);
      expect(result.lines[0]?.lineTotal).toBe(598);
      expect(result.lines[0]?.code).toBeUndefined();
    });

    /**
     * Spec §10.1: a basket holding more than remains must show the problem *before* checkout. The
     * line is reported, never silently reduced — the customer decides.
     */
    it('reports OUT_OF_STOCK with both figures rather than trimming the line', async () => {
      await setStock(3);
      const { client, csrf } = await guest();

      const result = expectSuccess<CartValidationResult>(
        await client
          .post(`${BASE}/validate`)
          .set(CSRF_HEADER, csrf)
          .send({ lines: [{ ...almonds, qty: 10 }] })
          .expect(200),
      );

      expect(result.ok).toBe(false);
      expect(result.lines[0]).toMatchObject({
        code: 'OUT_OF_STOCK',
        availableQty: 3,
        requestedQty: 10,
      });
    });

    /**
     * The two entry points must not grow separate copies of the rules. Asserted on a basket that has
     * a *problem*, deliberately: on a healthy one both `code`s are `undefined`, and
     * `expect(undefined).toBe(undefined)` would pass with the rules in wild disagreement.
     */
    it('agrees with the stored-cart path for the same basket', async () => {
      const { client, csrf } = await guest();
      await client
        .put(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ lines: [almonds] })
        .expect(200);
      await setStock(1);

      const stored = expectSuccess<CartValidationResult>(
        await client.post(`${BASE}/validate`).set(CSRF_HEADER, csrf).send({}).expect(200),
      );
      const explicit = expectSuccess<CartValidationResult>(
        await client
          .post(`${BASE}/validate`)
          .set(CSRF_HEADER, csrf)
          .send({ lines: [almonds] })
          .expect(200),
      );

      expect(stored.ok).toBe(false);
      expect(stored.lines[0]?.code).toBe('OUT_OF_STOCK');
      // Whole objects, not one field each: the line id is the only name the browser can join a
      // verdict to, and the two paths build it from different inputs.
      expect(explicit.lines).toEqual(stored.lines);
      expect(explicit.totals).toEqual(stored.totals);
    });

    /**
     * `if (dto.lines && dto.lines.length > 0)`, not `if (dto.lines)`. An explicit empty array is a
     * customer who has just emptied the basket locally, and answering `ok: true` about zero lines
     * would be a verdict on a basket nobody holds while the stored one is still full. Written as the
     * shorter condition, this test sees `lines: []` and a subtotal of 0.
     */
    it('validates the stored cart when sent an empty array', async () => {
      const { client, csrf } = await guest();
      // `expectStatus`, not `.expect(200)`: this is the arrange step, and it is the line the
      // intermittent flake in `docs/known-issues.md` item 1 has failed at twice. Supertest's own
      // message carries the two status codes and nothing else, so both captures told us a 400
      // happened and not which rule produced it. This reports the body.
      expectStatus(
        await client
          .put(BASE)
          .set(CSRF_HEADER, csrf)
          .send({ lines: [almonds] }),
        200,
      );

      const result = expectSuccess<CartValidationResult>(
        await client
          .post(`${BASE}/validate`)
          .set(CSRF_HEADER, csrf)
          .send({ lines: [] })
          .expect(200),
      );

      expect(result.lines).toHaveLength(1);
      expect(result.totals.subtotal).toBe(598);
    });

    it('flags a quote-required bulk weight instead of pricing it as free', async () => {
      const { client, csrf } = await guest();
      const result = expectSuccess<CartValidationResult>(
        await client
          .post(`${BASE}/validate`)
          .set(CSRF_HEADER, csrf)
          .send({ lines: [{ slug: ALMONDS, mode: 'bulk', kg: 50, qty: 1 }] })
          .expect(200),
      );

      expect(result.ok).toBe(false);
      expect(result.lines[0]?.code).toBe('QUOTE_REQUIRED');
      expect(result.lines[0]?.lineTotal).toBeNull();
      expect(result.totals.hasQuoteLines).toBe(true);
      // Implied by the above and asserted anyway: `hasQuoteLines` must imply the broader flag, or a
      // basket routed to the business track would still claim its total covered everything.
      expect(result.totals.hasUnpriceableLines).toBe(true);
      expect(result.totals.subtotal).toBe(0);
    });

    /**
     * The regression the two flags were split to prevent, end to end.
     *
     * `hasQuoteLines` routes a basket onto the **business** track: `cart.tsx` offers "Request Quote"
     * on it and `CheckoutForm.tsx` switches to `b2bCheckoutSchema`, which demands a GSTIN. Derived
     * as "some line was left out of the money" it is also true for a sold-out 250g pouch — so a B2C
     * customer with one empty pack was invited to raise a B2B quote and asked for company details.
     * `cart-pricing.service.spec.ts` pins the distinction on the service; nothing pinned it on the
     * wire, which is where the frontend reads it.
     */
    it('keeps a sold-out retail basket off the business track', async () => {
      await setStock(0);
      const { client, csrf } = await guest();

      const result = expectSuccess<CartValidationResult>(
        await client
          .post(`${BASE}/validate`)
          .set(CSRF_HEADER, csrf)
          .send({ lines: [almonds] })
          .expect(200),
      );

      expect(result.lines[0]?.code).toBe('OUT_OF_STOCK');
      expect(result.totals.hasQuoteLines).toBe(false);
      expect(result.totals.hasUnpriceableLines).toBe(true);
    });
  });

  /**
   * An unpublished product is a product the shop does not have.
   *
   * Every catalogue query filters on `isPublished` — `catalog.service.ts`'s `baseQuery` is
   * `WHERE product.isPublished = true` — and none of the cart's did. So a product an admin had pulled
   * mid-season still went into a basket, still priced, and was still on its way to checkout, while its
   * own product page answered 404. `PUT /cart` now refuses it exactly as it refuses a slug the
   * catalogue never held, and `POST /cart/validate` reports it exactly as it reports one.
   *
   * The seeded catalogue publishes all 27 products, so each case withdraws one itself. `unpublish`
   * reads the row back afterwards rather than trusting the `UPDATE`: a mistyped slug would otherwise
   * leave every assertion below testing the published path and passing.
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
     * The refusal, and that it is the *same* refusal. Compared field for field against the
     * unknown-slug case, minus the two fields that are per-request by construction (`errorId`,
     * `requestId`) and the two that name the URL — the slugs differ, so `path` must.
     */
    it('refuses a PUT for an unpublished product exactly as it refuses an unknown slug', async () => {
      await unpublish(ALMONDS);
      const { client, csrf } = await guest();

      const put = (slug: string) =>
        client
          .put(BASE)
          .set(CSRF_HEADER, csrf)
          .send({ lines: [{ ...almonds, slug }] })
          .expect(422);

      const withdrawn = expectError(await put(ALMONDS));
      const unknown = expectError(await put('no-such-product'));

      expect(withdrawn.code).toBe('NOT_FOUND');
      expect({
        statusCode: withdrawn.statusCode,
        code: withdrawn.code,
        message: withdrawn.message,
      }).toEqual({ statusCode: unknown.statusCode, code: unknown.code, message: unknown.message });
      // Refused before the transaction opens, so neither attempt left a cart or a line behind.
      expect(await countCarts()).toBe('0');
      expect(await countItems()).toBe('0');
    });

    /** The positive control: the same PUT against the same product, still published, still stores. */
    it('still stores a line for a published product', async () => {
      const { client, csrf } = await guest();

      const body = expectSuccess<CartResponse>(
        await client
          .put(BASE)
          .set(CSRF_HEADER, csrf)
          .send({ lines: [almonds] })
          .expect(200),
      );

      expect(body.totals.subtotal).toBe(598);
      expect(await countItems()).toBe('1');
    });

    /**
     * `POST /cart/validate` on body lines reports rather than throwing — the route's whole contract —
     * so an unpublished slug arrives as `NOT_FOUND` with no price, not as a 422.
     *
     * `hasQuoteLines` false is asserted deliberately: it routes the basket onto the **business** track
     * in `cart.tsx` and `CheckoutForm.tsx`, and a withdrawn 250g pouch must not ask a B2C customer for
     * a GSTIN.
     */
    it('reports an unpublished slug from the body as NOT_FOUND', async () => {
      await unpublish(ALMONDS);
      const { client, csrf } = await guest();

      const result = expectSuccess<CartValidationResult>(
        await client
          .post(`${BASE}/validate`)
          .set(CSRF_HEADER, csrf)
          .send({ lines: [almonds] })
          .expect(200),
      );

      expect(result.ok).toBe(false);
      expect(result.lines).toEqual([
        {
          id: 'r:premium-california-almonds:250g',
          slug: ALMONDS,
          unavailable: true,
          availableQty: null,
          requestedQty: 2,
          lineTotal: null,
          code: 'NOT_FOUND',
        },
      ]);
      expect(result.totals.subtotal).toBe(0);
      expect(result.totals.hasUnpriceableLines).toBe(true);
      expect(result.totals.hasQuoteLines).toBe(false);
    });

    /**
     * **The decision, end to end.** A line stored while the product was published, and read back after
     * it was withdrawn, reads as *unavailable* — it does not vanish, and the row is not deleted.
     *
     * Three answers have to agree here and they come from three different mechanisms: `GET /cart` and
     * `POST /cart/validate {}` read `isPublished` off the eagerly-loaded `items.product` relation,
     * while `POST /cart/validate { lines }` filters it in SQL. That relation is loaded with no
     * `select`, which is the only reason the flag is present at all — so this test is also the proof
     * of the obligation `toValidatable`'s docblock records: narrow that `relations` clause with a
     * `select` that omits the column and it arrives `undefined`, falsy, and *every* basket in the shop
     * reads `NOT_FOUND`.
     *
     * The row surviving is the point of the choice. The customer keeps a line they can see and remove,
     * the money excludes it, checkout is blocked — and an admin who withdraws a product for a
     * fortnight and republishes it has not silently emptied every basket that held it.
     */
    it('reads a stored line back as unavailable once its product is withdrawn, from all three paths', async () => {
      const { client, csrf } = await guest();
      const stored = expectSuccess<CartResponse>(
        await client
          .put(BASE)
          .set(CSRF_HEADER, csrf)
          .send({ lines: [almonds] })
          .expect(200),
      );
      // A precondition, not the claim: the line was priced while the product was published.
      expect(stored.totals.subtotal).toBe(598);

      await unpublish(ALMONDS);

      const read = expectSuccess<CartResponse>(await client.get(BASE).expect(200));
      // The line is still served, under the id the browser addresses it by, so the verdict below has
      // something on the page to annotate.
      expect(read.lines).toEqual([
        {
          id: 'r:premium-california-almonds:250g',
          slug: ALMONDS,
          mode: 'retail',
          size: '250g',
          grams: 250,
          qty: 2,
        },
      ]);
      expect(read.totals.subtotal).toBe(0);
      expect(read.totals.hasUnpriceableLines).toBe(true);
      expect(read.totals.hasQuoteLines).toBe(false);

      const fromStored = expectSuccess<CartValidationResult>(
        await client.post(`${BASE}/validate`).set(CSRF_HEADER, csrf).send({}).expect(200),
      );
      expect(fromStored.ok).toBe(false);
      expect(fromStored.lines).toEqual([
        {
          id: 'r:premium-california-almonds:250g',
          slug: ALMONDS,
          unavailable: true,
          availableQty: null,
          requestedQty: 2,
          lineTotal: null,
          code: 'NOT_FOUND',
        },
      ]);

      // And the body path answers identically, which is what `POST /cart/validate` cannot afford to
      // get wrong: the cart page annotates lines it read from `GET /cart` with verdicts from here.
      const fromBody = expectSuccess<CartValidationResult>(
        await client
          .post(`${BASE}/validate`)
          .set(CSRF_HEADER, csrf)
          .send({ lines: [almonds] })
          .expect(200),
      );
      expect(fromBody.lines).toEqual(fromStored.lines);
      expect(fromBody.totals).toEqual(fromStored.totals);

      // Read back as unavailable, not deleted. The customer's row is still theirs.
      expect(await countItems()).toBe('1');
    });

    /**
     * And the basket stays modifiable. A customer holding a withdrawn line must be able to save the
     * basket without it — otherwise the 422 from `PUT /cart` would make the line permanent, since the
     * client echoes the whole basket on every write and the withdrawn slug would fail every one.
     */
    it('lets the customer save the basket with the withdrawn line removed', async () => {
      const { client, csrf } = await guest();
      await client
        .put(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ lines: [almonds, { slug: 'w320-cashews', mode: 'retail', size: '250g', qty: 1 }] })
        .expect(200);
      await unpublish(ALMONDS);

      const body = expectSuccess<CartResponse>(
        await client
          .put(BASE)
          .set(CSRF_HEADER, csrf)
          .send({ lines: [{ slug: 'w320-cashews', mode: 'retail', size: '250g', qty: 1 }] })
          .expect(200),
      );

      expect(body.lines.map((line) => line.slug)).toEqual(['w320-cashews']);
      expect(body.totals.hasUnpriceableLines).toBe(false);
      expect(await countItems()).toBe('1');
    });
  });

  describe('PUT /cart validation', () => {
    it('rejects a line for a product that does not exist', async () => {
      const { client, csrf } = await guest();
      const response = await client
        .put(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ lines: [{ slug: 'no-such-product', mode: 'retail', size: '250g', qty: 1 }] })
        .expect(422);

      expect(expectError(response).code).toBe('NOT_FOUND');
      // Refused rather than half-stored: a `PUT` is the whole basket, so a rejected request must
      // leave no cart behind at all.
      expect(await countCarts()).toBe('0');
    });

    /**
     * A mode's own field is required, not merely allowed. Without `@ValidateIf` a bulk line with no
     * weight is stored and then reports `BELOW_MOQ` on every validate — `verdictFor` reads
     * `Number(line.kg ?? 0)` and `0 < moqKg` is always true — a line the customer cannot check out
     * with and can only fix by deleting, for a field they never knew they had to send. A missing
     * `size` is not symmetric but is just as wrong: it falls through to `variants.find(...
     * candidate.size === undefined ...)`, which matches nothing and raises *"That pack size is no
     * longer available"*, a stock message for a malformed request.
     *
     * Asserted on the `details` **keys**, not on a substring of the whole envelope: the contract is
     * "keyed by field path", and `JSON.stringify(details).toContain('kg')` would also pass on a
     * message that merely mentioned the word.
     */
    it('rejects a bulk line with no weight and a retail line with no size', async () => {
      const { client, csrf } = await guest();

      const noKg = await client
        .put(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ lines: [{ slug: ALMONDS, mode: 'bulk', qty: 1 }] })
        .expect(400);
      expect(Object.keys(expectError(noKg).details ?? {})).toContain('lines.0.kg');

      const noSize = await client
        .put(BASE)
        .set(CSRF_HEADER, csrf)
        .send({ lines: [{ slug: ALMONDS, mode: 'retail', qty: 1 }] })
        .expect(400);
      expect(Object.keys(expectError(noSize).details ?? {})).toContain('lines.0.size');
    });

    it('rejects a basket larger than the cap rather than accepting an unbounded transaction', async () => {
      const { client, csrf } = await guest();
      const lines = Array.from({ length: 51 }, () => almonds);
      await client.put(BASE).set(CSRF_HEADER, csrf).send({ lines }).expect(400);
    });
  });

  /**
   * **`PATCH /admin/inventory/:variantId` is deliberately not covered here.** Task 22 ships its own
   * `backend/test/integration/inventory.integration.spec.ts` with 18 cases across authorization, a
   * well-formed adjustment, the reserved floor and DTO validation — because three of that endpoint's
   * claims are unreachable from a test double and Task 23's spec does not exist when Task 22 runs.
   *
   * An earlier version of this task carried three cases (a customer refused, an adjustment writing
   * its ledger row, an adjustment breaching the floor) which are now a strict subset of that file.
   * Two suites asserting the same behaviour is how they come to disagree, and the one nobody edits
   * is the one that goes stale. Leave them there.
   */
});
