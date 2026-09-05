import { HttpStatus, Injectable } from '@nestjs/common';
import { toPaise, type AdminCoupon, type Paginated } from '@nutwala/shared';
import { DataSource, In, type EntityManager } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Category } from '../../entities/catalog/category.entity';
import { Coupon } from '../../entities/commerce/coupon.entity';
import { CouponRedemption } from '../../entities/commerce/coupon-redemption.entity';
import { CouponChannel, CouponScope, CouponType } from '../../entities/enums';
import { AuditAction, AuditEntity, AuditLogService } from '../admin/audit-log.service';
import type { AdminCouponQueryDto } from './dto/admin-coupon-query.dto';
import type { CreateCouponDto, UpdateCouponDto } from './dto/save-coupon.dto';
import {
  TO_ENTITY_CHANNEL,
  TO_ENTITY_SCOPE,
  TO_ENTITY_TYPE,
  toAdminCoupon,
} from './mappers/admin-coupon.mapper';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

/**
 * The columns an audit row reports on. Money stays in paise here, unlike the wire: the trail
 * records what the row held, and a rupee figure in it would be a second representation of the same
 * fact that nothing keeps in step with the column.
 */
interface CouponSnapshot {
  type: CouponType;
  percentValue: string | null;
  flatValuePaise: string | null;
  minOrderValuePaise: string | null;
  maxDiscountPaise: string | null;
  appliesTo: CouponScope;
  categoryId: string | null;
  channel: CouponChannel;
  firstOrderOnly: boolean;
  usageLimit: number | null;
  usageLimitPerUser: number | null;
  startsAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
}

/**
 * `bigint` is not JSON-serialisable — `JSON.stringify(1n)` throws `TypeError` — and these snapshots
 * go straight into a `jsonb` column. So every paise figure is stringified, the way
 * `AdminInventoryTransaction` keeps a `bigint` balance legible, rather than converted to a number
 * that would lose precision above 2^53 paise.
 */
function snapshot(coupon: Coupon): CouponSnapshot {
  return {
    type: coupon.type,
    percentValue: coupon.percentValue,
    flatValuePaise: coupon.flatValuePaise === null ? null : coupon.flatValuePaise.toString(),
    minOrderValuePaise:
      coupon.minOrderValuePaise === null ? null : coupon.minOrderValuePaise.toString(),
    maxDiscountPaise: coupon.maxDiscountPaise === null ? null : coupon.maxDiscountPaise.toString(),
    appliesTo: coupon.appliesTo,
    categoryId: coupon.categoryId,
    channel: coupon.channel,
    firstOrderOnly: coupon.firstOrderOnly,
    usageLimit: coupon.usageLimit,
    usageLimitPerUser: coupon.usageLimitPerUser,
    startsAt: coupon.startsAt?.toISOString() ?? null,
    expiresAt: coupon.expiresAt?.toISOString() ?? null,
    isActive: coupon.isActive,
  };
}

/** The changed fields only, or null when nothing moved. `AdminCategoriesService`'s helper verbatim. */
function diff(
  before: CouponSnapshot,
  after: CouponSnapshot,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  for (const key of Object.keys(before) as (keyof CouponSnapshot)[]) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    changedBefore[key] = before[key];
    changedAfter[key] = after[key];
  }

  return Object.keys(changedAfter).length === 0
    ? null
    : { before: changedBefore, after: changedAfter };
}

/** `undefined` leaves the column alone; an explicit `null` clears it. See `CreateCouponDto`. */
function paiseOrNull(rupees: number | null | undefined, current: bigint | null): bigint | null {
  if (rupees === undefined) return current;
  return rupees === null ? null : toPaise(rupees);
}

function dateOrNull(iso: string | null | undefined, current: Date | null): Date | null {
  if (iso === undefined) return current;
  return iso === null ? null : new Date(iso);
}

function refuse(message: string, details: Record<string, unknown>): DomainError {
  return new DomainError(
    ErrorCodes.VALIDATION_FAILED,
    message,
    HttpStatus.UNPROCESSABLE_ENTITY,
    details,
  );
}

/**
 * `/admin/coupons` — spec §6.4's coupon block, brief §36.
 *
 * **Addressed by `:code`, not `:id`.** §6.4 spells these `PATCH /admin/coupons/:id` and
 * `DELETE /admin/coupons/:id`, and the table does have a uuid — but nothing anywhere addresses a
 * coupon by it. `CouponService.preview` looks a coupon up by code and by nothing else,
 * `orders.couponCode` snapshots the code as the permanent record of which coupon an order used,
 * `uq_coupons_code` makes it unique, and the code is what an operator reads off a campaign brief
 * and a customer reads off an email. §6.4 needs the same correction it already carries for
 * `PATCH /admin/inventory/:variantId` and the one plan 9.2 recorded for `:orderNumber`: the
 * spelling in the table is not the shipped one. `CouponRedemption`'s docblock says
 * `DELETE /admin/coupons/:id` for the same reason and is equally out of date.
 *
 * The code being an identifier is what makes it immutable — `UpdateCouponDto` omits it, and its
 * docblock has the case.
 *
 * **Deleting a redeemed coupon is refused with `409 ENTITY_IN_USE`,** which is spec §5a's rule for
 * products applied to the identical schema shape. `coupon_redemptions.coupon_id` is
 * `ON DELETE RESTRICT` and its own docblock states the intent outright — *"deleting a used coupon
 * must not wipe its redemption history. `Coupon.isActive` is already the soft-disable path"* — so
 * without a check here Postgres refuses the delete anyway and the operator gets an opaque 500
 * carrying a constraint name. This is the same relationship plan 9.1 found between
 * `inventory_transactions.variant_id` and `DELETE /admin/products/:id`.
 *
 * **`orders.couponCode` is *not* what blocks a delete**, and it is worth being precise about which
 * reference does: it is a `varchar(40)` snapshot with no foreign key, so a past order keeps naming
 * the coupon it used whether or not the row survives — which is the whole point of snapshotting it,
 * and is why deleting an *unredeemed* coupon is safe.
 *
 * Same two rules as every other admin write here: one transaction, the audit row inside it, and no
 * audit row for a write that changed nothing.
 */
@Injectable()
export class AdminCouponsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * `GET /admin/coupons` — newest first, `code` as the tiebreak.
   *
   * `createdAt` is not unique — `coupons.seed.ts` writes three rows in one transaction and
   * Postgres's `now()` is transaction-start time, so all three share a timestamp exactly — and an
   * unstable tiebreak over `LIMIT`/`OFFSET` returns one row on two pages and loses another
   * entirely. `code` carries `uq_coupons_code`, so it is arbitrary but *total*, which is the
   * property paging actually needs. `AdminOrdersService.list` records the same trap.
   *
   * **`timesRedeemed` is one grouped statement for the whole page, not one per row.** A `count(*)`
   * inside the mapper would be 24 round trips to render 24 rows, and the figure is not optional
   * decoration: it is what `usageLimit` is measured against, and what tells an operator whether a
   * coupon can still be deleted.
   */
  async list(query: AdminCouponQueryDto): Promise<Paginated<AdminCoupon>> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)));

    const builder = this.dataSource.getRepository(Coupon).createQueryBuilder('coupon');
    if (query.isActive !== undefined) {
      builder.andWhere('coupon.isActive = :isActive', { isActive: query.isActive });
    }

    const [rows, total] = await builder
      .orderBy('coupon.createdAt', 'DESC')
      .addOrderBy('coupon.code', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const redemptions = await this.countRedemptions(
      this.dataSource.manager,
      rows.map((row) => row.id),
    );

    return {
      items: rows.map((row) => toAdminCoupon(row, redemptions.get(row.id) ?? 0)),
      total,
      page,
      limit,
    };
  }

  async create(input: CreateCouponDto & { actorUserId: string }): Promise<AdminCoupon> {
    return this.dataSource.transaction(async (manager) => {
      const coupons = manager.getRepository(Coupon);
      if (
        await coupons
          .createQueryBuilder('c')
          .where('c.code = :code', { code: input.code })
          .getExists()
      ) {
        throw new DomainError(
          ErrorCodes.IDENTIFIER_IN_USE,
          'Another coupon already uses that code.',
          HttpStatus.CONFLICT,
          { field: 'code', value: input.code },
        );
      }

      const draft = coupons.create({
        code: input.code,
        type: TO_ENTITY_TYPE[input.type],
        percentValue: input.percentValue == null ? null : input.percentValue.toFixed(2),
        flatValuePaise: paiseOrNull(input.flatValue, null),
        minOrderValuePaise: paiseOrNull(input.minOrderValue, null),
        maxDiscountPaise: paiseOrNull(input.maxDiscount, null),
        appliesTo: TO_ENTITY_SCOPE[input.appliesTo ?? 'all'],
        categoryId: input.categoryId ?? null,
        channel: TO_ENTITY_CHANNEL[input.channel ?? 'all'],
        firstOrderOnly: input.firstOrderOnly ?? false,
        usageLimit: input.usageLimit ?? null,
        usageLimitPerUser: input.usageLimitPerUser ?? null,
        startsAt: dateOrNull(input.startsAt, null),
        expiresAt: dateOrNull(input.expiresAt, null),
        isActive: input.isActive ?? true,
      });

      await this.assertCoherent(manager, draft, 0);
      const created = await coupons.save(draft);

      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: AuditAction.COUPON_CREATE,
        entityType: AuditEntity.COUPON,
        entityId: created.code,
        after: { ...snapshot(created) },
      });

      return toAdminCoupon(created, 0);
    });
  }

  async update(
    code: string,
    input: UpdateCouponDto & { actorUserId: string },
  ): Promise<AdminCoupon> {
    return this.dataSource.transaction(async (manager) => {
      const coupon = await this.loadOrThrow(manager, code);
      const before = snapshot(coupon);

      if (input.type !== undefined) coupon.type = TO_ENTITY_TYPE[input.type];
      if (input.percentValue !== undefined) {
        coupon.percentValue = input.percentValue === null ? null : input.percentValue.toFixed(2);
      }
      coupon.flatValuePaise = paiseOrNull(input.flatValue, coupon.flatValuePaise);
      coupon.minOrderValuePaise = paiseOrNull(input.minOrderValue, coupon.minOrderValuePaise);
      coupon.maxDiscountPaise = paiseOrNull(input.maxDiscount, coupon.maxDiscountPaise);
      if (input.appliesTo !== undefined) coupon.appliesTo = TO_ENTITY_SCOPE[input.appliesTo];
      if (input.categoryId !== undefined) coupon.categoryId = input.categoryId;
      if (input.channel !== undefined) coupon.channel = TO_ENTITY_CHANNEL[input.channel];
      if (input.firstOrderOnly !== undefined) coupon.firstOrderOnly = input.firstOrderOnly;
      if (input.usageLimit !== undefined) coupon.usageLimit = input.usageLimit;
      if (input.usageLimitPerUser !== undefined) {
        coupon.usageLimitPerUser = input.usageLimitPerUser;
      }
      coupon.startsAt = dateOrNull(input.startsAt, coupon.startsAt);
      coupon.expiresAt = dateOrNull(input.expiresAt, coupon.expiresAt);
      if (input.isActive !== undefined) coupon.isActive = input.isActive;

      const timesRedeemed = await this.redemptionCount(manager, coupon.id);
      await this.assertCoherent(manager, coupon, timesRedeemed);

      const changed = diff(before, snapshot(coupon));
      // A write that changes nothing writes no audit row — plan 9.1's rule.
      if (changed === null) return toAdminCoupon(coupon, timesRedeemed);

      await manager.getRepository(Coupon).save(coupon);
      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: AuditAction.COUPON_UPDATE,
        entityType: AuditEntity.COUPON,
        entityId: coupon.code,
        before: changed.before,
        after: changed.after,
      });

      return toAdminCoupon(coupon, timesRedeemed);
    });
  }

  /**
   * `DELETE /admin/coupons/:code` — a hard delete, refused once the coupon has been redeemed.
   *
   * The count is taken **before** the delete rather than letting the `RESTRICT` constraint fire,
   * for `AdminProductsService.remove`'s reason: an operator who is refused deserves an instruction
   * ("switch it off instead") rather than a 500 carrying a Postgres constraint name they cannot act
   * on. `details` names the count, so the console can say how many redemptions are in the way.
   */
  async remove(code: string, actorUserId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const coupon = await this.loadOrThrow(manager, code);

      const redemptions = await this.redemptionCount(manager, coupon.id);
      if (redemptions > 0) {
        throw new DomainError(
          ErrorCodes.ENTITY_IN_USE,
          'This coupon has been redeemed, and its redemption history must outlive it. Switch it off with isActive instead.',
          HttpStatus.CONFLICT,
          { code: coupon.code, redemptions },
        );
      }

      // Before the delete and inside the same transaction, as in `AdminProductsService.remove`:
      // `audit_logs` references the actor and never the coupon, so the ordering is for readability
      // rather than for a constraint. `before` carries the whole row — nothing else ever will.
      await this.audit.record(manager, {
        actorUserId,
        action: AuditAction.COUPON_DELETE,
        entityType: AuditEntity.COUPON,
        entityId: coupon.code,
        before: { ...snapshot(coupon) },
      });

      await manager.getRepository(Coupon).delete({ id: coupon.id });
    });
  }

  private async loadOrThrow(manager: EntityManager, code: string): Promise<Coupon> {
    // Uppercased on the way in, exactly as `CouponService.preview` does, so `/admin/coupons/save10`
    // and `/admin/coupons/SAVE10` address the one row the redemption path would find.
    const normalised = code.trim().toUpperCase();
    const coupon = await manager.getRepository(Coupon).findOne({ where: { code: normalised } });
    if (!coupon) {
      throw new DomainError(
        ErrorCodes.NOT_FOUND,
        `No coupon ${normalised}.`,
        HttpStatus.NOT_FOUND,
        {
          code: normalised,
        },
      );
    }
    return coupon;
  }

  private async redemptionCount(manager: EntityManager, couponId: string): Promise<number> {
    return manager.getRepository(CouponRedemption).count({ where: { couponId } });
  }

  /** One grouped statement for a whole page. Coupons with no redemptions simply have no row. */
  private async countRedemptions(
    manager: EntityManager,
    couponIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (couponIds.length === 0) return new Map();
    const rows = await manager
      .getRepository(CouponRedemption)
      .createQueryBuilder('r')
      .select('r.couponId', 'couponId')
      .addSelect('count(*)::int', 'count')
      .where({ couponId: In([...couponIds]) })
      .groupBy('r.couponId')
      .getRawMany<{ couponId: string; count: number }>();
    return new Map(rows.map((row) => [row.couponId, row.count]));
  }

  /**
   * Every rule the `coupons` columns imply but the schema cannot enforce, checked against the
   * **resolved** row rather than against the request — which is the only way a PATCH sending one
   * half of a pair can be judged.
   *
   * This exists because `CouponService.preview` is a *read* path and cannot fix a row that should
   * never have been written. Read it before changing anything here: the two are a pair, and each
   * rule below names the refusal an operator would otherwise have discovered from a customer.
   *
   * **What is deliberately *not* refused, having read `preview` for it as the plan asked.**
   *
   * - **An expiry in the past.** `preview` handles it exactly right — `expiresAt <= now` answers
   *   `COUPON_EXPIRED`, which is its own code precisely because it is actionable — so nothing is
   *   mis-handled, and back-dating an expiry is a legitimate way to end a campaign at a stated
   *   moment. The same rule applies on create and on update, because an asymmetry there would be a
   *   surprise with nothing behind it. `isActive: false` remains the way to stop a campaign *now*.
   * - **A usage limit at or below current usage.** `preview` answers `COUPON_LIMIT_REACHED`
   *   correctly. It is refused below anyway, and for a different reason than correctness: the
   *   coupon stops working the instant the write commits, the response body looks like a successful
   *   edit, and `timesRedeemed` is the only thing in it that would have told the operator. That is
   *   a refusal about legibility, not about the redemption path.
   *
   * So the honest statement is that the redemption path mis-handles **neither** of the two cases
   * the plan named. What it genuinely cannot defend itself against is a row that contradicts
   * itself, and those are the first three rules below.
   */
  private async assertCoherent(
    manager: EntityManager,
    coupon: Coupon,
    timesRedeemed: number,
  ): Promise<void> {
    /**
     * `ck_coupons_value_exclusive` in application terms, checked here so the operator gets a named
     * 422 rather than a driver error.
     *
     * The constraint is real and would catch this — but a `PATCH {"type": "flat"}` on a percentage
     * coupon would reach it with `percentValue` still populated and `flatValuePaise` still null,
     * and a check-constraint violation surfaces as a 500 naming `ck_coupons_value_exclusive`.
     * Neither half of that tells an operator to send `flatValue` alongside `type`.
     */
    if (coupon.type === CouponType.PERCENT) {
      if (coupon.percentValue === null || coupon.flatValuePaise !== null) {
        throw refuse(
          'A percentage coupon needs percentValue and no flatValue. Send both fields together when changing type.',
          { type: 'percent', field: 'percentValue' },
        );
      }
    } else if (coupon.flatValuePaise === null || coupon.percentValue !== null) {
      throw refuse(
        'A flat coupon needs flatValue and no percentValue. Send both fields together when changing type.',
        { type: 'flat', field: 'flatValue' },
      );
    }

    /**
     * A cap on a flat coupon is stored, displayed and then ignored: `applyFlat` takes no `maxPaise`
     * argument at all. Silently-ignored configuration is the kind of thing an operator discovers
     * months later from a discount that was never capped.
     */
    if (coupon.type === CouponType.FLAT && coupon.maxDiscountPaise !== null) {
      throw refuse('maxDiscount caps a percentage discount and does nothing on a flat coupon.', {
        field: 'maxDiscount',
      });
    }

    /**
     * **The validation `coupon.service.ts` explicitly delegates to this write path.**
     * `eligibleSubtotal`'s docblock says a `CATEGORY` coupon whose `categoryId` is null is refused
     * as `COUPON_NOT_APPLICABLE` and that *"application validation is expected to catch any scope
     * mismatch this creates"*. This is that validation, and it is the one rule here that was owed
     * rather than invented.
     *
     * The mirror — a `categoryId` on an `all`-scoped coupon — is refused rather than quietly
     * cleared, so an operator who meant to scope the coupon and forgot to change `appliesTo` is
     * told, instead of shipping a coupon that discounts the whole basket.
     */
    if (coupon.appliesTo === CouponScope.CATEGORY) {
      if (coupon.categoryId === null) {
        throw refuse('A category-scoped coupon needs a categoryId.', { field: 'categoryId' });
      }
      const exists = await manager
        .getRepository(Category)
        .createQueryBuilder('category')
        .where('category.id = :id', { id: coupon.categoryId })
        .getExists();
      if (!exists) {
        throw refuse('No such category.', { field: 'categoryId', value: coupon.categoryId });
      }
    } else if (coupon.categoryId !== null) {
      throw refuse(
        'categoryId only applies to a category-scoped coupon. Send appliesTo: "category", or clear categoryId.',
        { field: 'categoryId' },
      );
    }

    /**
     * A window that never opens. `preview` refuses such a coupon as `COUPON_INVALID` — "not yet
     * started" — every time, forever, and there is no signal anywhere that the dates are the
     * reason. Unlike the two cases above, this row is not merely restrictive: it is unreachable.
     */
    if (
      coupon.startsAt !== null &&
      coupon.expiresAt !== null &&
      coupon.expiresAt <= coupon.startsAt
    ) {
      throw refuse('expiresAt must be after startsAt, or the coupon never opens.', {
        startsAt: coupon.startsAt.toISOString(),
        expiresAt: coupon.expiresAt.toISOString(),
      });
    }

    if (coupon.usageLimit !== null && coupon.usageLimit < timesRedeemed) {
      throw refuse(
        'That usage limit is below the number of times this coupon has already been redeemed, which would stop it working immediately. Switch it off with isActive if that is the intention.',
        { field: 'usageLimit', usageLimit: coupon.usageLimit, timesRedeemed },
      );
    }
  }
}
