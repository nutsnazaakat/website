import { ErrorCodes } from '../../common/errors/domain-error';
import { CustomerSegment, UserRole } from '../../entities/enums';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { CatalogService } from './catalog.service';

const GUEST: AuthenticatedUser | undefined = undefined;

const businessUser = (id = 'user-biz-1'): AuthenticatedUser => ({
  id,
  role: UserRole.BUSINESS,
  sessionId: 'session-1',
});

/**
 * A recording stand-in for TypeORM's `SelectQueryBuilder`. Every chainable method returns `this` and
 * appends to a log, so a test can assert which clauses were added and with which parameters.
 *
 * This double is honest about what it is: it proves the service asks for the right thing. It cannot
 * prove Postgres answers correctly, which is why the catalogue integration spec exists. Do not
 * extend it into a query engine — Plan 1's session-rotation race was invisible to exactly that kind
 * of fake.
 *
 * `leftJoin` and `addSelect` are recorded alongside the methods the plan listed, because the per-kg
 * price arrives as a joined derived table rather than a bare scalar subquery — see the comment on
 * `KG_PRICE_JOIN` in the service. A method missing from this list is not a silent no-op; the double
 * simply has no such property and the call throws, which is how these two were found.
 */
function recordingBuilder() {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of [
    'leftJoin',
    'leftJoinAndSelect',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
    'setParameters',
  ]) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.getManyAndCount = () => Promise.resolve([[], 0]);
  builder.getMany = () => Promise.resolve([]);
  builder.getOne = () => Promise.resolve(null);
  return { builder, calls };
}

/**
 * A recording stand-in for the plain `Repository` methods — the ones that do not go through a query
 * builder. `find` answers with no rows and `findOne` with none, so the not-found branches are the
 * default and a test that wants a row overwrites the property.
 */
function recordingRepository(extra: Record<string, unknown> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    <T>(method: string, result: T) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  const repository: Record<string, unknown> = {
    find: record('find', []),
    findOne: record('findOne', null),
    ...extra,
  };
  return { repository, calls };
}

function build() {
  const { builder, calls } = recordingBuilder();
  const products = recordingRepository({ createQueryBuilder: jest.fn(() => builder) });
  const categories = recordingRepository();
  const businesses = recordingRepository();
  const service = new CatalogService(
    products.repository as never,
    categories.repository as never,
    businesses.repository as never,
  );
  return {
    service,
    calls,
    builder,
    productRepository: products.repository,
    productCalls: products.calls,
    categoryCalls: categories.calls,
    businessRepository: businesses.repository,
    businessCalls: businesses.calls,
  };
}

const firstCall = (calls: { method: string; args: unknown[] }[], method: string): unknown =>
  calls.find((call) => call.method === method)?.args[0];

const clauses = (calls: { method: string; args: unknown[] }[]): string =>
  calls
    .filter((call) => call.method === 'where' || call.method === 'andWhere')
    .map((call) => String(call.args[0]))
    .join(' | ');

describe('CatalogService.listProducts', () => {
  it('only ever returns published products', async () => {
    const { service, calls } = build();
    await service.listProducts({}, GUEST);
    expect(clauses(calls)).toContain('product.isPublished = true');
  });

  it('ignores the category filter when it is the sentinel "all"', async () => {
    const { service, calls } = build();
    await service.listProducts({ category: 'all' }, GUEST);
    expect(clauses(calls)).not.toContain('category.slug');
  });

  it('applies a real category slug', async () => {
    const { service, calls } = build();
    await service.listProducts({ category: 'almonds' }, GUEST);
    expect(clauses(calls)).toContain('category.slug = :category');
  });

  it('searches name, subtitle and origin for the q term', async () => {
    const { service, calls } = build();
    await service.listProducts({ q: 'badam' }, GUEST);
    const where = clauses(calls);
    expect(where).toContain('product.name');
    expect(where).toContain('product.subtitle');
    expect(where).toContain('product.origin');
  });

  /**
   * The per-kg figure, not a pack price. Asserted on the SQL because getting this wrong reorders
   * the whole shop and no row-level test would obviously flag it.
   */
  it('filters price against the derived per-kg price', async () => {
    const { service, calls } = build();
    await service.listProducts({ minPrice: 500, maxPrice: 1500 }, GUEST);
    const where = clauses(calls);
    expect(where).toContain('kg_price >= :minPrice');
    expect(where).toContain('kg_price <= :maxPrice');
  });

  it('sorts by the same per-kg figure', async () => {
    const { service, calls } = build();
    await service.listProducts({ sort: 'price-asc' }, GUEST);
    const order = calls.find((call) => call.method === 'orderBy');
    expect(String(order?.args[0])).toContain('kg_price');
    expect(order?.args[1]).toBe('ASC');
  });

  it('gives every sort a deterministic tiebreak so pages cannot repeat a row', async () => {
    for (const sort of [
      'featured',
      'newest',
      'rating',
      'best-selling',
      'price-asc',
      'price-desc',
    ] as const) {
      const { service, calls } = build();
      await service.listProducts({ sort }, GUEST);
      const tiebreak = calls.find(
        (call) => call.method === 'addOrderBy' && String(call.args[0]).includes('product.id'),
      );
      expect(tiebreak).toBeDefined();
    }
  });

  /**
   * The `bulkTiers` trap, pinned here because it is silent everywhere else.
   *
   * `product.mapper.ts` filters `pricingTiers` on `segment === CustomerSegment.DEFAULT &&
   * businessId === null`. If this query does not hydrate the relation, `pricingTiers` is
   * `undefined`, `bulkTiers` becomes `[]`, and four consumers break at once — `/bulk-orders`,
   * `/bulk/$category`, the product page's bulk calculator, and `cart-math.ts`'s `bulkTotal`, which
   * makes every bulk cart line total `null`. A narrowed `.select([...])` that omitted `segment` or
   * `business_id` would do the same, which is why the join must be `leftJoinAndSelect`.
   */
  it('hydrates pricingTiers, without which bulkTiers silently empties', async () => {
    const { service, calls } = build();
    await service.listProducts({}, GUEST);
    const join = calls.find(
      (call) =>
        call.method === 'leftJoinAndSelect' && String(call.args[0]) === 'product.pricingTiers',
    );
    expect(join).toBeDefined();
  });

  /**
   * `inStockOnly` was a no-op in Phase 1 — the mock hardcoded stock on every variant, so the box
   * changed the URL and nothing else. It also read `available` across *all* variants including bulk,
   * so a product whose retail packs were empty but whose 50kg pack had stock still appeared on
   * `/shop` as in stock. Both are fixed here: the filter is real, and it respects `channel`.
   */
  it('filters to products with stock in the requested channel', async () => {
    const { service, calls } = build();
    await service.listProducts({ inStockOnly: true, channel: 'retail' }, GUEST);
    const where = clauses(calls);
    expect(where).toContain('EXISTS');
    expect(where).toContain('inventory');
    const params = calls.find((call) => call.method === 'setParameters');
    expect(params?.args[0]).toMatchObject({ channel: 'RETAIL' });
  });

  /**
   * `maxMoq` moved server-side in this plan. It was a client-side `.filter` over the fetched array,
   * which under pagination filtered one page and reported that as the category — harmless only
   * because the largest category holds eight products against a default limit of 24.
   */
  it('filters on the minimum order quantity when one is asked for', async () => {
    const { service, calls } = build();
    await service.listProducts({ maxMoq: 10 }, GUEST);
    expect(clauses(calls)).toContain('product.moqKg <= :maxMoq');
    const params = calls.find((call) => call.method === 'setParameters');
    expect(params?.args[0]).toMatchObject({ maxMoq: 10 });
  });

  it('leaves the MOQ unconstrained when the filter is absent', async () => {
    const { service, calls } = build();
    await service.listProducts({}, GUEST);
    expect(clauses(calls)).not.toContain('moqKg');
  });

  it('caps the page size so a client cannot ask for the whole table', async () => {
    const { service, calls } = build();
    await service.listProducts({ limit: 5000 }, GUEST);
    const take = calls.find((call) => call.method === 'take');
    expect(take?.args[0]).toBe(60);
  });

  it('defaults to page 1 with a sane limit', async () => {
    const { service, calls } = build();
    await service.listProducts({}, GUEST);
    expect(calls.find((call) => call.method === 'skip')?.args[0]).toBe(0);
    expect(calls.find((call) => call.method === 'take')?.args[0]).toBe(24);
  });

  it('translates page 3 into the right offset', async () => {
    const { service, calls } = build();
    await service.listProducts({ page: 3, limit: 12 }, GUEST);
    expect(calls.find((call) => call.method === 'skip')?.args[0]).toBe(24);
  });

  it('clamps a nonsensical page to the first one', async () => {
    const { service, calls } = build();
    await service.listProducts({ page: 0 }, GUEST);
    expect(calls.find((call) => call.method === 'skip')?.args[0]).toBe(0);
  });
});

describe('CatalogService.getProduct', () => {
  /**
   * `.rejects.toMatchObject({ code })` and not `toThrow(/NOT_FOUND/)`: `DomainError extends
   * HttpException`, whose `initMessage()` copies only `response.message` into `Error.message`, so a
   * regex for the code can never match.
   */
  it('rejects an unknown slug with NOT_FOUND instead of returning null', async () => {
    const { service } = build();
    await expect(service.getProduct('no-such-product', GUEST)).rejects.toMatchObject({
      code: ErrorCodes.NOT_FOUND,
    });
  });

  it('narrows the published-only base query by slug', async () => {
    const { service, calls } = build();
    await service.getProduct('kashmiri-mamra-almonds', GUEST).catch(() => undefined);
    const where = clauses(calls);
    expect(where).toContain('product.isPublished = true');
    expect(where).toContain('product.slug = :slug');
  });
});

describe('CatalogService.listRelated', () => {
  /**
   * The deliberate asymmetry with `getProduct`, pinned so it cannot be "fixed" into a 404.
   *
   * A related-products rail is decoration on a page whose main content has already loaded. Throwing
   * here would take down a product page that otherwise rendered fine, and Phase 1 returned `[]`.
   */
  it('returns an empty page for an unknown slug rather than throwing', async () => {
    const { service } = build();
    await expect(service.listRelated('no-such-product', GUEST)).resolves.toEqual({
      items: [],
      total: 0,
      page: 1,
      limit: 4,
    });
  });

  it('resolves the slug among published products only', async () => {
    const { service, productCalls } = build();
    await service.listRelated('draft-product', GUEST);
    expect(firstCall(productCalls, 'findOne')).toMatchObject({
      where: { slug: 'draft-product', isPublished: true },
    });
  });

  it('stays inside the category and excludes the product itself', async () => {
    const { service, calls, productRepository } = build();
    productRepository.findOne = () => Promise.resolve({ id: 'p-1', categoryId: 'c-1' });

    const page = await service.listRelated('kashmiri-mamra-almonds', GUEST);

    const where = clauses(calls);
    expect(where).toContain('product.categoryId = :categoryId');
    expect(where).toContain('product.id != :id');
    expect(calls.find((call) => call.method === 'take')?.args[0]).toBe(4);
    expect(page.page).toBe(1);
  });
});

describe('CatalogService.productsBySlugs', () => {
  /**
   * The empty case is not defensive tidiness. TypeORM expands `IN (:...slugs)` by interpolating the
   * array's members, so an empty array produces `IN ()` — a Postgres syntax error, which is a 500 on
   * the combos page rather than an empty one. Asserted by the absence of a query, because that is
   * the only observable difference between the guard and no guard.
   */
  it('asks the database nothing for an empty slug list', async () => {
    const { service, calls, productRepository } = build();
    await expect(service.productsBySlugs([], GUEST)).resolves.toEqual([]);
    expect(productRepository.createQueryBuilder).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('resolves a whole slug set in one published-only query', async () => {
    const { service, calls, productRepository } = build();
    await service.productsBySlugs(['gift-box', 'almonds'], GUEST);
    expect(productRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
    const where = clauses(calls);
    expect(where).toContain('product.isPublished = true');
    expect(where).toContain('product.slug IN (:...slugs)');
  });
});

/**
 * A complete-enough product row for `getOne`/`getMany` to hand back, so `toWireProduct` runs for
 * real rather than throwing on a field the double never set. `pricingTiers` is the field these
 * tests vary; everything else is the minimum `toWireProduct` reads without throwing.
 */
function productFixture(pricingTiers: Record<string, unknown>[]) {
  return {
    slug: 'kashmiri-mamra-almonds',
    name: 'Kashmiri Mamra Almonds',
    category: { slug: 'almonds' },
    subtitle: 's',
    description: 'd',
    badge: null,
    ratingAvg: '4.50',
    reviewCount: 10,
    images: [],
    origin: 'o',
    grade: 'g',
    processing: 'p',
    shelfLife: 'sl',
    storage: 'st',
    ingredients: 'i',
    hsn: '0802',
    gstRate: '5.00',
    variants: [],
    pricingTiers,
    moqKg: '10.00',
    quoteOnly: false,
    seo: { title: 't', description: 'd', ogImage: '/o.jpg' },
  } as unknown;
}

/**
 * `productFixture` returns `unknown` deliberately — `getOne`/`getMany` promise a real `Product`,
 * and a fixture typed as one would let a missing field compile instead of throwing inside
 * `toWireProduct`. Spreading `unknown` does not typecheck, so overriding one field (a distinct
 * `slug`, `quoteOnly: true`) goes through this rather than an inline cast at every call site.
 */
function withOverride(fixture: unknown, overrides: Record<string, unknown>): unknown {
  return { ...(fixture as Record<string, unknown>), ...overrides };
}

const DEFAULT_LADDER = [
  {
    minKg: '1',
    maxKg: '24',
    pricePerKgPaise: 70000n,
    segment: CustomerSegment.DEFAULT,
    businessId: null,
  },
];
const RETAILER_LADDER = [
  {
    minKg: '1',
    maxKg: '24',
    pricePerKgPaise: 65000n,
    segment: CustomerSegment.RETAILER,
    businessId: null,
  },
];
const BUSINESS_LADDER = (businessId: string) => [
  {
    minKg: '1',
    maxKg: '24',
    pricePerKgPaise: 62000n,
    segment: CustomerSegment.DEFAULT,
    businessId,
  },
];

describe('CatalogService pricing viewer', () => {
  /**
   * `viewerFor`'s query behaviour, pinned separately from the ladder it resolves: a page of
   * products must cost one `businesses` read, not one per product, and the read must not happen at
   * all for the callers who could never be a business — every guest and every retail customer.
   */
  it('never queries the businesses table for a guest', async () => {
    const { service, businessCalls, builder } = build();
    builder.getOne = () => Promise.resolve(productFixture(DEFAULT_LADDER));
    await service.getProduct('kashmiri-mamra-almonds', GUEST);
    expect(businessCalls).toEqual([]);
  });

  it('never queries the businesses table for a CUSTOMER or ADMIN — the role guard short-circuits', async () => {
    for (const role of ['CUSTOMER', 'ADMIN']) {
      const { service, businessCalls, builder } = build();
      builder.getOne = () => Promise.resolve(productFixture(DEFAULT_LADDER));
      await service.getProduct('kashmiri-mamra-almonds', {
        id: 'user-1',
        role,
        sessionId: 's',
      });
      expect(businessCalls).toEqual([]);
    }
  });

  it('queries the businesses table exactly once for a BUSINESS user, scoped to their own userId', async () => {
    const { service, businessCalls, businessRepository, builder } = build();
    // Assigned as a call that still pushes onto `businessCalls`, not a bare replacement —
    // `businessRepository.findOne = () => Promise.resolve(...)` would overwrite the recording
    // wrapper `recordingRepository` installed at `build()` time, so nothing after that assignment
    // would be captured in `businessCalls` even though the closure still closes over the same array.
    businessRepository.findOne = (...args: unknown[]) => {
      businessCalls.push({ method: 'findOne', args });
      return Promise.resolve({ id: 'biz-1', segment: CustomerSegment.DEFAULT });
    };
    builder.getOne = () => Promise.resolve(productFixture(DEFAULT_LADDER));

    await service.getProduct('kashmiri-mamra-almonds', businessUser('user-biz-1'));

    expect(businessCalls).toHaveLength(1);
    expect(businessCalls[0]?.args[0]).toMatchObject({
      where: { userId: 'user-biz-1' },
      select: { id: true, segment: true },
    });
  });

  it('a public read resolves DEFAULT tiers — unchanged behaviour, pinned', async () => {
    const { service, builder } = build();
    builder.getOne = () => Promise.resolve(productFixture([...DEFAULT_LADDER, ...RETAILER_LADDER]));

    const wire = await service.getProduct('kashmiri-mamra-almonds', GUEST);

    expect(wire.bulkTiers).toHaveLength(1);
    expect(wire.bulkTiers[0]?.pricePerKg).toBe(700);
  });

  it('a signed-in DEFAULT business reads the same tiers as a public viewer — the no-op guarantee', async () => {
    const { service, businessRepository, builder } = build();
    businessRepository.findOne = () =>
      Promise.resolve({ id: 'biz-1', segment: CustomerSegment.DEFAULT });
    builder.getOne = () => Promise.resolve(productFixture([...DEFAULT_LADDER, ...RETAILER_LADDER]));

    const wire = await service.getProduct('kashmiri-mamra-almonds', businessUser());

    expect(wire.bulkTiers).toHaveLength(1);
    expect(wire.bulkTiers[0]?.pricePerKg).toBe(700);
  });

  it('a signed-in RETAILER business reads the RETAILER ladder, not DEFAULT', async () => {
    const { service, businessRepository, builder } = build();
    businessRepository.findOne = () =>
      Promise.resolve({ id: 'biz-1', segment: CustomerSegment.RETAILER });
    builder.getOne = () => Promise.resolve(productFixture([...DEFAULT_LADDER, ...RETAILER_LADDER]));

    const wire = await service.getProduct('kashmiri-mamra-almonds', businessUser());

    expect(wire.bulkTiers).toHaveLength(1);
    expect(wire.bulkTiers[0]?.pricePerKg).toBe(650);
  });

  it('a business with its own ladder reads its own, not DEFAULT', async () => {
    const { service, businessRepository, builder } = build();
    businessRepository.findOne = () =>
      Promise.resolve({ id: 'biz-1', segment: CustomerSegment.DEFAULT });
    builder.getOne = () =>
      Promise.resolve(
        productFixture([...DEFAULT_LADDER, ...RETAILER_LADDER, ...BUSINESS_LADDER('biz-1')]),
      );

    const wire = await service.getProduct('kashmiri-mamra-almonds', businessUser());

    expect(wire.bulkTiers).toHaveLength(1);
    expect(wire.bulkTiers[0]?.pricePerKg).toBe(620);
  });

  it('a BUSINESS user with no business row reads list pricing, not an error', async () => {
    const { service, businessRepository, builder } = build();
    businessRepository.findOne = () => Promise.resolve(null);
    builder.getOne = () => Promise.resolve(productFixture(DEFAULT_LADDER));

    const wire = await service.getProduct('kashmiri-mamra-almonds', businessUser());

    expect(wire.bulkTiers).toHaveLength(1);
    expect(wire.bulkTiers[0]?.pricePerKg).toBe(700);
  });
});

describe('CatalogService.listBulkProducts', () => {
  it("reuses the main listing's filters and sort rather than a second derivation", async () => {
    const { service, calls } = build();
    await service.listBulkProducts({ category: 'almonds', sort: 'price-asc' }, GUEST);
    expect(clauses(calls)).toContain('category.slug = :category');
    const order = calls.find((call) => call.method === 'orderBy');
    expect(String(order?.args[0])).toContain('kg_price');
    expect(order?.args[1]).toBe('ASC');
  });

  /** The case Step 4 names explicitly: a product with no tier at all must not appear. */
  it('omits a product whose ladder resolves empty for this viewer', async () => {
    const { service, builder } = build();
    builder.getMany = () =>
      Promise.resolve([
        withOverride(productFixture([]), { slug: 'no-ladder' }),
        withOverride(productFixture(DEFAULT_LADDER), { slug: 'has-ladder' }),
      ]);

    const page = await service.listBulkProducts({}, GUEST);

    expect(page.items.map((item) => item.slug)).toEqual(['has-ladder']);
    expect(page.total).toBe(1);
  });

  it("attaches each surviving product's resolved ladder, same as a product-detail read", async () => {
    const { service, builder } = build();
    builder.getMany = () => Promise.resolve([productFixture(DEFAULT_LADDER)]);

    const page = await service.listBulkProducts({}, GUEST);

    expect(page.items[0]?.bulkTiers).toHaveLength(1);
    expect(page.items[0]?.bulkTiers[0]?.pricePerKg).toBe(700);
  });

  it('resolves a RETAILER business ladder here too, not just on the product page', async () => {
    const { service, businessRepository, builder } = build();
    businessRepository.findOne = () =>
      Promise.resolve({ id: 'biz-1', segment: CustomerSegment.RETAILER });
    builder.getMany = () =>
      Promise.resolve([productFixture([...DEFAULT_LADDER, ...RETAILER_LADDER])]);

    const page = await service.listBulkProducts({}, businessUser());

    expect(page.items[0]?.bulkTiers[0]?.pricePerKg).toBe(650);
  });

  /**
   * The filter has to run before the slice, or a page of `limit` fetched rows could report fewer
   * bulk-orderable items than actually exist beyond it. Three rows, the middle one un-laddered,
   * `limit: 1`: a slice-before-filter bug would answer `['a']` and a filter-before-slice
   * implementation answers the same thing here only because `a` sorts first either way — the
   * `total` is what actually distinguishes them, since a slice-before-filter total would count all
   * three fetched rows rather than the two that survived.
   */
  it('paginates the filtered set, not the fetched one', async () => {
    const { service, builder } = build();
    builder.getMany = () =>
      Promise.resolve([
        withOverride(productFixture(DEFAULT_LADDER), { slug: 'a' }),
        withOverride(productFixture([]), { slug: 'b' }),
        withOverride(productFixture(DEFAULT_LADDER), { slug: 'c' }),
      ]);

    const page = await service.listBulkProducts({ page: 1, limit: 1 }, GUEST);

    expect(page.items.map((item) => item.slug)).toEqual(['a']);
    expect(page.total).toBe(2);
  });

  it('caps the page size exactly as the main listing does', async () => {
    const { service, builder } = build();
    builder.getMany = () => Promise.resolve([productFixture(DEFAULT_LADDER)]);

    const page = await service.listBulkProducts({ limit: 5000 }, GUEST);

    expect(page.limit).toBe(60);
  });
});

describe('CatalogService.quotePreview', () => {
  it('rejects an unknown slug with NOT_FOUND rather than a priced answer', async () => {
    const { service } = build();
    await expect(
      service.quotePreview({ slug: 'no-such-thing', kg: 10 }, GUEST),
    ).rejects.toMatchObject({ code: ErrorCodes.NOT_FOUND });
  });

  /**
   * Checked before the ladder, matching `verdictFor`'s order: `corporate-gift-box` sits inside a
   * *priced* tier and must still answer `quoteRequired`, so a mutation that moved this check after
   * the ladder lookup and let a priced rung win would slip past a test that only used an unpriced
   * slab.
   */
  it('reports quoteRequired for a quote-only product even inside a priced tier', async () => {
    const { service, builder } = build();
    builder.getOne = () =>
      Promise.resolve(withOverride(productFixture(DEFAULT_LADDER), { quoteOnly: true }));

    const preview = await service.quotePreview({ slug: 'kashmiri-mamra-almonds', kg: 10 }, GUEST);

    expect(preview).toMatchObject({
      quoteRequired: true,
      pricePerKg: null,
      total: null,
      tier: null,
    });
  });

  it('reports quoteRequired for a weight in an unpriced slab, not an error', async () => {
    const { service, builder } = build();
    builder.getOne = () =>
      Promise.resolve(
        productFixture([
          {
            minKg: '1',
            maxKg: '24',
            pricePerKgPaise: null,
            segment: CustomerSegment.DEFAULT,
            businessId: null,
          },
        ]),
      );

    const preview = await service.quotePreview({ slug: 'kashmiri-mamra-almonds', kg: 10 }, GUEST);

    expect(preview.quoteRequired).toBe(true);
    expect(preview.pricePerKg).toBeNull();
    expect(preview.total).toBeNull();
    expect(preview.tier).toEqual({ minKg: 1, maxKg: 24 });
  });

  it('prices a weight inside a real rung, in rupees', async () => {
    const { service, builder } = build();
    builder.getOne = () => Promise.resolve(productFixture(DEFAULT_LADDER));

    // DEFAULT_LADDER: 1-24kg at ₹700/kg.
    const preview = await service.quotePreview({ slug: 'kashmiri-mamra-almonds', kg: 10 }, GUEST);

    expect(preview).toMatchObject({
      quoteRequired: false,
      pricePerKg: 700,
      total: 7000,
      tier: { minKg: 1, maxKg: 24 },
    });
  });

  /** The RETAILER case the mutation table names: a viewer's own ladder must actually be read. */
  it("prices from a RETAILER business's own ladder, not DEFAULT", async () => {
    const { service, businessRepository, builder } = build();
    businessRepository.findOne = () =>
      Promise.resolve({ id: 'biz-1', segment: CustomerSegment.RETAILER });
    builder.getOne = () => Promise.resolve(productFixture([...DEFAULT_LADDER, ...RETAILER_LADDER]));

    const preview = await service.quotePreview(
      { slug: 'kashmiri-mamra-almonds', kg: 10 },
      businessUser(),
    );

    expect(preview.pricePerKg).toBe(650);
  });

  /**
   * `resolveTiersForWeight`'s fallback, exercised through this route for the first time: a
   * business ladder capped at 24kg must not extend to 30kg at its own rate — the honest answer for
   * the excess is `DEFAULT`'s, priced at ₹700, not the negotiated ₹620.
   */
  it("falls through to DEFAULT for a weight past the viewer's own ladder, never the ladder's own rate", async () => {
    const { service, businessRepository, builder } = build();
    businessRepository.findOne = () =>
      Promise.resolve({ id: 'biz-1', segment: CustomerSegment.DEFAULT });
    builder.getOne = () =>
      Promise.resolve(productFixture([...DEFAULT_LADDER, ...BUSINESS_LADDER('biz-1')]));

    const preview = await service.quotePreview(
      { slug: 'kashmiri-mamra-almonds', kg: 30 },
      businessUser('biz-1'),
    );

    expect(preview.quoteRequired).toBe(true);
    expect(preview.pricePerKg).toBeNull();
  });
});

describe('CatalogService category reads', () => {
  it('lists published categories in display order', async () => {
    const { service, categoryCalls } = build();
    await service.listCategories();
    expect(firstCall(categoryCalls, 'find')).toMatchObject({
      where: { isPublished: true },
      order: { sortOrder: 'ASC' },
    });
  });

  it('rejects an unknown or unpublished category slug with NOT_FOUND', async () => {
    const { service, categoryCalls } = build();
    await expect(service.getCategory('no-such-category')).rejects.toMatchObject({
      code: ErrorCodes.NOT_FOUND,
    });
    expect(firstCall(categoryCalls, 'findOne')).toMatchObject({
      where: { slug: 'no-such-category', isPublished: true },
    });
  });
});
