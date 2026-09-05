import { HttpStatus } from '@nestjs/common';
import { toPaise } from '@nutwala/shared';
import type { PricingTier } from '../../entities/catalog/pricing-tier.entity';
import { CustomerSegment } from '../../entities/enums';
import { AuditAction, AuditEntity, type AuditLogInput } from '../admin/audit-log.service';
import { AdminPricingTiersService } from './admin-pricing-tiers.service';

const PRODUCT_ID = 'c1000000-0000-4000-8000-000000000001';
const BUSINESS_ID = 'b1000000-0000-4000-8000-000000000002';
const TIER_ID = 'p1000000-0000-4000-8000-000000000001';
const ADMIN = 'f0000000-0000-4000-8000-00000000000c';

const tier = (overrides: Partial<PricingTier> = {}): PricingTier =>
  ({
    id: TIER_ID,
    productId: PRODUCT_ID,
    minKg: '10.00',
    maxKg: '24.00',
    pricePerKgPaise: toPaise(620),
    segment: CustomerSegment.DEFAULT,
    businessId: null,
    createdAt: new Date('2026-03-01T10:00:00.000Z'),
    updatedAt: new Date('2026-03-01T10:00:00.000Z'),
    ...overrides,
  }) as unknown as PricingTier;

interface Options {
  found?: PricingTier | null;
  productExists?: boolean;
  businessExists?: boolean;
  overlaps?: { id: string; minKg: string; maxKg: string | null }[];
}

/**
 * The transaction's manager, recording the raw statements as well as the repository calls.
 *
 * Both of the things this service exists to get right are raw SQL — the `FOR UPDATE` lock and the
 * overlap predicate — so a double that only recorded repository calls would measure neither.
 */
function harness(options: Options = {}) {
  const queries: { sql: string; parameters: unknown[] }[] = [];
  const saved: Record<string, unknown>[] = [];
  const updates: { criteria: unknown; patch: unknown }[] = [];

  const manager = {
    query: (sql: string, parameters: unknown[]) => {
      queries.push({ sql, parameters });
      if (sql.includes('FOR UPDATE')) {
        return Promise.resolve(options.productExists === false ? [] : [{ id: PRODUCT_ID }]);
      }
      return Promise.resolve(options.overlaps ?? []);
    },
    getRepository: (entity: { name: string }) => ({
      findOne: () => {
        if (entity.name === 'Business') {
          return Promise.resolve(options.businessExists === false ? null : { id: BUSINESS_ID });
        }
        return Promise.resolve(options.found ?? null);
      },
      find: () =>
        Promise.resolve(
          entity.name === 'Product'
            ? [{ id: PRODUCT_ID, slug: 'california-almonds', name: 'California Almonds' }]
            : [{ id: BUSINESS_ID, companyName: 'Anand Sweets' }],
        ),
      create: (row: Record<string, unknown>) => row,
      save: (row: Record<string, unknown>) => {
        saved.push(row);
        return Promise.resolve({ ...tier(), ...row, id: TIER_ID });
      },
      update: (criteria: unknown, patch: unknown) => {
        updates.push({ criteria, patch });
        return Promise.resolve({ affected: 1 });
      },
    }),
  };

  const dataSource = {
    manager,
    getRepository: manager.getRepository,
    transaction: <T>(run: (m: unknown) => Promise<T>) => run(manager),
  };

  const audited: AuditLogInput[] = [];
  const auditManagers: unknown[] = [];
  const audit = {
    record: (givenManager: unknown, input: AuditLogInput) => {
      auditManagers.push(givenManager);
      audited.push(input);
      return Promise.resolve();
    },
  };

  return {
    service: new AdminPricingTiersService(dataSource as never, audit),
    queries,
    saved,
    updates,
    audited,
    auditManagers,
    manager,
  };
}

const body = (overrides: Record<string, unknown> = {}) => ({
  productId: PRODUCT_ID,
  minKg: 10,
  maxKg: 24,
  pricePerKg: 620,
  actorUserId: ADMIN,
  ...overrides,
});

describe('AdminPricingTiersService.create', () => {
  it('writes the rung with its numeric bounds as strings and its price as paise', async () => {
    const context = harness();

    await context.service.create(body());

    expect(context.saved).toEqual([
      {
        productId: PRODUCT_ID,
        minKg: '10',
        maxKg: '24',
        pricePerKgPaise: toPaise(620),
        segment: CustomerSegment.DEFAULT,
        businessId: null,
      },
    ]);
  });

  /**
   * Read-then-write under `READ COMMITTED` is not enough on its own: two operators adding 10–24 and
   * 20–30 at the same moment would each read a ladder without the other's row and both would pass.
   * The `products` row is the smallest thing that can be locked and still cover the question.
   */
  it('locks the product row before it looks at the ladder', async () => {
    const context = harness();

    await context.service.create(body());

    expect(context.queries[0]?.sql).toContain('FOR UPDATE');
    expect(context.queries[0]?.parameters).toEqual([PRODUCT_ID]);
    expect(context.queries[1]?.sql).toContain('FROM pricing_tiers');
  });

  it('answers 404 for a product that does not exist, rather than a foreign-key error', async () => {
    const context = harness({ productExists: false });

    await expect(context.service.create(body() as never)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: HttpStatus.NOT_FOUND,
    });
    expect(context.saved).toEqual([]);
  });

  it('answers 404 for a business that does not exist', async () => {
    const context = harness({ businessExists: false });

    await expect(
      context.service.create(body({ businessId: BUSINESS_ID }) as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(context.saved).toEqual([]);
  });

  it('refuses a range whose maximum is below its minimum', async () => {
    const context = harness();

    await expect(
      context.service.create(body({ minKg: 24, maxKg: 10 }) as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: HttpStatus.BAD_REQUEST });
    expect(context.saved).toEqual([]);
  });

  /**
   * **The judgement plan 9.3 left open.** `bulkTierFor` takes the first rung whose range contains
   * the weight, so two overlapping rungs make the price depend on row order — and
   * `CheckoutService.place` snapshots the resolved rate onto the invoice.
   */
  it('refuses an overlapping rung with 409, naming the rung in the way', async () => {
    const context = harness({ overlaps: [{ id: 'other', minKg: '20.00', maxKg: '30.00' }] });

    const thrown: unknown = await context.service
      .create(body() as never)
      .then(() => undefined)
      .catch((error: unknown) => error);
    const refusal = thrown as { code?: string; details?: Record<string, unknown> };

    expect(refusal.code).toBe('PRICING_TIER_OVERLAP');
    expect(refusal.details).toMatchObject({
      conflictingTierId: 'other',
      conflictingMinKg: 20,
      conflictingMaxKg: 30,
      minKg: 10,
      maxKg: 24,
    });
    expect(context.saved).toEqual([]);
    expect(context.audited).toEqual([]);
  });

  /**
   * **`resolveTiers`' own grouping, not `(product, segment, business)`.** Its first rung filters on
   * `businessId` alone and never looks at the band, so every rung of one business on one product is
   * on the same ladder however its segment is set — and a check keyed on all three columns would
   * let exactly that overlap through.
   */
  it('scopes a business rung by business alone, ignoring its band', async () => {
    const context = harness();

    await context.service.create(body({ businessId: BUSINESS_ID, segment: 'retailer' }));

    const probe = context.queries.find((entry) => entry.sql.includes('FROM pricing_tiers'));
    expect(probe?.sql).toContain('business_id = $3');
    expect(probe?.sql).not.toContain('segment = $3');
    expect(probe?.parameters[2]).toBe(BUSINESS_ID);
  });

  it('scopes an unscoped rung by band, and only against other unscoped rungs', async () => {
    const context = harness();

    await context.service.create(body({ segment: 'horeca' }));

    const probe = context.queries.find((entry) => entry.sql.includes('FROM pricing_tiers'));
    expect(probe?.sql).toContain('business_id IS NULL AND segment = $3');
    expect(probe?.parameters[2]).toBe(CustomerSegment.HORECA);
  });

  /** Two ranges meet when each starts at or before the other ends, with a null `maxKg` meaning "no
   * end" on either side. The comparison is left to the database, in `numeric`. */
  it('asks the database for the meeting condition, both open ends included', async () => {
    const context = harness();

    await context.service.create(body({ maxKg: null }));

    const probe = context.queries.find((entry) => entry.sql.includes('FROM pricing_tiers'));
    expect(probe?.sql).toContain('"maxKg" IS NULL OR "maxKg" >= $4::numeric');
    expect(probe?.sql).toContain('$5::numeric IS NULL OR "minKg" <= $5::numeric');
    expect(probe?.parameters[3]).toBe(10);
    expect(probe?.parameters[4]).toBeNull();
  });

  it('records the create on this transaction’s manager, with paise as a string', async () => {
    const context = harness();

    await context.service.create(body());

    expect(context.audited).toEqual([
      {
        actorUserId: ADMIN,
        action: AuditAction.PRICING_TIER_CREATE,
        entityType: AuditEntity.PRICING_TIER,
        entityId: TIER_ID,
        after: {
          productId: PRODUCT_ID,
          minKg: 10,
          maxKg: 24,
          pricePerKgPaise: '62000',
          segment: CustomerSegment.DEFAULT,
          businessId: null,
        },
      },
    ]);
    expect(context.auditManagers).toEqual([context.manager]);
    expect(() => JSON.stringify(context.audited)).not.toThrow();
  });

  /** Brief §47: a null price is a quote-required slab, not an unset one. */
  it('stores a null price rather than treating it as unset', async () => {
    const context = harness();
    await context.service.create(body({ pricePerKg: null }));
    expect(context.saved[0]).toMatchObject({ pricePerKgPaise: null });
  });
});

describe('AdminPricingTiersService.update', () => {
  it('answers 404 for a tier that does not exist', async () => {
    const context = harness({ found: null });

    await expect(context.service.update(TIER_ID, { actorUserId: ADMIN })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: HttpStatus.NOT_FOUND,
    });
  });

  /** Plan 9.1's rule: a write that changes nothing leaves no trace. The diff is over the *stored*
   * values, because `10` arrives and `'10.00'` is stored — comparing the two forms would report a
   * change on every request. */
  it('writes nothing when every field already holds the value it was sent', async () => {
    const context = harness({ found: tier() });

    await context.service.update(TIER_ID, {
      minKg: 10,
      maxKg: 24,
      pricePerKg: 620,
      actorUserId: ADMIN,
    });

    expect(context.updates).toEqual([]);
    expect(context.audited).toEqual([]);
  });

  it('records only the fields that changed', async () => {
    const context = harness({ found: tier() });

    await context.service.update(TIER_ID, { pricePerKg: 590, actorUserId: ADMIN });

    expect(context.audited).toEqual([
      {
        actorUserId: ADMIN,
        action: AuditAction.PRICING_TIER_UPDATE,
        entityType: AuditEntity.PRICING_TIER,
        entityId: TIER_ID,
        before: { pricePerKgPaise: '62000' },
        after: { pricePerKgPaise: '59000' },
      },
    ]);
  });

  /** Moving a rung's `maxKg` up can collide with its neighbour just as surely as creating a new
   * one, so the check runs against the merged rung rather than the patch. */
  it('checks the merged rung, not the patch, and excludes the rung being edited', async () => {
    const context = harness({ found: tier() });

    await context.service.update(TIER_ID, { maxKg: 40, actorUserId: ADMIN });

    const probe = context.queries.find((entry) => entry.sql.includes('FROM pricing_tiers'));
    expect(probe?.parameters[1]).toBe(TIER_ID);
    expect(probe?.parameters[3]).toBe(10);
    expect(probe?.parameters[4]).toBe(40);
  });

  it('refuses to move a rung into an overlap and writes nothing', async () => {
    const context = harness({
      found: tier(),
      overlaps: [{ id: 'other', minKg: '25.00', maxKg: null }],
    });

    await expect(
      context.service.update(TIER_ID, { maxKg: 40, actorUserId: ADMIN }),
    ).rejects.toMatchObject({ code: 'PRICING_TIER_OVERLAP', status: HttpStatus.CONFLICT });

    expect(context.updates).toEqual([]);
    expect(context.audited).toEqual([]);
  });

  /** A rung created against the wrong product is otherwise unfixable, since §6.4 gives this
   * resource no `DELETE`. Moving it re-asks the overlap question against the destination ladder. */
  it('lets a rung move to another product, re-checking the destination ladder', async () => {
    const other = 'c1000000-0000-4000-8000-0000000000ff';
    const context = harness({ found: tier() });

    await context.service.update(TIER_ID, { productId: other, actorUserId: ADMIN });

    expect(context.queries[0]?.parameters).toEqual([other]);
    expect(context.audited[0]?.after).toEqual({ productId: other });
  });
});
