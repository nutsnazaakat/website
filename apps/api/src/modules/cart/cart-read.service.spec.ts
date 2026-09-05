import type { Repository } from 'typeorm';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import type { Product } from '../../entities/catalog/product.entity';
import type { ProductVariant } from '../../entities/catalog/product-variant.entity';
import type { Cart } from '../../entities/commerce/cart.entity';
import { CustomerSegment, OrderChannelEnum } from '../../entities/enums';
import type { Business } from '../../entities/identity/business.entity';
import type { Setting } from '../../entities/ops/setting.entity';
import { CartPricingService } from './cart-pricing.service';
import { CartReadService, verdictFor } from './cart-read.service';
import type { CartLineDto } from './dto/replace-cart.dto';

const retail = (qty: number, available: number, moq = 1) => ({
  id: 'line-1',
  slug: 'almonds',
  mode: 'RETAIL' as const,
  qty,
  kg: null,
  variant: { moq, pricePaise: 29900n, available },
  product: { gstRate: 5, moqKg: 10, quoteOnly: false, bulkTiers: [] },
});

describe('verdictFor', () => {
  it('passes a line that is in stock and above its minimum', () => {
    const verdict = verdictFor(retail(2, 120));
    expect(verdict.code).toBeUndefined();
    expect(verdict.availableQty).toBe(120);
    expect(verdict.lineTotal).toBe(598);
  });

  /**
   * The point of the endpoint. The line is not silently reduced — `availableQty` and `requestedQty`
   * are both reported so the UI can say "only 3 left" and let the customer choose.
   */
  it('reports OUT_OF_STOCK with both quantities when the basket asks for more than remains', () => {
    const verdict = verdictFor(retail(10, 3));
    expect(verdict.code).toBe('OUT_OF_STOCK');
    expect(verdict.availableQty).toBe(3);
    expect(verdict.requestedQty).toBe(10);
  });

  it('reports OUT_OF_STOCK for a sold-out line rather than pricing it', () => {
    expect(verdictFor(retail(1, 0)).code).toBe('OUT_OF_STOCK');
  });

  /**
   * Both rules can fire at once, and the order decides which the customer is told. Sold out first,
   * because `BELOW_MOQ` on an empty variant sends them to raise the quantity and fail again.
   */
  it('reports OUT_OF_STOCK, not BELOW_MOQ, when a line is both under the minimum and sold out', () => {
    expect(verdictFor(retail(1, 0, 3)).code).toBe('OUT_OF_STOCK');
  });

  it('reports BELOW_MOQ when the quantity is under the variant minimum', () => {
    expect(verdictFor(retail(1, 120, 3)).code).toBe('BELOW_MOQ');
  });

  it('marks a line whose product or variant has gone as unavailable', () => {
    const verdict = verdictFor({ ...retail(1, 120), variant: null });
    expect(verdict.unavailable).toBe(true);
    expect(verdict.code).toBe('NOT_FOUND');
    expect(verdict.lineTotal).toBeNull();
  });

  /**
   * A bulk weight landing in a tier with no price is a quote, not a free item. `lineTotal` is null and
   * the code says so, which is what stops checkout treating it as zero.
   */
  it('reports QUOTE_REQUIRED for a bulk weight in an unpriced tier', () => {
    const verdict = verdictFor({
      id: 'line-2',
      slug: 'almonds',
      mode: 'BULK',
      qty: 1,
      kg: '50.00',
      variant: null,
      product: {
        gstRate: 5,
        moqKg: 10,
        quoteOnly: false,
        bulkTiers: [
          { minKg: 25, maxKg: 49, pricePerKgPaise: 84900n },
          { minKg: 50, maxKg: null, pricePerKgPaise: null },
        ],
      },
    });
    expect(verdict.code).toBe('QUOTE_REQUIRED');
    expect(verdict.lineTotal).toBeNull();
  });

  /**
   * **`Product.quoteOnly` is a server-side gate, not a client hint.**
   *
   * Before this test the server priced a quote-only product and called the basket valid. Measured
   * against the running service, a 25kg Corporate Gift Box — `quoteOnly = true` in the database:
   *
   *     POST /cart/validate {"lines":[{"slug":"corporate-gift-box","mode":"bulk","kg":25,"qty":1}]}
   *     -> { ok: true, lineTotal: 33975, hasQuoteLines: false, total: 35673.75 }
   *
   * The storefront honours the flag — `product.$slug.tsx:118` swaps Add-to-Cart for *Request a Quote*
   * and a smoke test pins it — so the only thing standing between a negotiated, custom-branded product
   * and a self-service COD order at ₹33,975 was a React boolean. Spec §13 is explicit that the server
   * recomputes and that client-side gating "stops nothing else".
   *
   * Note this is a **second, independent** gate from the unpriced-tier case above: `corporate-gift-box`
   * lands in a tier that *does* carry a price, which is exactly why the tier ladder could not catch it.
   */
  it('refuses to price a quoteOnly product even inside a priced tier', () => {
    const verdict = verdictFor({
      id: 'line-q',
      slug: 'corporate-gift-box',
      mode: 'BULK',
      qty: 1,
      kg: '25.00',
      variant: null,
      product: {
        gstRate: 5,
        moqKg: 25,
        quoteOnly: true,
        bulkTiers: [{ minKg: 25, maxKg: 49, pricePerKgPaise: 135900n }],
      },
    });
    expect(verdict.code).toBe('QUOTE_REQUIRED');
    expect(verdict.lineTotal).toBeNull();
  });

  /** The same gate on the retail channel, which has its own path through `verdictFor`. */
  it('refuses to price a quoteOnly product on the retail channel too', () => {
    const verdict = verdictFor({
      ...retail(1, 120),
      product: { gstRate: 5, moqKg: 10, quoteOnly: true, bulkTiers: [] },
    });
    expect(verdict.code).toBe('QUOTE_REQUIRED');
    expect(verdict.lineTotal).toBeNull();
  });

  it('prices a bulk line from its resolved tier', () => {
    const verdict = verdictFor({
      id: 'line-3',
      slug: 'almonds',
      mode: 'BULK',
      qty: 1,
      kg: '25.00',
      variant: null,
      product: {
        gstRate: 5,
        moqKg: 10,
        quoteOnly: false,
        bulkTiers: [{ minKg: 25, maxKg: 49, pricePerKgPaise: 84900n }],
      },
    });
    expect(verdict.code).toBeUndefined();
    expect(verdict.lineTotal).toBe(21225);
  });

  it('reports BELOW_MOQ when a bulk weight is under the product minimum', () => {
    const verdict = verdictFor({
      id: 'line-4',
      slug: 'almonds',
      mode: 'BULK',
      qty: 1,
      kg: '5.00',
      variant: null,
      product: {
        gstRate: 5,
        moqKg: 10,
        quoteOnly: false,
        bulkTiers: [{ minKg: 1, maxKg: 9, pricePerKgPaise: 99900n }],
      },
    });
    expect(verdict.code).toBe('BELOW_MOQ');
  });

  /**
   * A bulk line is not variant-bound, so there is no single inventory row to report. Null says
   * "not applicable" rather than "none left", which a zero would.
   */
  it('reports a null availableQty for a bulk line', () => {
    const verdict = verdictFor({
      id: 'line-5',
      slug: 'almonds',
      mode: 'BULK',
      qty: 1,
      kg: '25.00',
      variant: null,
      product: {
        gstRate: 5,
        moqKg: 10,
        quoteOnly: false,
        bulkTiers: [{ minKg: 25, maxKg: 49, pricePerKgPaise: 84900n }],
      },
    });
    expect(verdict.availableQty).toBeNull();
  });
});

type Tier = { minKg: number; maxKg: number | null; pricePerKgPaise: bigint | null };

const bulk = (kg: string, bulkTiers: Tier[], moqKg = 10, qty = 1) => ({
  id: 'line-b',
  slug: 'almonds',
  mode: 'BULK' as const,
  qty,
  kg,
  variant: null,
  product: { gstRate: 5, moqKg, quoteOnly: false, bulkTiers },
});

/**
 * The cases above establish the rules. These pin the *edges* of them, and every one of them was
 * chosen by mutating `verdictFor` and finding that all ten tests above still passed — so each of
 * these is the only thing standing between the shop and a specific wrong answer.
 */
describe('verdictFor at its boundaries', () => {
  /**
   * The last unit has to be buyable. `>=` in place of `>` reads a basket asking for exactly what
   * remains as sold out, and no case above distinguishes the two: none has `qty === available`.
   */
  it('lets a line take exactly the stock that remains', () => {
    const verdict = verdictFor(retail(3, 3));
    expect(verdict.code).toBeUndefined();
    expect(verdict.lineTotal).toBe(897);
  });

  /** Same edge on the other rule: a pack minimum of 3 must accept a quantity of 3. */
  it('lets a line sit exactly on the variant minimum', () => {
    expect(verdictFor(retail(3, 120, 3)).code).toBeUndefined();
  });

  /** And on the bulk minimum: a 10kg product minimum must accept an order of exactly 10kg. */
  it('lets a bulk line sit exactly on the product minimum weight', () => {
    const verdict = verdictFor(bulk('10.00', [{ minKg: 10, maxKg: 24, pricePerKgPaise: 89900n }]));
    expect(verdict.code).toBeUndefined();
    expect(verdict.lineTotal).toBe(8990);
  });

  /** A slab is inclusive at both ends. 49kg belongs to the 25–49 slab, not to no slab at all. */
  it('prices a bulk weight sitting exactly on its tier ceiling', () => {
    const verdict = verdictFor(bulk('49.00', [{ minKg: 25, maxKg: 49, pricePerKgPaise: 84900n }]));
    expect(verdict.lineTotal).toBe(41601);
  });

  /**
   * The open-ended top slab. `maxKg === null` means "and above", and without that branch `kg <= null`
   * is false, no slab resolves, and the line reports `QUOTE_REQUIRED` — which is the *same* answer
   * the unpriced 50kg+ slab gives, so the `QUOTE_REQUIRED` case above cannot tell the two apart.
   *
   * Every top slab the seeder writes is unpriced today (`buildTiers` in `catalog.seed.ts`), so this
   * branch has no production input that would expose it either. It has to be pinned directly, or the
   * day an admin prices a 50kg+ slab the shop quietly routes those orders to the RFQ form instead.
   */
  it('prices an open-ended top tier instead of calling it a quote', () => {
    const verdict = verdictFor(
      bulk('60.00', [{ minKg: 50, maxKg: null, pricePerKgPaise: 79900n }]),
    );
    expect(verdict.code).toBeUndefined();
    expect(verdict.lineTotal).toBe(47940);
  });

  /**
   * Multiply the whole line, then divide once.
   *
   * `BigInt` division truncates, so dividing to a per-unit figure first multiplies the truncation by
   * the quantity. Measured: `perKg` 84999 at 0.01kg × 10 bills 8490 paise the wrong way round and
   * 8499 the right way — nine paise short, and the shortfall grows with the quantity.
   *
   * Neither bulk pricing case above can see it. Both use whole-rupee-per-kg slabs at whole weights,
   * where the two orders agree exactly, and that is every slab the seeder holds. Reaching it needs a
   * `pricePerKgPaise` that is not a multiple of 100 together with a fractional `kg` — which
   * `CartLineDto` permits, since `kg` is only bounded by `@Min(0.01)`.
   */
  it('multiplies the whole line before dividing to paise', () => {
    const verdict = verdictFor(
      bulk('0.01', [{ minKg: 0.01, maxKg: null, pricePerKgPaise: 84999n }], 0, 10),
    );
    expect(verdict.lineTotal).toBe(84.99);
  });

  /**
   * A line that cannot be bought must carry no price.
   *
   * `present` hands `lineTotal` to the money as `lineTotalPaise`, and `CartPricingService`'s
   * `isPriceable` drops a line only when that is null. A price on a rejected line would put stock
   * that does not exist into the customer's subtotal — and neither the `OUT_OF_STOCK` nor the
   * `BELOW_MOQ` case above asserts on `lineTotal`.
   */
  it('withholds a price from every line it rejects', () => {
    expect(verdictFor(retail(10, 3)).lineTotal).toBeNull();
    expect(verdictFor(retail(1, 120, 3)).lineTotal).toBeNull();
  });

  /**
   * `unavailable` is a wire field the cart page reads to grey a line out, and `id` is how a verdict
   * finds the line it is about. Only the negative case of the flag is unpinned above — a healthy line
   * claiming to be unavailable passes all ten — and nothing above asserts that `id` or `slug` are
   * echoed through rather than invented.
   */
  it('names the line it is about and reports it as available', () => {
    const verdict = verdictFor(retail(2, 120));
    expect(verdict.unavailable).toBe(false);
    expect(verdict.id).toBe('line-1');
    expect(verdict.slug).toBe('almonds');
  });
});

/** Numeric columns reach the service as strings from `pg`, and these fixtures keep that shape. */
const PRODUCT = {
  id: 'product-1',
  slug: 'almonds',
  /**
   * Stated, not omitted, and it is the fixture equivalent of a `select` that forgets a column.
   *
   * The stored-cart path reads `isPublished` straight off the loaded relation, so a fixture without
   * it hands the service `undefined` — falsy — and every stored line in this file reads `NOT_FOUND`
   * with no price. That failure looks like a broken rule rather than a broken fixture, which is why
   * it is spelled out here even though `Product` declares the column non-null.
   */
  isPublished: true,
  gstRate: '5.00',
  moqKg: '10.00',
  /**
   * `segment: DEFAULT, businessId: null` on both rows, because `resolveTiers` (Milestone 7) now
   * filters this relation rather than `toProductRules` mapping it unconditionally — a fixture tier
   * missing either field fails the filter exactly as an unset `isPublished` above fails its own,
   * and for the identical reason: it looks like a broken rule rather than a broken fixture.
   */
  pricingTiers: [
    {
      minKg: '25.00',
      maxKg: '49.00',
      pricePerKgPaise: 84900n,
      segment: CustomerSegment.DEFAULT,
      businessId: null,
    },
    {
      minKg: '50.00',
      maxKg: null,
      pricePerKgPaise: null,
      segment: CustomerSegment.DEFAULT,
      businessId: null,
    },
  ],
} as unknown as Product;

const VARIANT = {
  id: 'variant-1',
  productId: 'product-1',
  size: '250g',
  grams: 250,
  isActive: true,
  moq: 1,
  pricePaise: 29900n,
  inventory: { onHand: 120, reserved: 0 },
} as unknown as ProductVariant;

/** One retail line and one bulk line of the same product — two lines, never folded into one. */
const STORED = {
  items: [
    {
      id: 'row-1',
      mode: OrderChannelEnum.RETAIL,
      kg: null,
      qty: 2,
      product: PRODUCT,
      variant: VARIANT,
    },
    {
      id: 'row-2',
      mode: OrderChannelEnum.BULK,
      kg: '25.00',
      qty: 1,
      product: PRODUCT,
      variant: null,
    },
  ],
} as unknown as Cart;

/** The same basket as the checkout page would send it. */
const BODY: CartLineDto[] = [
  { slug: 'almonds', mode: 'retail', size: '250g', qty: 2 },
  { slug: 'almonds', mode: 'bulk', kg: 25, qty: 1 },
];

const EMPTY_TOTALS = {
  subtotal: 0,
  gst: 0,
  shipping: 0,
  total: 0,
  hasQuoteLines: false,
  hasUnpriceableLines: false,
};

/**
 * `businesses.findOne` answers `null` by default — no business row, so `viewerFor` resolves every
 * caller to a `null` viewer and every pre-existing test in this file keeps exercising exactly the
 * behaviour it always did. A test that wants a `BUSINESS` caller overwrites it, and — as
 * `catalog.service.spec.ts` learned the hard way — must overwrite it with a function that still
 * pushes onto `businessCalls` rather than a bare replacement, if it means to assert against that
 * array afterwards; nothing here does, so a bare replacement is safe.
 */
function harness(settingRows: { key: string; value: unknown }[] = []) {
  const settings = { find: jest.fn().mockResolvedValue(settingRows) };
  const products = { find: jest.fn().mockResolvedValue([PRODUCT]) };
  const variants = { find: jest.fn().mockResolvedValue([VARIANT]) };
  const businesses = { findOne: jest.fn().mockResolvedValue(null) };

  return {
    service: new CartReadService(
      settings as unknown as Repository<Setting>,
      products as unknown as Repository<Product>,
      variants as unknown as Repository<ProductVariant>,
      businesses as unknown as Repository<Business>,
      new CartPricingService(),
    ),
    settings,
    products,
    variants,
    businesses,
  };
}

/** A signed-in customer, never resolved to a `BUSINESS` viewer — the default's short-circuit. */
const CUSTOMER: AuthenticatedUser = { id: 'user-1', role: 'CUSTOMER', sessionId: 'session-1' };

/** A signed-in business account, the one role `viewerFor` will actually query a row for. */
const BUSINESS_USER: AuthenticatedUser = { id: 'user-2', role: 'BUSINESS', sessionId: 'session-2' };

describe('CartReadService.viewerFor', () => {
  it('resolves an anonymous caller to null without querying the businesses table', async () => {
    const { service, businesses } = harness();

    expect(await service.viewerFor(undefined)).toBeNull();
    expect(businesses.findOne).not.toHaveBeenCalled();
  });

  it('resolves a non-business role to null without querying the businesses table', async () => {
    const { service, businesses } = harness();

    expect(await service.viewerFor(CUSTOMER)).toBeNull();
    expect(businesses.findOne).not.toHaveBeenCalled();
  });

  it('resolves a business role with no matching row to null', async () => {
    const { service, businesses } = harness();

    expect(await service.viewerFor(BUSINESS_USER)).toBeNull();
    expect(businesses.findOne).toHaveBeenCalledWith({
      where: { userId: BUSINESS_USER.id },
      select: { id: true, segment: true },
    });
  });

  it('resolves a business role to its own id and segment', async () => {
    const { service, businesses } = harness();
    businesses.findOne.mockResolvedValue({
      id: 'business-1',
      segment: CustomerSegment.DISTRIBUTOR,
    });

    expect(await service.viewerFor(BUSINESS_USER)).toEqual({
      businessId: 'business-1',
      segment: CustomerSegment.DISTRIBUTOR,
    });
  });
});

describe('CartReadService.validateLines', () => {
  /**
   * The test the endpoint exists for, and the one that catches a second copy of the rules.
   *
   * `POST /cart/validate` answers about the stored cart or about lines in the body depending on the
   * request, and the checkout page can send either for the *same* basket. Two derivations of the
   * rules would let those two answers differ, on the one page that shows a basket and validates it
   * at once.
   *
   * Asserted against the figures as well as against each other: two identically broken paths agree
   * with each other perfectly.
   */
  it('answers a body basket exactly as it answers the same stored basket', async () => {
    const { service } = harness();

    const fromBody = await service.validateLines(BODY, undefined);

    expect(fromBody).toEqual(await service.validateStored(STORED, undefined));
    expect(fromBody).toEqual({
      ok: true,
      lines: [
        {
          id: 'r:almonds:250g',
          slug: 'almonds',
          unavailable: false,
          availableQty: 120,
          requestedQty: 2,
          lineTotal: 598,
        },
        {
          id: 'b:almonds:25',
          slug: 'almonds',
          unavailable: false,
          availableQty: null,
          requestedQty: 1,
          lineTotal: 21225,
        },
      ],
      // GST per line then summed, never on the aggregate: 2990 + 106125 paise.
      totals: {
        subtotal: 21823,
        gst: 1091.15,
        shipping: 0,
        total: 22914.15,
        hasQuoteLines: false,
        hasUnpriceableLines: false,
      },
    });
  });

  /**
   * Two queries for the whole basket, not two per line. A twenty-line basket is validated on every
   * step of checkout, and per-line resolution would make that forty round trips.
   */
  it('resolves the whole basket in two queries, asking about each slug once', async () => {
    const { service, products, variants } = harness();

    await service.validateLines(
      [...BODY, { slug: 'almonds', mode: 'retail', size: '500g', qty: 1 }],
      undefined,
    );

    expect(products.find).toHaveBeenCalledTimes(1);
    expect(variants.find).toHaveBeenCalledTimes(1);
    // `isPublished` is part of the criterion, not a filter applied afterwards: an unpublished
    // product must never be loaded here at all. `CartReadService and unpublished products` below is
    // where that is proved behaviourally.
    expect(products.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: [{ slug: 'almonds', isPublished: true }] }),
    );
  });

  /**
   * Reported, not thrown. `CartService.replace` raises a 422 for a slug the catalogue has lost —
   * correct there, because it refuses to store an unaccountable basket — but a 422 here would name
   * one bad line and hide the state of every other, which is the opposite of what a per-line
   * endpoint is for.
   *
   * Also pins the second `find({ where: [] })` guard. An empty OR-array is no condition at all in
   * TypeORM, so without it a basket of unknown slugs loads every variant in the catalogue before
   * answering.
   */
  it('reports an unknown slug as NOT_FOUND rather than throwing, and loads no variants', async () => {
    const { service, products, variants } = harness();
    products.find.mockResolvedValue([]);

    const result = await service.validateLines(
      [{ slug: 'ghost', mode: 'retail', size: '250g', qty: 1 }],
      undefined,
    );

    expect(result.ok).toBe(false);
    expect(result.lines[0]).toEqual({
      id: 'r:ghost:250g',
      slug: 'ghost',
      unavailable: true,
      availableQty: null,
      requestedQty: 1,
      lineTotal: null,
      code: 'NOT_FOUND',
    });
    expect(variants.find).not.toHaveBeenCalled();
  });

  it('reports a pack size the catalogue no longer carries as NOT_FOUND', async () => {
    const { service } = harness();

    const result = await service.validateLines(
      [{ slug: 'almonds', mode: 'retail', size: '5kg', qty: 1 }],
      undefined,
    );

    expect(result.lines[0]).toMatchObject({ id: 'r:almonds:5kg', code: 'NOT_FOUND' });
  });

  /**
   * `isActive` is filtered here for the same reason `CartService.resolveLines` filters it: a line
   * this route calls valid has to be a line `PUT /cart` will accept, or the customer is told their
   * basket is fine and then cannot save it.
   */
  it('ignores a deactivated variant', async () => {
    const { service, variants } = harness();
    variants.find.mockResolvedValue([{ ...VARIANT, isActive: false }]);

    const result = await service.validateLines([BODY[0] as CartLineDto], undefined);

    expect(result.lines[0]?.code).toBe('NOT_FOUND');
  });

  /** Stock is `onHand - reserved`, read live from the inventory row rather than off the variant. */
  it('reports stock net of what is reserved', async () => {
    const { service, variants } = harness();
    variants.find.mockResolvedValue([{ ...VARIANT, inventory: { onHand: 5, reserved: 3 } }]);

    const result = await service.validateLines(
      [{ slug: 'almonds', mode: 'retail', size: '250g', qty: 3 }],
      undefined,
    );

    expect(result.lines[0]).toMatchObject({
      code: 'OUT_OF_STOCK',
      availableQty: 2,
      requestedQty: 3,
    });
  });

  /**
   * A variant with no inventory row at all is out of stock, not unlimited. `?? 0` is the difference
   * between refusing an order and accepting one the warehouse cannot fill.
   */
  it('treats a variant with no inventory row as out of stock', async () => {
    const { service, variants } = harness();
    variants.find.mockResolvedValue([{ ...VARIANT, inventory: null }]);

    const result = await service.validateLines([BODY[0] as CartLineDto], undefined);

    expect(result.lines[0]).toMatchObject({ code: 'OUT_OF_STOCK', availableQty: 0 });
  });

  /** A quote line contributes nothing to the money and says why, rather than costing zero. */
  it('leaves an unpriced bulk slab out of the totals', async () => {
    const { service } = harness();

    const result = await service.validateLines(
      [{ slug: 'almonds', mode: 'bulk', kg: 50, qty: 1 }],
      undefined,
    );

    expect(result.lines[0]).toMatchObject({ code: 'QUOTE_REQUIRED', lineTotal: null });
    expect(result.totals.subtotal).toBe(0);
    expect(result.totals.hasQuoteLines).toBe(true);
  });

  /**
   * `find({ where: [] })` returns **every** product, so the empty case has to be short-circuited
   * rather than left to the query. The controller only routes a non-empty array here, which is
   * exactly why nothing else would notice.
   */
  it('asks the catalogue nothing when there are no lines to resolve', async () => {
    const { service, products, variants } = harness();

    const result = await service.validateLines([], undefined);

    expect(products.find).not.toHaveBeenCalled();
    expect(variants.find).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, lines: [], totals: EMPTY_TOTALS });
  });
});

describe('CartReadService.present', () => {
  /** One derivation behind both routes, so a cart page's totals cannot disagree with its verdict. */
  it('prices GET /cart from the same derivation as POST /cart/validate', async () => {
    const { service } = harness();

    const presented = await service.present(STORED, undefined);

    expect(presented.totals).toEqual((await service.validateStored(STORED, undefined)).totals);
  });

  it('serves the wire lines the client can address, and no prices on them', async () => {
    const { service } = harness();

    expect((await service.present(STORED, undefined)).lines).toEqual([
      { id: 'r:almonds:250g', slug: 'almonds', mode: 'retail', size: '250g', grams: 250, qty: 2 },
      { id: 'b:almonds:25', slug: 'almonds', mode: 'bulk', kg: 25, qty: 1 },
    ]);
  });

  it('answers an empty basket for a visitor who has no cart row', async () => {
    const { service } = harness();

    expect(await service.present(null, undefined)).toEqual({ lines: [], totals: EMPTY_TOTALS });
  });
});

describe('CartReadService shipping settings', () => {
  /**
   * The threshold and the flat rate come from the seeded `Setting` rows, so admin can change them
   * without a deploy. Replaced by their fallbacks nothing in this suite would notice — the same
   * finding Task 19 made about a hardcoded ₹999.
   */
  it('takes the shipping rules from the settings rows', async () => {
    const { service } = harness([
      { key: 'freeShippingThreshold', value: 100_000 },
      { key: 'flatShippingRate', value: 149 },
    ]);

    const result = await service.validateLines(
      [{ slug: 'almonds', mode: 'retail', size: '250g', qty: 2 }],
      undefined,
    );

    expect(result.totals.shipping).toBe(149);
  });

  /** And degrade to the documented defaults when the rows are absent, rather than to free. */
  it('falls back to ₹999 free-shipping and a ₹79 flat rate when the rows are missing', async () => {
    const { service } = harness();

    const result = await service.validateLines(
      [{ slug: 'almonds', mode: 'retail', size: '250g', qty: 2 }],
      undefined,
    );

    expect(result.totals.shipping).toBe(79);
  });
});

/**
 * The same product, withdrawn. Every catalogue path already treats this row as if it did not exist —
 * `catalog.service.ts`'s `baseQuery` is `WHERE product.isPublished = true` — so the basket has to as
 * well, or an admin pulling a line mid-season leaves it priced and checkout-able in every basket
 * already holding it.
 */
const UNPUBLISHED: Product = { ...PRODUCT, isPublished: false };

/** `STORED`, but for a product that has since been unpublished. The rows are unchanged. */
const STORED_UNPUBLISHED = {
  items: (STORED.items as { product: Product }[]).map((item) => ({
    ...item,
    product: UNPUBLISHED,
  })),
} as unknown as Cart;

/**
 * A harness whose product query honours the criteria it is sent, publication included.
 *
 * `harness()` answers every `find` with the same row whatever it was asked for, which is right for
 * the pricing cases and useless for this one: the answer is identical with a publication filter and
 * without it, so a test built on it would pass either way. This one matches each criterion key by
 * key and throws on one it does not recognise — the shape `cart.service.spec.ts`'s `fakeCatalogue`
 * and `fakeCartStore` both take.
 */
function filteringHarness(rows: Product[]) {
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, expected]) => {
      if (!(key in row)) throw new Error(`filteringHarness: unsupported criterion "${key}"`);
      return row[key] === expected;
    });

  const settings = { find: jest.fn().mockResolvedValue([]) };
  const products = {
    find: jest.fn(({ where }: { where: Record<string, unknown>[] }) =>
      Promise.resolve(
        rows.filter((row) =>
          where.some((criterion) => matches(row as unknown as Record<string, unknown>, criterion)),
        ),
      ),
    ),
  };
  const variants = { find: jest.fn().mockResolvedValue([VARIANT]) };
  const businesses = { findOne: jest.fn().mockResolvedValue(null) };

  return {
    service: new CartReadService(
      settings as unknown as Repository<Setting>,
      products as unknown as Repository<Product>,
      variants as unknown as Repository<ProductVariant>,
      businesses as unknown as Repository<Business>,
      new CartPricingService(),
    ),
    products,
    variants,
  };
}

describe('CartReadService and unpublished products', () => {
  /**
   * The body path answers about an unpublished slug exactly as it answers about one the catalogue has
   * never held. Compared whole, and against a second harness holding no rows at all, so the claim is
   * "the same verdict" rather than "some verdict with the right code".
   *
   * This also closes the difference `POST /wishlist/:slug` had: a route that answered differently for
   * an unpublished slug and an absent one is an oracle for which unreleased products exist.
   */
  it('reports an unpublished slug exactly as it reports an unknown one', async () => {
    const withdrawn = filteringHarness([UNPUBLISHED]);
    const absent = filteringHarness([]);

    const unpublished = await withdrawn.service.validateLines(BODY, undefined);

    expect(unpublished).toEqual(await absent.service.validateLines(BODY, undefined));
    expect(unpublished.ok).toBe(false);
    expect(unpublished.lines.map((line) => line.code)).toEqual(['NOT_FOUND', 'NOT_FOUND']);
    expect(unpublished.totals.subtotal).toBe(0);
  });

  /**
   * And it never loads the variants, which is the second half of the same filter: the product query
   * returns nothing, so the `products.length === 0` guard fires. Without it an unpublished product's
   * variants would be read and matched — a line that then priced from a variant belonging to a
   * product the loop had already decided did not exist.
   */
  it('loads no variants for a basket of unpublished slugs', async () => {
    const { service, variants } = filteringHarness([UNPUBLISHED]);

    await service.validateLines(BODY, undefined);

    expect(variants.find).not.toHaveBeenCalled();
  });

  /**
   * The positive control. A filter written as an `isPublished` test against a narrowed `select` that
   * forgot the column rejects **everything** — `undefined` is falsy — and the two tests above pass
   * identically under that mutation. This is the half that fails.
   */
  it('still prices a published product on the body path', async () => {
    const { service } = filteringHarness([PRODUCT]);

    const result = await service.validateLines(BODY, undefined);

    expect(result.ok).toBe(true);
    expect(result.totals.subtotal).toBe(21823);
  });

  /**
   * **The decision this task had to make, pinned.** A line already stored for a product that has
   * since been unpublished reads back as *unavailable* — it does not vanish.
   *
   * Vanishing was the alternative and is the wrong one here, for a reason this file is the right
   * place to record: `POST /cart/validate` answers about the stored cart or about lines in the body,
   * and the cart page uses the second to annotate lines it got from `GET /cart`. The body path
   * reports an unresolvable slug as `NOT_FOUND` — it has to, because a body verdict the client cannot
   * find reads as "no problem with that line" — so the stored path must report it too, or the same
   * basket gets two different answers from one endpoint. Dropping the row would also be silent data
   * loss: the customer is told nothing, and an admin who unpublishes for a week and republishes has
   * emptied every basket holding the product in the meantime.
   *
   * `verdictFor` already had exactly this branch. Nothing on the stored path could reach it before,
   * because `toValidatable` built `product` unconditionally from the loaded relation.
   */
  it('reads a stored line for a since-unpublished product back as unavailable', async () => {
    const { service } = filteringHarness([UNPUBLISHED]);

    const result = await service.validateStored(STORED_UNPUBLISHED, undefined);

    expect(result.ok).toBe(false);
    expect(result.lines).toEqual([
      {
        id: 'r:almonds:250g',
        slug: 'almonds',
        unavailable: true,
        availableQty: null,
        requestedQty: 2,
        lineTotal: null,
        code: 'NOT_FOUND',
      },
      {
        id: 'b:almonds:25',
        slug: 'almonds',
        unavailable: true,
        availableQty: null,
        requestedQty: 1,
        lineTotal: null,
        code: 'NOT_FOUND',
      },
    ]);
    expect(result.totals.subtotal).toBe(0);
    expect(result.totals.gst).toBe(0);
    // Unavailable, not quote-required: `cart.tsx` offers **Request Quote** and `CheckoutForm.tsx`
    // demands a GSTIN on `hasQuoteLines`, so a withdrawn product must not route a B2C basket onto
    // the business track.
    expect(result.totals.hasUnpriceableLines).toBe(true);
    expect(result.totals.hasQuoteLines).toBe(false);
  });

  /**
   * The two halves of `POST /cart/validate` agree about the same withdrawn basket, field for field.
   *
   * The one thing this endpoint cannot afford, and the reason `evaluate` exists at all. The stored
   * path reads publication off the loaded relation and the body path filters it in SQL — two
   * different mechanisms, which is exactly how they come to disagree.
   *
   * **On its own this test is not load-bearing, and was measured not to be:** before the filter
   * existed it passed, because both paths priced the withdrawn basket and agreed about that. Two
   * identically broken paths agree perfectly — the warning the docstring on `answers a body basket
   * exactly as it answers the same stored basket` already carries. It earns its place only beside the
   * case above, which asserts the figures; what it adds is that a *later* change to one path alone
   * cannot pass unnoticed.
   */
  it('answers a stored withdrawn basket exactly as it answers the same body basket', async () => {
    const { service } = filteringHarness([UNPUBLISHED]);

    expect(await service.validateStored(STORED_UNPUBLISHED, undefined)).toEqual(
      await service.validateLines(BODY, undefined),
    );
  });

  /**
   * And `GET /cart` keeps the row. The verdict above names lines by the id the browser addresses, so
   * a basket that reported `r:almonds:250g` as unavailable while omitting it from `lines` would hand
   * the cart page a verdict about a line it is not rendering — and would leave the customer no way to
   * remove the row that is blocking their checkout.
   */
  it('still serves the stored line so the verdict has something to annotate', async () => {
    const { service } = filteringHarness([UNPUBLISHED]);

    const presented = await service.present(STORED_UNPUBLISHED, undefined);

    expect(presented.lines.map((line) => line.id)).toEqual(['r:almonds:250g', 'b:almonds:25']);
    expect(presented.totals.subtotal).toBe(0);
  });

  /** The stored path's positive control: a published relation still prices, from the same harness. */
  it('still prices a stored line whose product is published', async () => {
    const { service } = filteringHarness([PRODUCT]);

    const result = await service.validateStored(STORED, undefined);

    expect(result.ok).toBe(true);
    expect(result.totals.subtotal).toBe(21823);
  });
});
