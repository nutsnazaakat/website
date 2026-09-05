import { HttpStatus, Injectable } from '@nestjs/common';
import {
  toPaise,
  type AdminPricingTier,
  type CustomerSegment,
  type Paginated,
} from '@nutwala/shared';
import { DataSource, In, type EntityManager } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { PricingTier } from '../../entities/catalog/pricing-tier.entity';
import { Product } from '../../entities/catalog/product.entity';
import { CustomerSegment as CustomerSegmentEnum } from '../../entities/enums';
import { Business } from '../../entities/identity/business.entity';
import { AuditAction, AuditEntity, AuditLogService } from '../admin/audit-log.service';
import type { AdminPricingTierQueryDto } from './dto/admin-pricing-tier-query.dto';
import type { CreatePricingTierDto, UpdatePricingTierDto } from './dto/save-pricing-tier.dto';
import { toAdminPricingTier, type AdminPricingTierRow } from './mappers/admin-pricing-tier.mapper';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

/** The wire band a body or a filter names, mapped to the column's enum. Never `toUpperCase()`:
 * `@IsIn` has already refused anything outside `CUSTOMER_SEGMENTS`, and this is the map that cannot
 * grow on one side alone. */
const SEGMENT: Record<CustomerSegment, CustomerSegmentEnum> = {
  default: CustomerSegmentEnum.DEFAULT,
  retailer: CustomerSegmentEnum.RETAILER,
  distributor: CustomerSegmentEnum.DISTRIBUTOR,
  horeca: CustomerSegmentEnum.HORECA,
};

/** The fields a rung is made of, in the units the column stores them in — the shape both writes
 * converge on before anything is validated or compared. */
interface TierFields {
  productId: string;
  minKg: number;
  maxKg: number | null;
  pricePerKgPaise: bigint | null;
  segment: CustomerSegmentEnum;
  businessId: string | null;
}

/** What the overlap probe answers: enough to name the rung that is in the way. */
interface OverlapRow {
  id: string;
  minKg: string;
  maxKg: string | null;
}

/**
 * The audit payload for a rung, with money as a **string**.
 *
 * `audit_logs.before`/`.after` are jsonb, and `JSON.stringify` **throws** on a bigint rather than
 * dropping it — so a raw paise value here would fail the whole transaction at the driver. Rupees
 * would be the other option and are worse: the trail would then disagree with the column it
 * describes. `AdminRfqsService.update` records the same trap for `expectedValuePaise`.
 */
interface TierSnapshot {
  productId: string;
  minKg: number;
  maxKg: number | null;
  pricePerKgPaise: string | null;
  segment: CustomerSegmentEnum;
  businessId: string | null;
}

/**
 * A rung in the shape the columns take it.
 *
 * `minKg` and `maxKg` are `numeric(8,2)` and TypeORM types them `string`, deliberately — a
 * `numeric` handed through a JS number is a float, and `10.005` is not representable. Every write
 * goes through here so the conversion happens once, at the boundary, rather than at each call site
 * with a different idea of how to round.
 */
function toColumns(fields: TierFields): {
  productId: string;
  minKg: string;
  maxKg: string | null;
  pricePerKgPaise: bigint | null;
  segment: CustomerSegmentEnum;
  businessId: string | null;
} {
  return {
    productId: fields.productId,
    minKg: String(fields.minKg),
    maxKg: fields.maxKg === null ? null : String(fields.maxKg),
    pricePerKgPaise: fields.pricePerKgPaise,
    segment: fields.segment,
    businessId: fields.businessId,
  };
}

function snapshot(fields: TierFields): TierSnapshot {
  return {
    productId: fields.productId,
    minKg: fields.minKg,
    maxKg: fields.maxKg,
    pricePerKgPaise: fields.pricePerKgPaise === null ? null : String(fields.pricePerKgPaise),
    segment: fields.segment,
    businessId: fields.businessId,
  };
}

function diff(
  before: TierSnapshot,
  after: TierSnapshot,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  for (const key of Object.keys(before) as (keyof TierSnapshot)[]) {
    if (before[key] === after[key]) continue;
    changedBefore[key] = before[key];
    changedAfter[key] = after[key];
  }

  return Object.keys(changedAfter).length === 0
    ? null
    : { before: changedBefore, after: changedAfter };
}

/**
 * `GET`, `POST` and `PATCH /admin/pricing-tiers` — spec §6.4, brief §31.
 *
 * **No `DELETE`, because §6.4 lists three verbs for this resource and no fourth.** It is also the
 * awkward one to get right: a rung is not referenced by anything (`order_items` snapshots the rate
 * it charged), so deleting one would not be refused by the database — it would just silently change
 * what every future order of that weight costs, with no trace beyond an audit row. Removing a rung
 * today means widening its neighbour, which is a `PATCH` and leaves the ladder complete. Reported
 * rather than invented: if a genuine delete is wanted it needs its own decision about what happens
 * to the gap it leaves.
 *
 * **Overlapping rungs are refused, and this is the judgement plan 9.3 left open.**
 * `pricing.resolver.ts` is what has to live with the answer, and it decides nothing about overlap:
 * `resolveTiers` picks one ladder for a viewer and sorts it ascending by `minKg`, then
 * `bulkTierFor` returns the **first** rung whose `[minKg, maxKg]` contains the weight. So two
 * overlapping rungs make the answer depend on order — on `minKg` where they differ, and on the
 * order the driver happened to return the rows where they do not, since `Array.prototype.sort` is
 * stable and nothing in the query orders them. That is not a display problem:
 * `CheckoutService.place` snapshots the resolved rate onto the `order_items` row, so the same
 * basket can be invoiced at two different prices depending on which row Postgres returned first.
 * Refusing the write is the only place the problem can be solved once; the alternative — teaching
 * the resolver to pick "the cheapest" or "the narrowest" — would put a rule in the reader that the
 * operator never expressed, and would still leave two rows an operator has to reconcile by eye.
 *
 * **What counts as the same ladder is `resolveTiers`' own grouping, not `(product, segment,
 * business)`.** Its first rung filters on `businessId` **alone** and never looks at the band, so a
 * business holding one `DEFAULT` rung and one `RETAILER` rung has both in the same resolved ladder
 * — and a naive uniqueness check on all three columns would let exactly that overlap through. So:
 * a business-scoped rung is compared against every other rung of that business on that product,
 * whatever its segment; an unscoped rung is compared against the unscoped rungs of the same segment.
 * See `overlappingWith`.
 */
@Injectable()
export class AdminPricingTiersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * `GET /admin/pricing-tiers` — one product's ladder, one band, or one business's negotiated rates.
   *
   * **Ordered by product, then band, then business, then `minKg`, then `id`.** The first four are
   * the shape an operator reads a ladder in; `id` is the tiebreak that makes the order *total*,
   * which paging needs — and unlike every other list here the natural key genuinely can repeat, so
   * the tiebreak is not a precaution against transaction-time timestamps but against two rungs that
   * are legitimately identical in every ordered column.
   */
  async list(query: AdminPricingTierQueryDto): Promise<Paginated<AdminPricingTier>> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)));

    const builder = this.dataSource.getRepository(PricingTier).createQueryBuilder('tier');

    if (query.productId !== undefined) {
      builder.andWhere('tier.productId = :productId', { productId: query.productId });
    }
    if (query.segment !== undefined) {
      builder.andWhere('tier.segment = :segment', { segment: SEGMENT[query.segment] });
    }
    if (query.businessId === 'none') {
      builder.andWhere('tier.businessId IS NULL');
    } else if (query.businessId !== undefined) {
      builder.andWhere('tier.businessId = :businessId', { businessId: query.businessId });
    }

    const [rows, total] = await builder
      .orderBy('tier.productId', 'ASC')
      .addOrderBy('tier.segment', 'ASC')
      .addOrderBy('tier.businessId', 'ASC', 'NULLS FIRST')
      .addOrderBy('tier.minKg', 'ASC')
      .addOrderBy('tier.id', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const assembled = await this.assemble(this.dataSource.manager, rows);
    return { items: assembled.map(toAdminPricingTier), total, page, limit };
  }

  /** `POST /admin/pricing-tiers` — a new rung, refused if it overlaps one already on the ladder. */
  async create(input: CreatePricingTierDto & { actorUserId: string }): Promise<AdminPricingTier> {
    return this.dataSource.transaction(async (manager) => {
      const fields: TierFields = {
        productId: input.productId,
        minKg: input.minKg,
        maxKg: input.maxKg,
        // Rupees in, paise stored — spec §8's boundary, converted once and never re-derived.
        pricePerKgPaise: input.pricePerKg === null ? null : toPaise(input.pricePerKg),
        segment: SEGMENT[input.segment ?? 'default'],
        businessId: input.businessId ?? null,
      };

      await this.assertLadderIsWritable(manager, fields, null);

      const tiers = manager.getRepository(PricingTier);
      const created = await tiers.save(tiers.create(toColumns(fields)));

      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: AuditAction.PRICING_TIER_CREATE,
        entityType: AuditEntity.PRICING_TIER,
        entityId: created.id,
        // A create has no `before` — `AuditLogInput` says so, and the column stores null.
        after: { ...snapshot(fields) },
      });

      const [row] = await this.assemble(manager, [created]);
      if (row === undefined) throw new Error(`Pricing tier ${created.id} could not be read back`);
      return toAdminPricingTier(row);
    });
  }

  /**
   * `PATCH /admin/pricing-tiers/:id` — an omitted field is left unchanged.
   *
   * **A rung that changes nothing writes no audit row**, plan 9.1's rule, and the diff is over the
   * *stored* values rather than the request: `minKg` arrives as `10` and is stored as `'10.00'`, so
   * comparing the two forms would report a change on every request. `TierSnapshot` is the one shape
   * both sides are reduced to.
   *
   * The overlap check runs against the **merged** rung, not the patch: moving a rung's `maxKg` up
   * can collide with its neighbour just as surely as creating a new one, and moving its
   * `productId`, `segment` or `businessId` re-asks the question against a different ladder
   * entirely.
   */
  async update(
    id: string,
    input: UpdatePricingTierDto & { actorUserId: string },
  ): Promise<AdminPricingTier> {
    return this.dataSource.transaction(async (manager) => {
      const tier = await manager.getRepository(PricingTier).findOne({ where: { id } });
      if (tier === null) {
        throw new DomainError(ErrorCodes.NOT_FOUND, 'No such pricing tier.', HttpStatus.NOT_FOUND, {
          pricingTierId: id,
        });
      }

      const before: TierFields = {
        productId: tier.productId,
        minKg: Number(tier.minKg),
        maxKg: tier.maxKg === null ? null : Number(tier.maxKg),
        pricePerKgPaise: tier.pricePerKgPaise,
        segment: tier.segment,
        businessId: tier.businessId,
      };

      const after: TierFields = {
        productId: input.productId ?? before.productId,
        minKg: input.minKg ?? before.minKg,
        maxKg: input.maxKg === undefined ? before.maxKg : input.maxKg,
        pricePerKgPaise:
          input.pricePerKg === undefined
            ? before.pricePerKgPaise
            : input.pricePerKg === null
              ? null
              : toPaise(input.pricePerKg),
        segment: input.segment === undefined ? before.segment : SEGMENT[input.segment],
        businessId: input.businessId === undefined ? before.businessId : input.businessId,
      };

      await this.assertLadderIsWritable(manager, after, tier.id);

      const changed = diff(snapshot(before), snapshot(after));
      if (changed !== null) {
        await manager.getRepository(PricingTier).update({ id: tier.id }, toColumns(after));
        await this.audit.record(manager, {
          actorUserId: input.actorUserId,
          action: AuditAction.PRICING_TIER_UPDATE,
          entityType: AuditEntity.PRICING_TIER,
          entityId: tier.id,
          before: changed.before,
          after: changed.after,
        });
      }

      const reread = await manager.getRepository(PricingTier).findOne({ where: { id: tier.id } });
      if (reread === null) throw new Error(`Pricing tier ${id} was written but could not be read`);
      const [row] = await this.assemble(manager, [reread]);
      if (row === undefined) throw new Error(`Pricing tier ${id} could not be read back`);
      return toAdminPricingTier(row);
    });
  }

  /**
   * Everything a rung has to satisfy before it is written: the product exists, the business exists,
   * the range is a range, and nothing already on its ladder overlaps it.
   *
   * **The product row is locked `FOR UPDATE` first, and that is what makes the overlap check
   * hold under concurrency.** Read-then-write under `READ COMMITTED` is not enough on its own: two
   * operators adding 10–24 and 20–30 at the same moment would each read a ladder without the
   * other's row and both would pass. Taking a row lock on `products` serialises every tier write for
   * one product, which is the smallest thing that can be locked and still cover the question — the
   * ladder has no row of its own to lock, and locking the existing `pricing_tiers` rows would not
   * stop a concurrent *insert*. The lock also does the existence check, so a tier for a product
   * nobody has is a 404 rather than a foreign-key error.
   */
  private async assertLadderIsWritable(
    manager: EntityManager,
    fields: TierFields,
    exceptId: string | null,
  ): Promise<void> {
    const locked = await manager.query<{ id: string }[]>(
      'SELECT id FROM products WHERE id = $1 FOR UPDATE',
      [fields.productId],
    );
    if (locked.length === 0) {
      throw new DomainError(ErrorCodes.NOT_FOUND, 'No such product.', HttpStatus.NOT_FOUND, {
        productId: fields.productId,
      });
    }

    if (fields.businessId !== null) {
      const business = await manager
        .getRepository(Business)
        .findOne({ where: { id: fields.businessId }, select: { id: true } });
      if (business === null) {
        throw new DomainError(ErrorCodes.NOT_FOUND, 'No such business.', HttpStatus.NOT_FOUND, {
          businessId: fields.businessId,
        });
      }
    }

    if (fields.maxKg !== null && fields.maxKg < fields.minKg) {
      throw new DomainError(
        ErrorCodes.VALIDATION_FAILED,
        'A tier’s maximum quantity cannot be below its minimum.',
        HttpStatus.BAD_REQUEST,
        { minKg: fields.minKg, maxKg: fields.maxKg },
      );
    }

    const clash = await this.overlappingWith(manager, fields, exceptId);
    if (clash !== undefined) {
      throw new DomainError(
        ErrorCodes.PRICING_TIER_OVERLAP,
        'Another tier already covers part of that quantity range.',
        HttpStatus.CONFLICT,
        {
          conflictingTierId: clash.id,
          conflictingMinKg: Number(clash.minKg),
          conflictingMaxKg: clash.maxKg === null ? null : Number(clash.maxKg),
          minKg: fields.minKg,
          maxKg: fields.maxKg,
        },
      );
    }
  }

  /**
   * The rung on this ladder whose quantity range meets the given one, if any.
   *
   * **The scope predicate is `resolveTiers`' own grouping**, and getting it from the resolver rather
   * than from the columns is the point. A business-scoped rung is resolved by `businessId` alone —
   * that function's first rung never looks at the band — so every rung of that business on that
   * product is on the same ladder however its `segment` is set. An unscoped rung is resolved by
   * `(businessId IS NULL, segment)`, so it competes only with the unscoped rungs of its own band.
   * Grouping by all three columns instead would let a business hold overlapping `DEFAULT` and
   * `RETAILER` rungs, which is exactly the case the resolver would then answer by row order.
   *
   * Two ranges meet when each starts at or before the other ends, with a null `maxKg` meaning "no
   * end" on either side. Written as a predicate rather than fetched-and-filtered so the database
   * does the comparison in `numeric`, where the columns live — `Number('10.00') <= Number('9.995')`
   * is the kind of question a float should not be asked.
   */
  private async overlappingWith(
    manager: EntityManager,
    fields: TierFields,
    exceptId: string | null,
  ): Promise<OverlapRow | undefined> {
    const scope =
      fields.businessId === null ? 'business_id IS NULL AND segment = $3' : 'business_id = $3';
    const scopeValue = fields.businessId ?? fields.segment;

    const rows = await manager.query<OverlapRow[]>(
      `SELECT id, "minKg"::text AS "minKg", "maxKg"::text AS "maxKg"
         FROM pricing_tiers
        WHERE product_id = $1
          AND ${scope}
          AND ($2::uuid IS NULL OR id <> $2::uuid)
          AND ("maxKg" IS NULL OR "maxKg" >= $4::numeric)
          AND ($5::numeric IS NULL OR "minKg" <= $5::numeric)
        ORDER BY "minKg"
        LIMIT 1`,
      [fields.productId, exceptId, scopeValue, fields.minKg, fields.maxKg],
    );

    return rows[0];
  }

  /**
   * The product and, where there is one, the business behind each rung — read in two statements for
   * the whole page rather than two per row.
   *
   * `product_id` is `ON DELETE CASCADE` and `business_id` is too, so neither can be missing while
   * the tier exists; a missing product is therefore a real error rather than a row to render
   * without a name.
   */
  private async assemble(
    manager: EntityManager,
    tiers: PricingTier[],
  ): Promise<AdminPricingTierRow[]> {
    if (tiers.length === 0) return [];

    const productIds = [...new Set(tiers.map((tier) => tier.productId))];
    const businessIds = [
      ...new Set(tiers.map((tier) => tier.businessId).filter((id): id is string => id !== null)),
    ];

    const [products, businesses] = await Promise.all([
      manager
        .getRepository(Product)
        .find({ where: { id: In(productIds) }, select: { id: true, slug: true, name: true } }),
      businessIds.length === 0
        ? Promise.resolve<Business[]>([])
        : manager
            .getRepository(Business)
            .find({ where: { id: In(businessIds) }, select: { id: true, companyName: true } }),
    ]);

    const productById = new Map(products.map((product) => [product.id, product]));
    const businessById = new Map(businesses.map((business) => [business.id, business]));

    return tiers.map((tier) => {
      const product = productById.get(tier.productId);
      if (product === undefined) {
        throw new Error(`Pricing tier ${tier.id} has no product, which the schema forbids`);
      }
      return {
        tier,
        product,
        business: tier.businessId === null ? null : (businessById.get(tier.businessId) ?? null),
      };
    });
  }
}
