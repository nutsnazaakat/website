import { CustomerSegment } from '../../entities/enums';
import type { PricingTier } from '../../entities/catalog/pricing-tier.entity';
import { resolveTiers, resolveTiersForWeight, type PricingViewer } from './pricing.resolver';

/** A `DEFAULT`, business-null tier by default — the shape all 135 seeded rows share today. */
function tier(overrides: Partial<PricingTier> = {}): PricingTier {
  return {
    minKg: '1',
    maxKg: null,
    pricePerKgPaise: 70000n,
    segment: CustomerSegment.DEFAULT,
    businessId: null,
    ...overrides,
  } as unknown as PricingTier;
}

function viewer(overrides: Partial<PricingViewer> = {}): PricingViewer {
  return { businessId: 'biz-mine', segment: CustomerSegment.DEFAULT, ...overrides };
}

describe('resolveTiers', () => {
  it('a public viewer (null) resolves only DEFAULT, business-null tiers', () => {
    const own = tier({ minKg: '1', maxKg: '24', pricePerKgPaise: 70000n });
    const retailer = tier({
      minKg: '1',
      maxKg: '24',
      pricePerKgPaise: 65000n,
      segment: CustomerSegment.RETAILER,
    });
    const scoped = tier({
      minKg: '1',
      maxKg: '24',
      pricePerKgPaise: 62000n,
      businessId: 'biz-other',
    });

    expect(resolveTiers({ pricingTiers: [own, retailer, scoped] }, null)).toEqual([own]);
  });

  /**
   * The no-op guarantee this milestone rests on: every existing business is `DEFAULT` and every
   * seeded tier is `DEFAULT`/null, so a signed-in `DEFAULT` business must resolve to exactly what
   * a guest resolves to, or Milestone 7 would change somebody's prices on day one.
   */
  it('a DEFAULT-segment business resolves the same rows as a public viewer — the no-op guarantee', () => {
    const tiers = [
      tier({ minKg: '1', maxKg: '24' }),
      tier({
        minKg: '25',
        maxKg: null,
        segment: CustomerSegment.RETAILER,
        pricePerKgPaise: 60000n,
      }),
    ];

    expect(resolveTiers({ pricingTiers: tiers }, viewer())).toEqual(
      resolveTiers({ pricingTiers: tiers }, null),
    );
  });

  it('a RETAILER business resolves the RETAILER ladder, not DEFAULT', () => {
    const defaultTier = tier({ minKg: '1', maxKg: null, pricePerKgPaise: 70000n });
    const retailerTier = tier({
      minKg: '1',
      maxKg: null,
      pricePerKgPaise: 62000n,
      segment: CustomerSegment.RETAILER,
    });

    expect(
      resolveTiers(
        { pricingTiers: [defaultTier, retailerTier] },
        viewer({ segment: CustomerSegment.RETAILER }),
      ),
    ).toEqual([retailerTier]);
  });

  /**
   * "Even where DEFAULT is cheaper" is the case that stops someone "improving" the resolver into
   * a `Math.min` across rungs — a business's own agreed rate wins outright, not the lower figure.
   */
  it('a business with its own tiers resolves only those, even where DEFAULT is cheaper', () => {
    const cheaperDefault = tier({ minKg: '1', maxKg: null, pricePerKgPaise: 50000n });
    const ownDearerTier = tier({
      minKg: '1',
      maxKg: null,
      pricePerKgPaise: 90000n,
      businessId: 'biz-mine',
    });

    expect(resolveTiers({ pricingTiers: [cheaperDefault, ownDearerTier] }, viewer())).toEqual([
      ownDearerTier,
    ]);
  });

  /**
   * The ladder-integrity rule. A business's own ladder that covers only 1–20kg must come back
   * exactly as agreed — never topped up with `DEFAULT`'s 21–50kg rows — because a spliced ladder
   * would let a 30kg order cost more per kilo than a 10kg order from the same buyer.
   */
  it('a business with its own tiers does NOT get its own merged with DEFAULT', () => {
    const own = tier({ minKg: '1', maxKg: '20', pricePerKgPaise: 62000n, businessId: 'biz-mine' });
    const wideDefault = tier({ minKg: '1', maxKg: '50', pricePerKgPaise: 70000n });

    const resolved = resolveTiers({ pricingTiers: [own, wideDefault] }, viewer());
    expect(resolved).toEqual([own]);
    expect(resolved).not.toContain(wideDefault);
  });

  it('a DEFAULT-segment tier scoped to another business never appears', () => {
    const mine = tier({ minKg: '1', maxKg: '24' });
    const someoneElses = tier({
      minKg: '1',
      maxKg: '24',
      pricePerKgPaise: 55000n,
      businessId: 'biz-other',
    });

    expect(resolveTiers({ pricingTiers: [mine, someoneElses] }, viewer())).toEqual([mine]);
  });

  it('a RETAILER tier scoped to another business never appears', () => {
    const defaultTier = tier({ minKg: '1', maxKg: null });
    const someoneElsesRetailerTier = tier({
      minKg: '1',
      maxKg: null,
      pricePerKgPaise: 55000n,
      segment: CustomerSegment.RETAILER,
      businessId: 'biz-other',
    });

    expect(
      resolveTiers(
        { pricingTiers: [defaultTier, someoneElsesRetailerTier] },
        viewer({ segment: CustomerSegment.RETAILER }),
      ),
    ).toEqual([defaultTier]);
  });

  it('a business whose segment has no tiers falls through to DEFAULT', () => {
    const defaultTier = tier({ minKg: '1', maxKg: null, pricePerKgPaise: 70000n });

    expect(
      resolveTiers({ pricingTiers: [defaultTier] }, viewer({ segment: CustomerSegment.HORECA })),
    ).toEqual([defaultTier]);
  });

  it('a product with no tiers at all resolves to []', () => {
    expect(resolveTiers({ pricingTiers: [] }, null)).toEqual([]);
    expect(resolveTiers({ pricingTiers: [] }, viewer())).toEqual([]);
  });

  it('tiers come back ordered by minKg regardless of insertion order', () => {
    const twentyFive = tier({ minKg: '25', maxKg: '49' });
    const one = tier({ minKg: '1', maxKg: '24' });
    const fifty = tier({ minKg: '50', maxKg: null });

    expect(resolveTiers({ pricingTiers: [fifty, one, twentyFive] }, null)).toEqual([
      one,
      twentyFive,
      fifty,
    ]);
  });
});

describe('resolveTiersForWeight', () => {
  /** A business's own ladder, capped at 20kg — the shape Task 6's 30kg row needs. */
  const ownLadder = (businessId: string) => [
    tier({ minKg: '1', maxKg: '10', pricePerKgPaise: 62000n, businessId }),
    tier({ minKg: '11', maxKg: '20', pricePerKgPaise: 58000n, businessId }),
  ];
  const defaultLadder = [
    tier({ minKg: '1', maxKg: '24', pricePerKgPaise: 70000n }),
    tier({ minKg: '25', maxKg: '49', pricePerKgPaise: 68000n }),
    tier({ minKg: '50', maxKg: null, pricePerKgPaise: 65000n }),
  ];

  it('a weight inside the viewer’s own ladder uses that ladder', () => {
    const product = { pricingTiers: [...ownLadder('biz-mine'), ...defaultLadder] };

    expect(resolveTiersForWeight(product, viewer(), 5)).toEqual(ownLadder('biz-mine'));
  });

  /** The floor, preserved: below the ladder's own minimum still counts as covered. */
  it('a weight below the viewer’s own ladder’s minimum still uses that ladder', () => {
    const product = {
      pricingTiers: [
        tier({ minKg: '5', maxKg: '20', pricePerKgPaise: 62000n, businessId: 'biz-mine' }),
        ...defaultLadder,
      ],
    };

    const resolved = resolveTiersForWeight(product, viewer(), 1);
    expect(resolved).toEqual([
      tier({ minKg: '5', maxKg: '20', pricePerKgPaise: 62000n, businessId: 'biz-mine' }),
    ]);
  });

  /**
   * The whole point of the composition. 30kg is above the business's own 20kg ceiling, so the
   * entire ladder swaps to DEFAULT — never a merge of the two, and never the business's own
   * cheapest rung reused past where it was agreed.
   */
  it('a weight above the viewer’s own ladder’s ceiling falls through to DEFAULT', () => {
    const product = { pricingTiers: [...ownLadder('biz-mine'), ...defaultLadder] };

    const resolved = resolveTiersForWeight(product, viewer(), 30);
    expect(resolved).toEqual(defaultLadder);
    expect(resolved).not.toEqual(expect.arrayContaining(ownLadder('biz-mine')));
  });

  it('a public viewer’s ladder IS DEFAULT, so nothing ever falls through for one', () => {
    const product = { pricingTiers: defaultLadder };

    expect(resolveTiersForWeight(product, null, 500)).toEqual(defaultLadder);
  });

  it('an open-ended top tier (maxKg: null) never falls through, at any weight', () => {
    const openEnded = [
      tier({ minKg: '1', maxKg: '20', pricePerKgPaise: 62000n, businessId: 'biz-mine' }),
      tier({ minKg: '21', maxKg: null, pricePerKgPaise: 58000n, businessId: 'biz-mine' }),
    ];
    const product = { pricingTiers: [...openEnded, ...defaultLadder] };

    expect(resolveTiersForWeight(product, viewer(), 10_000)).toEqual(openEnded);
  });
});
