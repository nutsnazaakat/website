import { HttpStatus } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain-error';
import { Cart } from '../../entities/commerce/cart.entity';
import { OrderChannelEnum } from '../../entities/enums';
import { MAX_LINE_QTY } from './cart.constants';
import { CartService, mergeLines } from './cart.service';

const line = (
  productId: string,
  variantId: string | null,
  mode: 'RETAIL' | 'BULK',
  qty: number,
  kg: string | null = null,
) => ({ productId, variantId, mode, qty, kg });

describe('mergeLines', () => {
  it('keeps lines that exist on only one side', () => {
    const merged = mergeLines([line('p1', 'v1', 'RETAIL', 1)], [line('p2', 'v2', 'RETAIL', 2)]);
    expect(merged).toHaveLength(2);
  });

  /**
   * `productId` is part of the line's identity in its own right.
   *
   * Isolated deliberately, because the case above does not isolate it: it varies the product *and*
   * the variant, so dropping `productId` from the key leaves it green — measured, along with the
   * other seven. Bulk lines carry no variant at all, so on a bulk basket `productId` is the only
   * thing separating two lines, and folding them would drop one product out of the basket entirely
   * while doubling the other.
   */
  it('keeps two products apart when nothing but the product differs', () => {
    const merged = mergeLines(
      [line('p1', null, 'BULK', 1, '25.00')],
      [line('p2', null, 'BULK', 1, '25.00')],
    );
    expect(merged).toHaveLength(2);
  });

  /**
   * Summing is what a customer expects: they put two bags in as a guest, one more after signing in,
   * and want three. Taking the maximum would silently discard the earlier intent.
   *
   * Double-counting on a repeated merge is not a risk, because `mergeInto` deletes the guest cart in
   * the same transaction — so there is never a second merge of the same rows.
   */
  it('sums the quantity when the same line exists on both sides', () => {
    const merged = mergeLines([line('p1', 'v1', 'RETAIL', 2)], [line('p1', 'v1', 'RETAIL', 1)]);
    expect(merged).toEqual([expect.objectContaining({ productId: 'p1', qty: 3 })]);
  });

  it('treats two sizes of the same product as different lines', () => {
    const merged = mergeLines(
      [line('p1', 'v-250g', 'RETAIL', 1)],
      [line('p1', 'v-1kg', 'RETAIL', 1)],
    );
    expect(merged).toHaveLength(2);
  });

  it('treats the same product in retail and bulk as different lines', () => {
    const merged = mergeLines(
      [line('p1', 'v1', 'RETAIL', 1)],
      [line('p1', null, 'BULK', 1, '25.00')],
    );
    expect(merged).toHaveLength(2);
  });

  /**
   * So is `mode`, and the case above does not isolate it either: it varies the variant and the
   * weight as well, so dropping `mode` from the key leaves all eight of the task's tests green —
   * measured.
   *
   * Today's rows make `mode` redundant, which is precisely why nothing caught its removal: a retail
   * line always resolves a variant and a bulk line always carries a weight, so one of the other two
   * components already differs. That is an incidental property of `resolveLines`, not the contract
   * `lineKey` documents, and this pins the contract.
   */
  it('keeps retail and bulk apart when nothing but the mode differs', () => {
    const merged = mergeLines([line('p1', null, 'RETAIL', 1)], [line('p1', null, 'BULK', 1)]);
    expect(merged).toHaveLength(2);
  });

  /**
   * Two bulk lines for the same product at different weights are different lines — 10kg and 25kg are
   * priced from different tiers, so folding them together would misprice the basket.
   */
  it('treats bulk lines of different weights as different lines', () => {
    const merged = mergeLines(
      [line('p1', null, 'BULK', 1, '10.00')],
      [line('p1', null, 'BULK', 1, '25.00')],
    );
    expect(merged).toHaveLength(2);
  });

  it('folds bulk lines of the same weight together', () => {
    const merged = mergeLines(
      [line('p1', null, 'BULK', 1, '25.00')],
      [line('p1', null, 'BULK', 2, '25.00')],
    );
    expect(merged).toEqual([expect.objectContaining({ qty: 3 })]);
  });

  it('is a no-op when the guest side is empty', () => {
    const existing = [line('p1', 'v1', 'RETAIL', 2)];
    expect(mergeLines(existing, [])).toEqual(existing);
  });

  /**
   * The sum must not exceed what `CartLineDto` accepts.
   *
   * `mergeInto` inserts straight into `cart_items`, bypassing the DTO, so an unclamped sum stores a
   * quantity the API will not accept back. The client reads the basket and echoes it to `PUT /cart`,
   * which then fails with `qty must not be greater than 999` — for every write, forever, including
   * removing the offending line. The basket becomes read-only at the moment the customer is paying.
   */
  it('never sums past the quantity the API accepts', () => {
    const merged = mergeLines(
      [line('p1', 'v1', 'RETAIL', MAX_LINE_QTY)],
      [line('p1', 'v1', 'RETAIL', MAX_LINE_QTY)],
    );
    expect(merged).toEqual([expect.objectContaining({ qty: MAX_LINE_QTY })]);
  });

  /**
   * The cap applies to a line that arrives from the guest side alone, not only to a sum.
   *
   * Measured: dropping that second `Math.min` leaves every test above green, because none of them
   * carries an over-cap quantity on one side only.
   *
   * Note the asymmetry this pins, which is the implementation's and not this test's: a line present
   * only in `existing` is copied through unclamped. Nothing reachable writes such a row today —
   * `replace` goes through `CartLineDto` and this function never emits above the cap — so the two
   * branches are equally defensive, but they do not agree, and only one of them is honest about the
   * "output always honours the DTO bound" claim in `mergeLines`' docblock.
   */
  it('clamps a guest-only line that is already over the cap', () => {
    const merged = mergeLines([], [line('p1', 'v1', 'RETAIL', MAX_LINE_QTY + 1)]);
    expect(merged).toEqual([expect.objectContaining({ qty: MAX_LINE_QTY })]);
  });
});

/**
 * A cart store that enforces `uq_carts_user` the way Postgres does.
 *
 * Honest about the one thing this test is for: a plain `INSERT` for an owner that already has a row
 * *throws*, and only `ON CONFLICT DO NOTHING` makes it a no-op. A double that accepted the duplicate
 * would make the test below vacuous — the same trap `sessions.service.spec.ts` records having shipped
 * a real regression through.
 *
 * Deliberately shallow everywhere else: relations are ignored (`items` is always attached), and only
 * the criteria `CartService` actually passes are honoured. An unrecognised criterion throws rather
 * than quietly matching every row.
 */
function fakeCartStore(
  catalogue: { products: unknown; variants: unknown } = {
    products: {},
    variants: {},
  },
) {
  interface Row {
    id: string;
    userId: string | null;
    guestToken: string | null;
  }
  interface ItemRow {
    cartId: string;
    productId: string;
    variantId: string | null;
    mode: OrderChannelEnum;
    kg: string | null;
    qty: number;
  }

  const carts: Row[] = [];
  const items: ItemRow[] = [];
  const insertedValues: Record<string, unknown>[] = [];
  let nextId = 0;

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, expected]) => {
      if (!(key in row)) throw new Error(`fakeCartStore: unsupported criterion "${key}"`);
      return row[key] === expected;
    });

  const cartRepository = {
    createQueryBuilder: () => {
      let values: Record<string, unknown> = {};
      let ignoreConflicts = false;
      const builder = {
        insert: () => builder,
        values: (next: Record<string, unknown>) => {
          values = next;
          return builder;
        },
        orIgnore: () => {
          ignoreConflicts = true;
          return builder;
        },
        execute: () => {
          insertedValues.push(values);
          const clash = carts.some(
            (row) =>
              (values.userId !== null && row.userId === values.userId) ||
              (values.guestToken !== null && row.guestToken === values.guestToken),
          );
          if (clash) {
            if (ignoreConflicts) return Promise.resolve({ identifiers: [] });
            return Promise.reject(
              new Error('duplicate key value violates unique constraint "uq_carts_user"'),
            );
          }
          carts.push({
            id: `cart-${++nextId}`,
            userId: (values.userId ?? null) as string | null,
            guestToken: (values.guestToken ?? null) as string | null,
          });
          return Promise.resolve({ identifiers: [] });
        },
      };
      return builder;
    },
    findOne: ({ where }: { where: Record<string, unknown> }) => {
      const row = carts.find((candidate) => matches({ ...candidate }, where));
      return Promise.resolve(
        row ? { ...row, items: items.filter((item) => item.cartId === row.id) } : null,
      );
    },
    delete: ({ id }: { id: string }) => {
      const at = carts.findIndex((row) => row.id === id);
      if (at >= 0) carts.splice(at, 1);
      // Postgres cascades cart_items on cart delete; the double has to as well, or the "a repeated
      // merge cannot double the quantity" reasoning would be untestable here.
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (items[i]?.cartId === id) items.splice(i, 1);
      }
      return Promise.resolve({ affected: at >= 0 ? 1 : 0 });
    },
    update: () => Promise.resolve({ affected: 1 }),
  };

  const itemRepository = {
    find: ({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(items.filter((item) => matches({ ...item }, where))),
    delete: ({ cartId }: { cartId: string }) => {
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (items[i]?.cartId === cartId) items.splice(i, 1);
      }
      return Promise.resolve({ affected: 1 });
    },
    insert: (rows: ItemRow[]) => {
      items.push(...rows);
      return Promise.resolve({ identifiers: [] });
    },
  };

  /**
   * `query` records the row-lock `replace` and `mergeInto` take before their delete-and-reinsert pair.
   *
   * A double cannot honour a lock, so this only proves the call is made and against which cart. What it
   * actually protects against is a `FOR UPDATE` being dropped as apparently redundant — the defect it
   * fixes was four concurrent whole-basket writes leaving three copies of one line and a subtotal of
   * ₹1,794 in place of ₹598. The behaviour is pinned in `cart.integration.spec.ts` against real
   * Postgres, which is the only place it can be.
   */
  const locks: string[] = [];
  const manager = {
    getRepository: (entity: unknown) => (entity === Cart ? cartRepository : itemRepository),
    query: (sql: string, parameters?: unknown[]) => {
      if (/FOR UPDATE/i.test(sql)) locks.push(String(parameters?.[0]));
      return Promise.resolve([]);
    },
  };

  const dataSource = {
    transaction: <T>(run: (manager: unknown) => Promise<T>) => run(manager),
  };

  const seedCart = (owner: { userId?: string; guestToken?: string }) => {
    const row: Row = {
      id: `cart-${++nextId}`,
      userId: owner.userId ?? null,
      guestToken: owner.guestToken ?? null,
    };
    carts.push(row);
    return row;
  };

  const seedItem = (cartId: string, item: Omit<ItemRow, 'cartId'>) => {
    items.push({ cartId, ...item });
  };

  const service = new CartService(
    cartRepository as never,
    catalogue.products as never,
    catalogue.variants as never,
    dataSource as never,
  );

  return { service, carts, items, insertedValues, seedCart, seedItem, locks };
}

const retailItem = (productId: string, variantId: string, qty: number) => ({
  productId,
  variantId,
  mode: OrderChannelEnum.RETAIL,
  kg: null,
  qty,
});

describe('CartService.mergeInto', () => {
  /**
   * `upsertCart` inserts unconditionally and relies on `ON CONFLICT DO NOTHING` to absorb the row it
   * finds already there. Removing `.orIgnore()` is not merely a lost race — it breaks the *ordinary*
   * path, because a returning customer always already has a cart row, so the insert always conflicts.
   *
   * Measured: with `.orIgnore()` deleted the task's eight `mergeLines` tests stay green, and nothing
   * in Task 23's integration spec exercises it either. This is the pin.
   *
   * Be clear about what it does **not** prove. It pins the code shape, not the concurrency claim in
   * `upsertCart`'s docblock: a single-threaded double cannot distinguish insert-or-ignore from
   * `findOne`-then-`save`, since the latter also passes here. Only two genuinely concurrent writes
   * against Postgres can — and one now does: `cart.integration.spec.ts` holds a rival transaction open
   * on the same `guest_token` and waits, via `pg_stat_activity`, until a connection is genuinely blocked
   * on a lock before letting it commit. `Promise.all` of identical requests was tried first and was not
   * reliable: against a `findOne`-then-`save` mutant it caught the defect 3/3 cold and missed it 2/2
   * warm, because each request finished before the next one's insert was dispatched.
   */
  /**
   * The row lock that makes `replace` and `mergeInto`'s delete-and-reinsert pair safe.
   *
   * A double cannot honour a lock, so this asserts only that one is taken and that it names the cart
   * being rewritten rather than some other row — enough to stop a future reader deleting the
   * `FOR UPDATE` as redundant. Without it, four concurrent whole-basket writes left three copies of one
   * line and a subtotal of ₹1,794 in place of ₹598, measured against real Postgres; that is where the
   * behaviour is pinned.
   */
  it('locks the cart it is about to rewrite', async () => {
    const store = fakeCartStore();
    const userCart = store.seedCart({ userId: 'u1' });
    store.seedCart({ guestToken: 'g1' });

    await store.service.mergeInto('u1', 'g1');

    expect(store.locks).toContain(userCart.id);
  });

  it('folds into an account that already has a cart without tripping the unique index', async () => {
    const store = fakeCartStore();
    const userCart = store.seedCart({ userId: 'u1' });
    const guestCart = store.seedCart({ guestToken: 'g1' });
    store.seedItem(userCart.id, retailItem('p1', 'v1', 2));
    store.seedItem(guestCart.id, retailItem('p1', 'v1', 1));

    const merged = await store.service.mergeInto('u1', 'g1');

    expect(merged.id).toBe(userCart.id);
    expect(store.items).toEqual([expect.objectContaining({ cartId: userCart.id, qty: 3 })]);
    // `ck_carts_owner_exclusive` allows exactly one owner, so the unset side goes in as an explicit
    // null rather than being omitted.
    expect(store.insertedValues).toEqual([{ userId: 'u1', guestToken: null }]);
  });
});

/**
 * A catalogue that honours the criteria `resolveLines` sends it, `isPublished` included.
 *
 * Honest about the one thing the tests below are for. A double that ignored the `where` and answered
 * with every row it holds would pass whether or not the service filters on publication — so each
 * criterion is matched key by key, and an unrecognised one throws rather than quietly matching
 * everything. `fakeCartStore` takes the same line, for the same reason.
 *
 * The empty-`where` branch reproduces TypeORM's own behaviour rather than the intuitive one:
 * `find({ where: [] })` returns **every** row, which is exactly what `resolveLines`' variant guard
 * exists to avoid. A double that answered `[]` there would make that guard look pointless.
 */
function fakeCatalogue(products: { slug: string; isPublished: boolean }[]) {
  const productRows = products.map((product, index) => ({
    id: `product-${index + 1}`,
    slug: product.slug,
    isPublished: product.isPublished,
  }));
  const variantRows = productRows.map((product) => ({
    id: `variant-${product.id}`,
    productId: product.id,
    size: '250g',
    isActive: true,
  }));

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, expected]) => {
      if (!(key in row)) throw new Error(`fakeCatalogue: unsupported criterion "${key}"`);
      return row[key] === expected;
    });

  const find = <T extends Record<string, unknown>>(table: T[]) =>
    jest.fn(({ where }: { where: Record<string, unknown>[] }) =>
      Promise.resolve(
        where.length === 0
          ? table
          : table.filter((row) => where.some((criterion) => matches(row, criterion))),
      ),
    );

  return { products: { find: find(productRows) }, variants: { find: find(variantRows) } };
}

const retailLine = (slug: string) => ({
  lines: [{ slug, mode: 'retail' as const, size: '250g', qty: 2 }],
});

/** The refusal a caller can compare, with the stack and the class left out of the comparison. */
async function refusal(attempt: Promise<unknown>) {
  const thrown = await attempt.then(
    () => {
      throw new Error('expected a refusal; the basket was stored instead');
    },
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(DomainError);
  const error = thrown as DomainError;
  return { code: error.code, status: error.getStatus(), body: error.getResponse() };
}

describe('CartService.replace against the catalogue', () => {
  /**
   * An unpublished product is refused, and refused **identically** to a slug the catalogue has never
   * held — which is the whole claim. The catalogue treats an unpublished product as if it does not
   * exist (`catalog.service.ts`'s `baseQuery` is `WHERE product.isPublished = true`), and a basket
   * that could store one would be a basket that prices a product with no product page, no listing and
   * no reviews.
   *
   * Both halves are asked about the *same* slug, from two catalogues — one holding it unpublished, one
   * not holding it at all — so the two errors are comparable field for field. Comparing whole
   * refusals rather than just the code is what stops a fourth behaviour appearing here: a different
   * status, or a different `details` payload, would still have the right `code` and would still leak
   * the difference to a client.
   */
  it('refuses an unpublished product exactly as it refuses an unknown slug', async () => {
    const withdrawn = fakeCartStore(fakeCatalogue([{ slug: 'anjeer', isPublished: false }]));
    const absent = fakeCartStore(fakeCatalogue([]));

    const unpublished = await refusal(
      withdrawn.service.replace({ guestToken: 'g1' }, retailLine('anjeer')),
    );

    expect(unpublished).toEqual(
      await refusal(absent.service.replace({ guestToken: 'g1' }, retailLine('anjeer'))),
    );
    expect(unpublished).toEqual({
      code: 'NOT_FOUND',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      body: {
        code: 'NOT_FOUND',
        message: 'We no longer stock one of the items in your basket.',
        details: { slug: 'anjeer' },
      },
    });
    // `resolveLines` runs before the transaction, so a refused basket leaves no cart row behind
    // either — the same claim `cart.integration.spec.ts` makes about the unknown-slug case.
    expect(withdrawn.carts).toEqual([]);
    expect(withdrawn.items).toEqual([]);
  });

  /**
   * The positive control, and it is not decoration.
   *
   * The obvious way to filter on publication is to add `isPublished` to the `select` beside `id` and
   * `slug` and then test the flag in the loop. A column left out of a narrowed `select` comes back
   * `undefined`, `undefined` is falsy, and such a filter rejects **every** product in the catalogue —
   * a shop where nothing can be added to a basket. The test above passes just as happily under that
   * mutation as under the correct one, so this is the half that distinguishes them.
   */
  it('still stores a line whose product is published', async () => {
    const store = fakeCartStore(fakeCatalogue([{ slug: 'anjeer', isPublished: true }]));

    await store.service.replace({ guestToken: 'g1' }, retailLine('anjeer'));

    expect(store.items).toEqual([
      expect.objectContaining({
        productId: 'product-1',
        variantId: 'variant-product-1',
        mode: OrderChannelEnum.RETAIL,
        qty: 2,
      }),
    ]);
  });
});
