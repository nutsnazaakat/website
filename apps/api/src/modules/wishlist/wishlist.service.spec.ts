import { HttpStatus } from '@nestjs/common';
import type { Product as WireProduct } from '@nutwala/shared';
import type { DomainError } from '../../common/errors/domain-error';
import type { CatalogService } from '../catalog/catalog.service';
import { MERGE_WISHLIST_SQL, WishlistService } from './wishlist.service';

const GUEST_KEY = '0_dHX8IZEAuUg0j-XwTEv4Ud_mvJhJpOXO1BOW9b_Ag';

/** Collapses the SQL's indentation so an assertion reads as one line. */
const oneLine = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('WishlistService owner scoping', () => {
  /**
   * The whole risk in this service is an unscoped query. `ownerWhere` throwing rather than returning
   * `{}` is what stops `list()` returning every wishlist in the database and `remove()` deleting
   * everyone's saved items — both of which an empty `where` object does silently in TypeORM.
   */
  it('refuses to build a query with no owner', async () => {
    const service = new WishlistService({} as never, {} as never, {} as never, {} as never);
    await expect(service.list({}, undefined)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to list slugs with no owner either', async () => {
    const service = new WishlistService({} as never, {} as never, {} as never, {} as never);
    await expect(service.slugs({})).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  /**
   * `remove` is the half of that claim the docstring above cannot make good on by itself, and it
   * needs its own test for a reason worth recording.
   *
   * TypeORM 0.3.31 *does* reject an empty object criterion for `delete` —
   * `normalizeAndValidateWhereCriteria` in `EntityManager.js` throws "Empty criteria(s) are not
   * allowed for the delete method" for anything that would render as `WHERE 1=1`. But the criterion
   * here is never empty: it is `{ ...ownerWhere(owner), productId }`, so an `ownerWhere` that
   * returned `{}` would leave a perfectly valid `{ productId }` — and delete that product from every
   * wishlist in the database, for every customer, with no error anywhere. The guard does not fire,
   * and `list()`'s test above cannot see it.
   */
  it('scopes the delete to the owner as well as the product', async () => {
    const items = { delete: jest.fn().mockResolvedValue({ affected: 1 }) };
    const products = { findOne: jest.fn().mockResolvedValue({ id: 'product-1' }) };
    const service = new WishlistService(
      items as never,
      products as never,
      {} as never,
      {} as never,
    );

    await service.remove({ userId: 'user-1' }, 'kashmiri-almonds');

    expect(items.delete).toHaveBeenCalledWith({ userId: 'user-1', productId: 'product-1' });
  });

  it('refuses to delete for a visitor with no owner, before reaching the table', async () => {
    const items = { delete: jest.fn() };
    const products = { findOne: jest.fn().mockResolvedValue({ id: 'product-1' }) };
    const service = new WishlistService(
      items as never,
      products as never,
      {} as never,
      {} as never,
    );

    await expect(service.remove({}, 'kashmiri-almonds')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(items.delete).not.toHaveBeenCalled();
  });

  /**
   * Unsaving something that is not stocked any more is a no-op, not a 404 — the customer's intent is
   * satisfied either way. Pinned because the obvious symmetry with `add()`, which *does* 404, is the
   * likely "tidy-up", and it would make the heart error on exactly the products a customer most wants
   * to clear out of a stale list.
   */
  it('treats unsaving an unknown product as a no-op rather than a 404', async () => {
    const items = { delete: jest.fn() };
    const products = { findOne: jest.fn().mockResolvedValue(null) };
    const service = new WishlistService(
      items as never,
      products as never,
      {} as never,
      {} as never,
    );

    await expect(service.remove({ userId: 'user-1' }, 'never-stocked')).resolves.toBeUndefined();
    expect(items.delete).not.toHaveBeenCalled();
  });
});

describe('WishlistService.list', () => {
  const wireProduct = (slug: string) => ({ slug }) as unknown as WireProduct;

  function harness(savedSlugs: string[], published: string[]) {
    const items = {
      find: jest
        .fn()
        .mockResolvedValue(
          savedSlugs.map((slug, index) => ({ id: `w${index}`, product: { slug } })),
        ),
    };
    const catalog = {
      // Returned in the catalogue's own order, which is not the wishlist's — the point of the test.
      productsBySlugs: jest.fn().mockResolvedValue([...published].sort().map(wireProduct)),
    };
    return {
      service: new WishlistService(
        items as never,
        {} as never,
        catalog as unknown as CatalogService,
        {} as never,
      ),
      catalog,
    };
  }

  /**
   * "Newest saved first" is the wishlist's order, and the catalogue query does not preserve it —
   * `productsBySlugs` is a `slug IN (...)` with the catalogue's own `ORDER BY`. Re-projecting through
   * the row order is what keeps the promise, and dropping that step still returns the right *set*, so
   * only an order assertion can see it.
   */
  it('keeps the wishlist order rather than the catalogue query order', async () => {
    const { service } = harness(
      ['zaffron-strands', 'anjeer', 'medjoul-dates'],
      ['zaffron-strands', 'anjeer', 'medjoul-dates'],
    );

    await expect(service.list({ userId: 'user-1' }, undefined)).resolves.toEqual([
      { slug: 'zaffron-strands' },
      { slug: 'anjeer' },
      { slug: 'medjoul-dates' },
    ]);
  });

  /**
   * A saved product that has since been unpublished is dropped, not carried through as a hole.
   *
   * `productsBySlugs` only returns published rows, so the lookup misses and the map yields
   * `undefined`. Without the `filter`, that `undefined` survives into the array, `JSON.stringify`
   * turns it into `null`, and the wishlist page renders a `ProductCard` for nothing.
   *
   * `toStrictEqual`, and that is the whole test. `toEqual` recursively ignores `undefined` — including
   * `undefined` *array elements* — so `[{ slug: 'anjeer' }, undefined]` satisfies
   * `toEqual([{ slug: 'anjeer' }])`. Written with `toEqual` this case passed identically with the
   * filter deleted: measured, not assumed.
   */
  it('drops a saved product the catalogue no longer publishes', async () => {
    const { service } = harness(['anjeer', 'withdrawn-line'], ['anjeer']);

    await expect(service.list({ userId: 'user-1' }, undefined)).resolves.toStrictEqual([
      { slug: 'anjeer' },
    ]);
  });

  it('does not ask the catalogue anything for an empty wishlist', async () => {
    const { service, catalog } = harness([], []);

    await expect(service.list({ userId: 'user-1' }, undefined)).resolves.toEqual([]);
    expect(catalog.productsBySlugs).not.toHaveBeenCalled();
  });
});

describe('WishlistService.mergeInto', () => {
  function harness() {
    // Typed, so `mock.calls` is a real tuple rather than `any[]` — the assertions below read the SQL
    // and the parameters straight out of it.
    const query = jest.fn<Promise<unknown[]>, [string, unknown[]]>().mockResolvedValue([]);
    const del = jest.fn().mockResolvedValue({ affected: 2 });
    const manager = { query, getRepository: () => ({ delete: del }) };
    const dataSource = {
      transaction: (run: (m: typeof manager) => Promise<void>) => run(manager),
    };
    return {
      service: new WishlistService({} as never, {} as never, {} as never, dataSource as never),
      query,
      del,
    };
  }

  /**
   * The one line in this task that fails **silently and catastrophically** if simplified, so it is
   * asserted as text.
   *
   * `uq_wishlist_items_user_product` is a *partial* unique index, and Postgres infers a partial index
   * for `ON CONFLICT` only when the predicate is restated. Dropping `WHERE user_id IS NOT NULL` makes
   * the statement raise "there is no unique or exclusion constraint matching the ON CONFLICT
   * specification" — and `auth.controller.ts` swallows that by design, so sign-in still answers 200
   * while the customer's saved list is gone. There is no failing request to notice.
   *
   * A repository double cannot prove the Postgres behaviour; Task 29's integration merge tests are
   * what do that. What this pins is the thing a reviewer would delete: the predicate itself, and that
   * `mergeInto` still routes through it.
   */
  it('restates the partial-index predicate on the conflict target', async () => {
    const { service, query } = harness();

    await service.mergeInto('user-1', GUEST_KEY);

    const [sql, params] = query.mock.calls.at(0) ?? [];
    expect(oneLine(sql ?? '')).toContain(
      'ON CONFLICT (user_id, product_id) WHERE user_id IS NOT NULL DO NOTHING',
    );
    expect(params).toEqual(['user-1', GUEST_KEY]);
    expect(oneLine(MERGE_WISHLIST_SQL)).toContain(
      'INSERT INTO wishlist_items (user_id, product_id)',
    );
  });

  /**
   * The guest rows are deleted in the **same** transaction as the insert. That is what makes a
   * retried merge harmless — the second attempt finds nothing to fold — and what stops the same saved
   * items existing under two owners at once.
   */
  it('deletes the guest rows in the same transaction, keyed by the token', async () => {
    const { service, del } = harness();

    await service.mergeInto('user-1', GUEST_KEY);

    expect(del).toHaveBeenCalledWith({ guestToken: GUEST_KEY });
  });
});

/**
 * A products table and a wishlist table that honour the criteria they are sent, publication
 * included.
 *
 * `WishlistService.list`'s harness above returns a fixed answer whatever it is asked, which is right
 * for the ordering claims and useless here: an answer that ignores the `where` is the same answer
 * with a publication filter and without one, so a test built on it would pass either way. These
 * doubles match each criterion key by key — descending into a nested one, which is how a relation
 * condition reaches TypeORM — and throw on a criterion they do not recognise, the shape
 * `cart.service.spec.ts`'s `fakeCatalogue` and `fakeCartStore` both take.
 */
function fakePublishedCatalogue(
  products: { slug: string; isPublished: boolean }[],
  saved: string[] = [],
) {
  const productRows = products.map((product, index) => ({
    id: `product-${index + 1}`,
    slug: product.slug,
    isPublished: product.isPublished,
  }));

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, expected]) => {
      if (!(key in row)) throw new Error(`fakePublishedCatalogue: unsupported criterion "${key}"`);
      const actual = row[key];
      if (expected !== null && typeof expected === 'object') {
        return matches(
          (actual ?? {}) as Record<string, unknown>,
          expected as Record<string, unknown>,
        );
      }
      return actual === expected;
    });

  // Newest first, which is the order `slugs()` asks the database for and this double has to hand
  // back — otherwise a reordering bug would read as a passing test.
  const itemRows = [...saved].reverse().map((slug, index) => ({
    id: `wishlist-${index + 1}`,
    userId: 'user-1',
    guestToken: null,
    product: productRows.find((product) => product.slug === slug),
  }));

  const items = {
    find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(itemRows.filter((row) => matches(row, where))),
    ),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(() => {
      const values: Record<string, unknown>[] = [];
      const builder = {
        insert: () => builder,
        values: (next: Record<string, unknown>) => {
          values.push(next);
          inserted.push(next);
          return builder;
        },
        orIgnore: () => builder,
        execute: () => Promise.resolve({ identifiers: [] }),
      };
      return builder;
    }),
  };
  const inserted: Record<string, unknown>[] = [];

  const productsRepository = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(productRows.find((row) => matches(row, where)) ?? null),
    ),
  };

  return {
    service: new WishlistService(
      items as never,
      productsRepository as never,
      {} as never,
      {} as never,
    ),
    items,
    products: productsRepository,
    inserted,
  };
}

describe('WishlistService and unpublished products', () => {
  const ALMONDS = 'kashmiri-almonds';
  const WITHDRAWN = 'withdrawn-line';

  /**
   * The oracle this task closed, stated as the thing it was.
   *
   * `POST /wishlist/:slug` answered **200** for an unpublished slug and **404** for one no product
   * has, while every catalogue route answered 404 for both — so a client could enumerate slugs and
   * learn which unreleased products exist from the status code alone. It must answer identically, and
   * the comparison here is of the whole refusal rather than of the code, because a different status
   * or message leaks the same bit.
   */
  it('refuses to save an unpublished product exactly as it refuses an unknown slug', async () => {
    const withdrawn = fakePublishedCatalogue([{ slug: WITHDRAWN, isPublished: false }]);
    const absent = fakePublishedCatalogue([]);

    const refuse = async (harness: { service: WishlistService }) => {
      const thrown = await harness.service.add({ userId: 'user-1' }, WITHDRAWN).then(
        () => {
          throw new Error('expected a refusal; the product was saved instead');
        },
        (error: unknown) => error,
      );
      const error = thrown as DomainError;
      return { code: error.code, status: error.getStatus(), body: error.getResponse() };
    };

    const unpublished = await refuse(withdrawn);
    expect(unpublished).toEqual(await refuse(absent));
    expect(unpublished).toEqual({
      code: 'NOT_FOUND',
      status: HttpStatus.NOT_FOUND,
      body: {
        code: 'NOT_FOUND',
        message: 'That product may have been renamed or is no longer stocked.',
        details: undefined,
      },
    });
    // And nothing was written. A route that threw *after* inserting would satisfy the above.
    expect(withdrawn.inserted).toEqual([]);
  });

  /**
   * The positive control, and the reason it is here rather than assumed: the tempting way to write
   * this filter is an `isPublished` test against the narrowed `select: { id: true }` that `add()`
   * already uses, and a column left out of a `select` comes back `undefined`. `undefined` is falsy,
   * so that version refuses **every** product in the shop — a heart that 404s on everything — and the
   * test above passes under it unchanged.
   */
  it('still saves a published product', async () => {
    const harness = fakePublishedCatalogue([{ slug: ALMONDS, isPublished: true }]);

    await expect(harness.service.add({ userId: 'user-1' }, ALMONDS)).resolves.toBeUndefined();

    expect(harness.inserted).toEqual([
      { userId: 'user-1', guestToken: null, productId: 'product-1' },
    ]);
  });

  /**
   * `slugs()` and `list()` have to agree, and they did not: `list()` goes through
   * `CatalogService.productsBySlugs`, whose `baseQuery` is `WHERE product.isPublished = true`, so it
   * already dropped an unpublished save — while `slugs()` kept it. The visible consequence was a
   * heart rendered filled, on every listing page, for a product the wishlist page then refused to
   * show.
   */
  it('leaves a since-unpublished save out of the slugs the heart reads', async () => {
    const harness = fakePublishedCatalogue(
      [
        { slug: ALMONDS, isPublished: true },
        { slug: WITHDRAWN, isPublished: false },
      ],
      [ALMONDS, WITHDRAWN],
    );

    await expect(harness.service.slugs({ userId: 'user-1' })).resolves.toEqual([ALMONDS]);
  });

  /**
   * The other polarity of the same claim, and the one that fails if the filter is written as a
   * blanket exclusion: every published save is still returned, newest first.
   */
  it('still returns every published save, newest first', async () => {
    const harness = fakePublishedCatalogue(
      [
        { slug: ALMONDS, isPublished: true },
        { slug: 'medjoul-dates', isPublished: true },
      ],
      [ALMONDS, 'medjoul-dates'],
    );

    await expect(harness.service.slugs({ userId: 'user-1' })).resolves.toEqual([
      'medjoul-dates',
      ALMONDS,
    ]);
  });

  /**
   * `remove()` is deliberately **not** filtered, and this pins that rather than leaving it to be
   * "tidied up" into symmetry with `add()`.
   *
   * A row saved before the product was withdrawn is still the customer's row. Filtering here would
   * make it undeletable — and since `slugs()` no longer lists it, the customer could not even see
   * what they were failing to remove. Leaving it removable also costs nothing in oracle terms: this
   * route answers with the saved slugs either way, so an unpublished slug and an absent one are
   * indistinguishable from outside.
   */
  it('still removes a save whose product has since been unpublished', async () => {
    const harness = fakePublishedCatalogue([{ slug: WITHDRAWN, isPublished: false }], [WITHDRAWN]);

    await harness.service.remove({ userId: 'user-1' }, WITHDRAWN);

    expect(harness.items.delete).toHaveBeenCalledWith({
      userId: 'user-1',
      productId: 'product-1',
    });
  });
});
