import { HttpStatus, Injectable } from '@nestjs/common';
import { toPaise, toRupees, type AdminVariant, type Channel } from '@nutwala/shared';
import { DataSource, type EntityManager } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Inventory } from '../../entities/catalog/inventory.entity';
import { Product } from '../../entities/catalog/product.entity';
import { ProductVariant } from '../../entities/catalog/product-variant.entity';
import { VariantChannel } from '../../entities/enums';
import { AuditAction, AuditEntity, AuditLogService } from '../admin/audit-log.service';
import { TO_DB_CHANNEL } from './catalog.service';
import type { CreateVariantDto, UpdateVariantDto } from './dto/save-variant.dto';
import { toAdminVariant } from './mappers/admin-catalog.mapper';

/** The inverse of `TO_DB_CHANNEL`, for an audit snapshot that reads in the wire vocabulary. */
const TO_WIRE_CHANNEL: Record<VariantChannel, Channel> = {
  [VariantChannel.RETAIL]: 'retail',
  [VariantChannel.BULK]: 'bulk',
};

/**
 * What an audit row records about a variant.
 *
 * **Money is recorded in rupees, not paise.** Two reasons, and the second is the load-bearing one:
 * an operator reading the trail should see the figure they typed, and `pricePaise` is a `bigint`,
 * which `JSON.stringify` refuses outright — the `BigInt.prototype.toJSON` polyfill would turn it
 * into a *string* in the jsonb column, so `audit_logs.after->'pricePaise'` would compare as text and
 * a numeric filter over the trail would silently match nothing.
 */
interface VariantSnapshot {
  sku: string;
  size: string;
  grams: number;
  channel: Channel;
  price: number;
  mrp: number;
  moq: number;
  isActive: boolean;
}

function snapshot(variant: ProductVariant): VariantSnapshot {
  return {
    sku: variant.sku,
    size: variant.size,
    grams: variant.grams,
    channel: TO_WIRE_CHANNEL[variant.channel],
    price: toRupees(variant.pricePaise),
    mrp: toRupees(variant.mrpPaise),
    moq: variant.moq,
    isActive: variant.isActive,
  };
}

/** The changed fields, both sides, or `null` when nothing changed. Same rule as products. */
function diff(
  before: VariantSnapshot,
  after: VariantSnapshot,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  for (const key of Object.keys(before) as (keyof VariantSnapshot)[]) {
    if (before[key] === after[key]) continue;
    changedBefore[key] = before[key];
    changedAfter[key] = after[key];
  }

  return Object.keys(changedAfter).length === 0
    ? null
    : { before: changedBefore, after: changedAfter };
}

/**
 * Variant create, update and delete — spec §6.4's `POST /admin/products/:id/variants`,
 * `PATCH /admin/variants/:id` and `DELETE /admin/variants/:id`. Brief §30's variant fields.
 *
 * Same two rules as `AdminProductsService`: one transaction per write with the audit row inside it,
 * and no audit row for a write that changed nothing.
 */
@Injectable()
export class AdminVariantsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * `POST /admin/products/:id/variants`.
   *
   * **The `Inventory` row is created in the same transaction, always.** This is the one requirement
   * on this endpoint that is not negotiable, and the reason is that its absence is *invisible*:
   * `availableFor` in `variant.mapper.ts` maps a missing `inventory` relation to `0`, and
   * `toVariantRules` in `cart-read.service.ts` reads `(inventory?.onHand ?? 0) - (…?? 0)`, so a
   * variant with no row would read as sold out on the storefront — not as infinitely in stock, but
   * not as broken either. What actually breaks is stocking it: `InventoryService.adjust`'s
   * conditional `UPDATE` matches no row, and the operator is told **"No such product variant"** for
   * a variant they are looking at. There is then no route in the whole admin surface that can create
   * the missing row, so the pack is permanently unsellable. `admin-variants.integration.spec.ts`
   * asserts the adjust succeeds, which is the consequence a mutation of this line has to break.
   *
   * **`onHand` starts at zero and is not settable.** `SUM(inventory_transactions.delta) =
   * inventory.onHand` per variant is an invariant `schema-invariants.integration.spec.ts` asserts,
   * and an opening figure written straight into the column would break it with no ledger row behind
   * it. Stock arrives through `PATCH /admin/inventory/:variantId`, which writes both halves
   * together — brief §32's history with a reason and an admin against every movement.
   */
  async create(
    productId: string,
    input: CreateVariantDto & { actorUserId: string },
  ): Promise<AdminVariant> {
    return this.dataSource.transaction(async (manager) => {
      const productExists = await manager
        .getRepository(Product)
        .exists({ where: { id: productId } });
      if (!productExists) {
        throw new DomainError(ErrorCodes.NOT_FOUND, 'No such product.', HttpStatus.NOT_FOUND, {
          productId,
        });
      }
      await this.assertSkuFree(manager, input.sku, null);

      const variants = manager.getRepository(ProductVariant);
      const created = await variants.save(
        variants.create({
          productId,
          sku: input.sku,
          size: input.size,
          grams: input.grams,
          channel: TO_DB_CHANNEL[input.channel],
          // Rupees in, paise stored — spec §8's boundary, converted once.
          // `@IsNumber({ maxDecimalPlaces: 2 })` on the DTO is what stops `toPaise` throwing on
          // sub-paise input, which would otherwise be a 500 rather than a 400.
          pricePaise: toPaise(input.price),
          mrpPaise: toPaise(input.mrp),
          moq: input.moq ?? 1,
          isActive: input.isActive ?? true,
        }),
      );

      await manager.getRepository(Inventory).insert({
        variantId: created.id,
        onHand: 0,
        reserved: 0,
        // The column's own default is 10; an explicit value here is the only place spec §6.4's
        // admin surface can set a threshold at all — see `CreateVariantDto.lowStockThreshold`.
        lowStockThreshold: input.lowStockThreshold ?? 10,
      });

      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: AuditAction.VARIANT_CREATE,
        entityType: AuditEntity.VARIANT,
        entityId: created.id,
        after: {
          ...snapshot(created),
          productId,
          lowStockThreshold: input.lowStockThreshold ?? 10,
        },
      });

      return toAdminVariant(await this.loadOrThrow(manager, created.id));
    });
  }

  /** `PATCH /admin/variants/:id`. An omitted field means "leave unchanged". */
  async update(
    id: string,
    input: UpdateVariantDto & { actorUserId: string },
  ): Promise<AdminVariant> {
    return this.dataSource.transaction(async (manager) => {
      const variant = await this.loadOrThrow(manager, id);
      const before = snapshot(variant);

      if (input.sku !== undefined) {
        await this.assertSkuFree(manager, input.sku, id);
        variant.sku = input.sku;
      }
      if (input.size !== undefined) variant.size = input.size;
      if (input.grams !== undefined) variant.grams = input.grams;
      if (input.channel !== undefined) variant.channel = TO_DB_CHANNEL[input.channel];
      if (input.price !== undefined) variant.pricePaise = toPaise(input.price);
      if (input.mrp !== undefined) variant.mrpPaise = toPaise(input.mrp);
      if (input.moq !== undefined) variant.moq = input.moq;
      if (input.isActive !== undefined) variant.isActive = input.isActive;

      const changed = diff(before, snapshot(variant));
      if (changed === null) return toAdminVariant(variant);

      await manager.getRepository(ProductVariant).save(variant);
      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: AuditAction.VARIANT_UPDATE,
        entityType: AuditEntity.VARIANT,
        entityId: id,
        before: changed.before,
        after: changed.after,
      });

      return toAdminVariant(await this.loadOrThrow(manager, id));
    });
  }

  /**
   * `DELETE /admin/variants/:id`.
   *
   * **Resolved identically to `AdminProductsService.remove`: a hard delete, refused with a named 409
   * when history references the variant.** The plan asked for consistency between the two and this is
   * it — same code, same status, same "unpublish or deactivate instead" advice — so an operator
   * learns one rule rather than two.
   *
   * Three checks, in the order an operator can act on:
   *
   * 1. **Stock on hand.** Refused first because it is the one the operator can clear themselves, by
   *    adjusting to zero through `PATCH /admin/inventory/:variantId`. Deleting a variant holding
   *    stock would discard physical goods from the books with no ledger row explaining where they
   *    went, which is precisely what brief §32's "stock adjusted, reason, date, admin" exists to
   *    prevent.
   * 2. **Order history.** Same reasoning as a product's: the line survives regardless
   *    (`order_items.variant_id` is `SET NULL` and the pack size is snapshotted in `detail`), but a
   *    variant that has been sold is history and the withdrawal an operator wants is
   *    `isActive = false`.
   * 3. **The stock ledger.** `inventory_transactions.variant_id` is `ON DELETE RESTRICT` and
   *    `inventory-transaction.entity.ts` states the intended alternative in as many words: "a variant
   *    with stock history cannot be hard-deleted — admin deactivates it instead
   *    (`ProductVariant.isActive = false`)". This check is what makes that a sentence an operator
   *    reads instead of a constraint violation surfacing as a 500.
   *
   * Note (3) subsumes "has stock" in practice: every route by which `onHand` becomes non-zero writes
   * a ledger row in the same transaction, so a variant with stock always has history too and would
   * be refused either way. (1) is kept because it is checked first and says the actionable thing,
   * and because it is the check that would still be right if a future path moved stock without the
   * ledger — the invariant test would catch that, but this would refuse the delete meanwhile.
   *
   * A successful delete cascades `inventory` (1:1, part of the variant's lifecycle) and `cart_items`
   * carrying it. Both are the schema's existing choices, stated in `inventory.entity.ts` and
   * `cart-item.entity.ts`.
   */
  async remove(id: string, actorUserId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const variant = await this.loadOrThrow(manager, id);

      const onHand = variant.inventory?.onHand ?? 0;
      if (onHand > 0) {
        throw new DomainError(
          ErrorCodes.ENTITY_IN_USE,
          'This variant still holds stock. Adjust it to zero first, or deactivate the variant instead of deleting it.',
          HttpStatus.CONFLICT,
          { variantId: id, onHand },
        );
      }

      const orderItems = await this.countReferences(
        manager,
        `SELECT count(*)::int AS count FROM order_items WHERE variant_id = $1`,
        id,
      );
      if (orderItems > 0) {
        throw new DomainError(
          ErrorCodes.ENTITY_IN_USE,
          'This variant has been ordered, so it cannot be deleted. Deactivate it instead to withdraw it from sale.',
          HttpStatus.CONFLICT,
          { variantId: id, orderItems },
        );
      }

      const ledgerRows = await this.countReferences(
        manager,
        `SELECT count(*)::int AS count FROM inventory_transactions WHERE variant_id = $1`,
        id,
      );
      if (ledgerRows > 0) {
        throw new DomainError(
          ErrorCodes.ENTITY_IN_USE,
          'This variant has stock movement history, which is append-only and must outlive it. Deactivate it instead of deleting it.',
          HttpStatus.CONFLICT,
          { variantId: id, inventoryTransactions: ledgerRows },
        );
      }

      await this.audit.record(manager, {
        actorUserId,
        action: AuditAction.VARIANT_DELETE,
        entityType: AuditEntity.VARIANT,
        entityId: id,
        before: { ...snapshot(variant), productId: variant.productId },
      });

      await manager.getRepository(ProductVariant).delete({ id });
    });
  }

  /**
   * One variant with its `inventory` relation, or a 404.
   *
   * The relation is loaded because `toAdminVariant` derives `available` and `soldOut` from it — and
   * because `remove` reads `onHand` off it rather than issuing a fourth query.
   */
  private async loadOrThrow(manager: EntityManager, id: string): Promise<ProductVariant> {
    const variant = await manager
      .getRepository(ProductVariant)
      .findOne({ where: { id }, relations: { inventory: true } });

    if (!variant) {
      throw new DomainError(
        ErrorCodes.NOT_FOUND,
        'No such product variant.',
        HttpStatus.NOT_FOUND,
        { variantId: id },
      );
    }
    return variant;
  }

  /**
   * A named 409 for a taken SKU instead of a driver error from `uq_product_variants_sku`.
   *
   * The index is table-wide, not per product, so a collision can be with a variant of a completely
   * different product — which is why the message does not say "this product already has".
   */
  private async assertSkuFree(
    manager: EntityManager,
    sku: string,
    exceptId: string | null,
  ): Promise<void> {
    const builder = manager
      .getRepository(ProductVariant)
      .createQueryBuilder('variant')
      .where('variant.sku = :sku', { sku });
    if (exceptId !== null) builder.andWhere('variant.id != :exceptId', { exceptId });

    if (await builder.getExists()) {
      throw new DomainError(
        ErrorCodes.IDENTIFIER_IN_USE,
        'Another variant already uses that SKU.',
        HttpStatus.CONFLICT,
        { field: 'sku', value: sku },
      );
    }
  }

  private async countReferences(manager: EntityManager, sql: string, id: string): Promise<number> {
    const rows = await manager.query<{ count: number }[]>(sql, [id]);
    return rows[0]?.count ?? 0;
  }
}
