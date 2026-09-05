import { toPaise } from '@nutwala/shared';
import type { PricingTier } from '../../../entities/catalog/pricing-tier.entity';
import { CustomerSegment } from '../../../entities/enums';
import { toAdminPricingTier, type AdminPricingTierRow } from './admin-pricing-tier.mapper';

const tier = (overrides: Partial<PricingTier> = {}): PricingTier =>
  ({
    id: 'p1000000-0000-4000-8000-000000000001',
    productId: 'c1000000-0000-4000-8000-000000000001',
    minKg: '10.00',
    maxKg: '24.00',
    pricePerKgPaise: toPaise(620),
    segment: CustomerSegment.DEFAULT,
    businessId: null,
    createdAt: new Date('2026-03-01T10:00:00.000Z'),
    updatedAt: new Date('2026-03-02T10:00:00.000Z'),
    ...overrides,
  }) as unknown as PricingTier;

const row = (overrides: Partial<AdminPricingTierRow> = {}): AdminPricingTierRow => ({
  tier: tier(),
  product: {
    id: 'c1000000-0000-4000-8000-000000000001',
    slug: 'california-almonds',
    name: 'California Almonds',
  },
  business: null,
  ...overrides,
});

describe('toAdminPricingTier', () => {
  it('answers the wire contract, field for field', () => {
    expect(toAdminPricingTier(row())).toEqual({
      id: 'p1000000-0000-4000-8000-000000000001',
      productId: 'c1000000-0000-4000-8000-000000000001',
      productSlug: 'california-almonds',
      productName: 'California Almonds',
      minKg: 10,
      maxKg: 24,
      pricePerKg: 620,
      segment: 'default',
      businessId: null,
      companyName: null,
      createdAt: '2026-03-01T10:00:00.000Z',
      updatedAt: '2026-03-02T10:00:00.000Z',
    });
  });

  /**
   * **The one assertion a spread would fail**, and the field it would leak is a money one:
   * `pricePerKgPaise` beside the `pricePerKg` rupees this shape declares, two figures for one price
   * disagreeing by a factor of a hundred, on the screen whose whole job is setting prices.
   */
  it('publishes no paise column beside the rupee one', () => {
    expect(Object.keys(toAdminPricingTier(row())).sort()).toEqual([
      'businessId',
      'companyName',
      'createdAt',
      'id',
      'maxKg',
      'minKg',
      'pricePerKg',
      'productId',
      'productName',
      'productSlug',
      'segment',
      'updatedAt',
    ]);
  });

  /** `numeric(8,2)` comes back from `pg` as a string; `'10.00'` on the wire would break every
   * comparison a console makes against it. */
  it('converts the numeric bounds to numbers', () => {
    const mapped = toAdminPricingTier(row({ tier: tier({ minKg: '0.50', maxKg: '4.25' }) }));
    expect(mapped.minKg).toBe(0.5);
    expect(mapped.maxKg).toBe(4.25);
  });

  /** Brief §16's "50kg+". */
  it('carries a null maxKg as the open-ended top slab', () => {
    expect(toAdminPricingTier(row({ tier: tier({ maxKg: null }) })).maxKg).toBeNull();
  });

  /** Brief §47: a null price means the slab routes to the RFQ flow, not that it is free. */
  it('carries a null price as quote-required', () => {
    expect(
      toAdminPricingTier(row({ tier: tier({ pricePerKgPaise: null }) })).pricePerKg,
    ).toBeNull();
  });

  it('names the business on a customer-specific rung', () => {
    const mapped = toAdminPricingTier(
      row({
        tier: tier({ businessId: 'b1000000-0000-4000-8000-000000000002' }),
        business: { id: 'b1000000-0000-4000-8000-000000000002', companyName: 'Anand Sweets' },
      }),
    );
    expect(mapped.businessId).toBe('b1000000-0000-4000-8000-000000000002');
    expect(mapped.companyName).toBe('Anand Sweets');
  });

  it('maps every band the column can hold', () => {
    const bands = [
      [CustomerSegment.DEFAULT, 'default'],
      [CustomerSegment.RETAILER, 'retailer'],
      [CustomerSegment.DISTRIBUTOR, 'distributor'],
      [CustomerSegment.HORECA, 'horeca'],
    ] as const;
    for (const [column, wire] of bands) {
      expect(toAdminPricingTier(row({ tier: tier({ segment: column }) })).segment).toBe(wire);
    }
  });
});
