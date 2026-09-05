import { HttpStatus, Injectable } from '@nestjs/common';
import {
  variantSoldOut,
  type AdminInventoryRow,
  type AdminInventoryTransaction,
  type AdminStockMovement,
  type Paginated,
} from '@nutwala/shared';
import { DataSource, type EntityManager } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Inventory } from '../../entities/catalog/inventory.entity';
import { InventoryTransaction } from '../../entities/catalog/inventory-transaction.entity';
import { InventoryTransactionType } from '../../entities/enums';
import { AuditAction, AuditEntity, AuditLogService } from '../admin/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { checkLowStock } from './check-low-stock';
import type { InventoryLedgerQueryDto, InventoryQueryDto } from './dto/inventory-query.dto';
import { SQL_AVAILABLE, SQL_LOW_STOCK, SQL_OUT_OF_STOCK } from './stock-sql';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

/**
 * The database enum -> the wire vocabulary, keyed on the enum so a member added to either side is a
 * compile error rather than a row that maps to `undefined`. `TO_WIRE_CHANNEL` in
 * `admin-variants.service.ts` is the precedent; the values happen to be identical here, which is
 * why the `Record` matters — an identity map is the easiest kind to let drift silently.
 */
const TO_WIRE_MOVEMENT: Record<InventoryTransactionType, AdminStockMovement> = {
  [InventoryTransactionType.RECEIPT]: 'RECEIPT',
  [InventoryTransactionType.SALE]: 'SALE',
  [InventoryTransactionType.ADJUSTMENT]: 'ADJUSTMENT',
  [InventoryTransactionType.RETURN]: 'RETURN',
  [InventoryTransactionType.CANCELLATION]: 'CANCELLATION',
};

/**
 * One row of `GET /admin/inventory` as Postgres hands it back.
 *
 * `available` and `low` are computed by the database — see the class docblock — so they arrive as a
 * real `integer` and a real `boolean`, not as strings: `pg` only hands back a string for `bigint`
 * and `numeric`, which this statement selects none of. Nothing here is money, so spec §8's paise
 * boundary does not apply to this endpoint at all.
 */
interface StockPositionRow {
  variantId: string;
  sku: string;
  size: string;
  isActive: boolean;
  productId: string;
  productName: string;
  onHand: number;
  reserved: number;
  available: number;
  lowStockThreshold: number;
  low: boolean;
  updatedAt: Date;
}

/**
 * The stock position columns, selected identically by the list and by the single-row read a
 * threshold change answers with.
 *
 * One string rather than two, because the alternative is two statements that must agree about
 * fourteen aliases and would be free to disagree about `low`. `SQL_LOW_STOCK` is also the
 * `?status=low` filter's predicate, so the flag on a row and the filter that selected it are the
 * same expression by construction.
 */
const STOCK_POSITION_COLUMNS = `i.variant_id            AS "variantId",
         v.sku                   AS "sku",
         v.size                  AS "size",
         v."isActive"            AS "isActive",
         p.id                    AS "productId",
         p.name                  AS "productName",
         i."onHand"              AS "onHand",
         i.reserved              AS "reserved",
         ${SQL_AVAILABLE}        AS "available",
         i."lowStockThreshold"   AS "lowStockThreshold",
         (${SQL_LOW_STOCK})      AS "low",
         i."updatedAt"           AS "updatedAt"`;

/**
 * `INNER JOIN` both ways, deliberately.
 *
 * `inventory.variant_id` is a `NOT NULL` primary key with an FK to `product_variants`, and
 * `product_variants.product_id` is `NOT NULL` with an FK to `products`, so neither join can drop a
 * row that exists. A `LEFT JOIN` here would be defensive against a state the schema forbids, at the
 * cost of making `productName` nullable on the wire for no reachable reason.
 */
const STOCK_POSITION_FROM = `FROM inventory i
         JOIN product_variants v ON v.id = i.variant_id
         JOIN products p ON p.id = v.product_id`;

/**
 * Entity/raw row -> wire.
 *
 * **`outOfStock` comes from `variantSoldOut`, never from an inline comparison.** Spec §10.1 requires
 * one derivation of availability and `eslint.config.mjs` turns a second one into a build failure;
 * `SQL_OUT_OF_STOCK` mirrors the same rule for the `WHERE` clause, which is the one place a
 * TypeScript function cannot go, and the integration suite asserts the two agree on every row.
 */
function toStockPosition(row: StockPositionRow): AdminInventoryRow {
  return {
    variantId: row.variantId,
    sku: row.sku,
    size: row.size,
    isActive: row.isActive,
    productId: row.productId,
    productName: row.productName,
    onHand: row.onHand,
    reserved: row.reserved,
    available: row.available,
    lowStockThreshold: row.lowStockThreshold,
    low: row.low,
    outOfStock: variantSoldOut(row.available),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toLedgerRow(transaction: InventoryTransaction): AdminInventoryTransaction {
  return {
    id: transaction.id,
    variantId: transaction.variantId,
    delta: transaction.delta,
    type: TO_WIRE_MOVEMENT[transaction.type],
    reason: transaction.reason,
    balanceAfter: transaction.balanceAfter,
    orderId: transaction.orderId,
    orderNumber: transaction.order?.orderNumber ?? null,
    actorUserId: transaction.actorUserId,
    actorName: transaction.actorUser?.name ?? null,
    createdAt: transaction.createdAt.toISOString(),
  };
}

/**
 * The same refusal from all four routes on this controller.
 *
 * One function rather than four throw sites, because the operator-facing half of this is the
 * message: `adjust` records at length why "no such variant" must not be reported as `OUT_OF_STOCK`
 * — "an explanation about stock levels for a row that does not exist, sending them to look at the
 * wrong thing entirely" — and that reasoning is wasted if the read routes answer the same condition
 * with different words.
 */
function noSuchVariant(variantId: string): DomainError {
  return new DomainError(ErrorCodes.NOT_FOUND, 'No such product variant.', HttpStatus.NOT_FOUND, {
    variantId,
  });
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Applies a signed stock adjustment and records why, in one transaction.
   *
   * The ledger row and the column move together or not at all. Plan 1 established
   * `SUM(delta) == onHand` per variant as a tested invariant, and a write that updated one without
   * the other would break it silently — the column is what the storefront reads, so the shop would
   * then disagree with its own audit trail.
   *
   * The `UPDATE` is conditional in the same shape as spec §10.2's decrement: `onHand + delta >=
   * reserved` has no read-then-write gap, so two admins adjusting the same variant cannot drive it
   * negative between them. Zero rows affected is a rejection rather than a clamp — silently
   * clamping would tell the admin their correction succeeded when it did not — and it has **two**
   * causes, separated below, because "would oversell reserved units" and "no such variant" send an
   * admin to look at entirely different things.
   *
   * Be clear about what the condition is and is not. `ck_inventory_non_negative` already enforces
   * `onHand >= reserved` at the database, so the constraint is what makes negative stock
   * impossible; this clause is what makes the refusal a 409 carrying `OUT_OF_STOCK` instead of a
   * constraint violation surfacing as an opaque 500. The concurrency claim above is a property of
   * evaluating the condition inside the writing statement, and it is *not* covered by any test
   * here: nothing in this codebase issues two genuinely concurrent adjustments.
   */
  async adjust(input: {
    variantId: string;
    delta: number;
    reason: string;
    actorUserId: string;
  }): Promise<{ onHand: number; balanceAfter: number }> {
    /**
     * Truncated **before** the zero check, not after.
     *
     * Stock is whole packs, so a fractional delta is coerced rather than refused; `@IsInt()` on the
     * DTO means HTTP never sends one, and this is the contract for the callers that do not come
     * through the controller. But the two steps have to agree on what zero means. Checking
     * `input.delta === 0` first let `0.4` past the guard, truncate to `0`, and complete: the
     * measured result was a 200 carrying an unchanged `onHand`, plus an `ADJUSTMENT` row in the
     * append-only ledger asserting a movement of zero. An audit trail reads as authoritative, so a
     * row recording a change that never happened is worse than no row, and the admin was told a
     * correction landed that had not.
     */
    const delta = Math.trunc(input.delta);

    if (delta === 0) {
      throw new DomainError(
        ErrorCodes.VALIDATION_FAILED,
        'An adjustment of zero changes nothing. Enter the quantity added or removed.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    return this.dataSource.transaction(async (manager) => {
      /**
       * `:delta` as a parameter, **not** interpolated into the SQL string.
       *
       * An earlier version of this plan built both clauses with template literals. Not
       * exploitable — `@IsInt()` guarantees a number, and a number cannot carry a quote — but it is
       * the wrong habit in the one file that writes raw SQL fragments, and it would have been
       * copied. A parameter does survive inside a raw `set()` expression and is reused across both
       * clauses, and the mechanism is worth knowing rather than trusting: TypeORM's
       * `UpdateQueryBuilder` splices the function's string into the `SET` clause untouched, and
       * `PostgresDriver.escapeQueryWithParameters` then rewrites every `:name` across the *finished*
       * statement, keeping an index map so a name that appears twice becomes the same `$n` both
       * times. So `:delta` in the `SET` and `:delta` in the `WHERE` bind one value.
       *
       * That is read from the driver, so what pins it is behaviour, not text: the successful
       * adjustment in `test/integration/inventory.integration.spec.ts` could not run at all if the
       * parameter were left unbound — the statement would reach Postgres carrying a literal
       * `:delta`. No test asserts the generated SQL string; rebuilding the same query in a spec
       * would compare the implementation against a copy of itself.
       *
       * Note `updatedAt` is **not** set by hand. TypeORM's `@UpdateDateColumn` adds
       * `CURRENT_TIMESTAMP` itself, which is the database's clock — better than the application's,
       * since a stock ledger read against `updatedAt` should not depend on which host wrote the row.
       */
      const result = await manager
        .createQueryBuilder()
        .update(Inventory)
        .set({ onHand: () => '"onHand" + :delta' })
        .where('variant_id = :variantId')
        .andWhere('"onHand" + :delta >= reserved')
        .setParameters({ delta, variantId: input.variantId })
        .execute();

      if (result.affected !== 1) {
        /**
         * Zero rows affected has **two** causes, and they need different answers.
         *
         * The conditional `WHERE` can fail — the adjustment would take stock below what is
         * reserved — but so can `variant_id = :variantId` simply matching nothing, because the id is
         * wrong or the variant was deleted. An earlier version of this task reported both as
         * `OUT_OF_STOCK` / 409, so an admin who mistyped a variant id was told their correction
         * would oversell reserved orders: an explanation about stock levels for a row that does not
         * exist, sending them to look at the wrong thing entirely.
         *
         * One extra query, only ever on the failure path, separates them.
         */
        const exists = await manager
          .getRepository(Inventory)
          .exists({ where: { variantId: input.variantId } });

        if (!exists) {
          throw noSuchVariant(input.variantId);
        }

        throw new DomainError(
          ErrorCodes.OUT_OF_STOCK,
          'That adjustment would take stock below what is already reserved for open orders.',
          HttpStatus.CONFLICT,
          { variantId: input.variantId, delta: input.delta },
        );
      }

      const inventory = await manager.getRepository(Inventory).findOneOrFail({
        where: { variantId: input.variantId },
      });

      await manager.getRepository(InventoryTransaction).insert({
        variantId: input.variantId,
        delta,
        type: InventoryTransactionType.ADJUSTMENT,
        reason: input.reason,
        // Read back from the column rather than computed as `before + delta`, so the ledger's
        // balance is the value the storefront will read and not a second derivation of it.
        balanceAfter: inventory.onHand,
        orderId: null,
        actorUserId: input.actorUserId,
      });

      await checkLowStock(manager, this.notifications, {
        variantId: input.variantId,
        delta,
        onHand: inventory.onHand,
        lowStockThreshold: inventory.lowStockThreshold,
      });

      return { onHand: inventory.onHand, balanceAfter: inventory.onHand };
    });
  }

  /**
   * `GET /admin/inventory` — brief §32's stock screen, spec §6.4's
   * "current / reserved / available / low / out". §14's E2E journey 3 reads it.
   *
   * **Every figure and every filter is computed by Postgres.** Spec §12's rule for the dashboard is
   * the same rule for this list, and `GET /business/stats` and `GET /admin/dashboard` are the
   * precedents. Loading the rows and reducing in JS would be wrong for a reason beyond speed:
   * `?status=low` has to filter *before* `LIMIT`, or page 1 of "what needs ordering" is the first 24
   * variants that happen to sort first, filtered down to however many of those were low — an empty
   * page for a warehouse with a hundred problems, and a `total` that means nothing.
   *
   * **Ordered by `available` ascending, then SKU.** This screen answers one question — what do I
   * need to order? — so the most urgent row is the first row, and an operator scanning the top of
   * page 1 has seen the worst of it. SKU is the tiebreak because `uq_product_variants_sku` makes it
   * unique, and an unstable tiebreak over a `LIMIT`/`OFFSET` window is how the same row appears on
   * two pages while another appears on none. `createdAt` would not do: `seedCatalog` writes the
   * whole catalogue in one transaction and Postgres's `now()` is transaction-start time, so every
   * seeded row shares one timestamp — `AdminProductsService.list` records the same measurement.
   *
   * **No `isActive` or `isPublished` filter, and none by default.** Stock does not stop existing
   * because a pack was withdrawn from sale, and a screen that claims to show all of it must not
   * quietly hide some. It also keeps this list in agreement with the dashboard's low-stock card,
   * which counts every `inventory` row: `?status=low`'s `total` and that card are the same figure,
   * asserted as such in the integration suite, and they could not be if one of them filtered.
   *
   * Two statements rather than one with `count(*) OVER ()`: the window form returns no count at all
   * for a page past the end, so "43 rows, you asked for page 9" would come back as zero of zero.
   * They are issued concurrently, so it is one round trip's latency.
   */
  async list(query: InventoryQueryDto): Promise<Paginated<AdminInventoryRow>> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)));

    const conditions: string[] = [];
    const parameters: unknown[] = [];

    if (query.q !== undefined && query.q.trim() !== '') {
      parameters.push(`%${query.q.trim()}%`);
      // One parameter, referenced twice. Never interpolated: `q` is free text straight off the
      // query string, and this is the only statement in the module a caller can put characters into.
      conditions.push(`(v.sku ILIKE $${parameters.length} OR p.name ILIKE $${parameters.length})`);
    }
    // The same predicates the row's own `low` flag is selected with — see `stock-sql.ts`. `low`
    // contains `out`, which is why this is one enum and not two independent booleans.
    if (query.status === 'low') conditions.push(SQL_LOW_STOCK);
    if (query.status === 'out') conditions.push(SQL_OUT_OF_STOCK);

    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;

    const [rows, counted] = await Promise.all([
      this.dataSource.query<StockPositionRow[]>(
        `SELECT ${STOCK_POSITION_COLUMNS}
           ${STOCK_POSITION_FROM}
          ${where}
          ORDER BY ${SQL_AVAILABLE} ASC, v.sku ASC
          LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
        [...parameters, limit, (page - 1) * limit],
      ),
      this.dataSource.query<{ count: number }[]>(
        `SELECT count(*)::int AS count
           ${STOCK_POSITION_FROM}
          ${where}`,
        parameters,
      ),
    ]);

    return { items: rows.map(toStockPosition), total: counted[0]?.count ?? 0, page, limit };
  }

  /**
   * `GET /admin/inventory/:variantId/transactions` — brief §32's history: "stock added, stock sold,
   * stock adjusted, reason, date, admin".
   *
   * **Newest first**, because a ledger is read from the top: the movement that explains the figure
   * an operator is staring at is the last one. `id` descending is the tiebreak, and it is
   * deliberately not a claim about order within a timestamp — `@CreateDateColumn` defaults to
   * `now()`, which is transaction-start time, so the seeder's opening `RECEIPT` rows and the several
   * `SALE` rows one order writes each share a timestamp exactly. A uuid tiebreak is arbitrary but
   * *total*, which is the property `LIMIT`/`OFFSET` actually needs; without it two pages can return
   * the same row and skip another.
   *
   * **A missing variant is a 404, not an empty page.** They are the same HTTP-shaped answer and
   * completely different facts: "this pack has no history" sends an operator to look for the write
   * that failed, when what happened is that they mistyped a uuid. `adjust` separates the identical
   * pair for the identical reason.
   *
   * The actor and the order are joined rather than resolved per row. Both are `ManyToOne` and
   * nullable, so neither can multiply the row count — a `LEFT JOIN` is exactly right and the page is
   * one statement.
   */
  async transactions(
    variantId: string,
    query: InventoryLedgerQueryDto,
  ): Promise<Paginated<AdminInventoryTransaction>> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)));

    const exists = await this.dataSource.getRepository(Inventory).exists({ where: { variantId } });
    if (!exists) throw noSuchVariant(variantId);

    const [rows, total] = await this.dataSource
      .getRepository(InventoryTransaction)
      .createQueryBuilder('txn')
      // `User.passwordHash` is `select: false`, so joining the actor cannot leak a hash.
      .leftJoinAndSelect('txn.actorUser', 'actor')
      .leftJoinAndSelect('txn.order', 'ord')
      .where('txn.variantId = :variantId', { variantId })
      .orderBy('txn.createdAt', 'DESC')
      .addOrderBy('txn.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { items: rows.map(toLedgerRow), total, page, limit };
  }

  /**
   * `PATCH /admin/inventory/:variantId/threshold` — the gap plan 9.1 carried forward and plan 9.2
   * closes. **Not in spec §6.4; that table needs the row added.**
   *
   * `CreateVariantDto.lowStockThreshold` was "the one place in spec §6.4's whole admin surface where
   * a threshold can be set at all", so until now a threshold was unchangeable once its variant
   * existed: the adjust route takes only a delta and a reason, `PATCH /admin/variants/:id`
   * deliberately excludes the field because it belongs to the `inventory` row, and the list is a
   * read.
   *
   * **A route of its own, and that is the point.** Two shapes were available and one of them is a
   * trap. Folding an optional `lowStockThreshold` into `AdjustStockDto` would have to make `delta`
   * optional to allow a threshold-only call, and then the endpoint's contract — the ledger row, the
   * reserved-floor condition, the `422` on a zero delta, the `stock.low` hook — would all depend on
   * which fields happened to be present in the body. A stock movement and a threshold correction
   * are different acts with different consequences and different audit trails, and the URL says so.
   *
   * **No ledger row, because no stock moved.** `inventory_transactions` is append-only and its
   * invariant is `SUM(delta) = inventory.onHand`; a row with `delta: 0` for a threshold change would
   * satisfy the sum and corrupt the meaning, exactly as `adjust` records for an adjustment of zero —
   * "an audit trail reads as authoritative, so a row recording a change that never happened is worse
   * than no row".
   *
   * **An audit row instead, in the same transaction as the change**, per plan 9.1's rule and
   * `AuditLogService`'s contract. A threshold is what decides whether the dashboard calls a variant
   * low and whether the reorder list shows it, so a silent change to one is a silent change to the
   * operator's whole picture of the warehouse.
   *
   * **Setting the threshold to what it already is writes nothing** — no update, no audit row — and
   * answers the current position. Plan 9.1's rule, including for idempotent calls.
   *
   * **It does not queue `stock.low`, and that is a decision rather than an omission.** The full
   * reasoning is in the commit; the short form is three things. `checkLowStock`'s contract is "once
   * per crossing, never once per read", and it derives `previous` as `onHand - delta` from the write
   * that just happened — a threshold move has no delta, so calling it with `delta: 0` makes
   * `previous === onHand` and the guard degenerates into "is it low now?", which fires again on
   * every subsequent raise: two corrections 5 -> 20 -> 25 would both notify for a variant that never
   * moved a pack. Getting the dedupe right instead would mean a second definition of "crossing"
   * keyed on the threshold, i.e. a second definition of low, which is the drift both `stock-sql.ts`
   * and spec §10.1 exist to prevent. And the notification would be told to the person who just
   * caused it, about a row they were looking at when they did — while a batch tidy-up across 216
   * variants would send one per variant. The state is not lost: `?status=low` and the dashboard card
   * show it immediately, which is the right medium for a standing condition the operator created
   * deliberately. If a *scheduled* low-stock digest is ever added, it should read those, not this.
   */
  async setThreshold(
    variantId: string,
    input: { lowStockThreshold: number; actorUserId: string },
  ): Promise<AdminInventoryRow> {
    return this.dataSource.transaction(async (manager) => {
      const inventory = await manager.getRepository(Inventory).findOne({ where: { variantId } });
      if (inventory === null) throw noSuchVariant(variantId);

      /**
       * Captured **before** the write, not read back off the entity afterwards.
       *
       * `Repository.update` does not mutate the loaded entity today, so
       * `inventory.lowStockThreshold` would still hold the old value below — but the audit row's
       * `before` would then be correct only because of an ORM implementation detail, and the unit
       * fake (whose fixture row *is* the object it hands back) proved how that reads when the
       * assumption does not hold: `before` and `after` both reported the new threshold, an audit row
       * claiming a change from 25 to 25.
       */
      const previous = inventory.lowStockThreshold;

      if (previous === input.lowStockThreshold) {
        return this.stockPosition(manager, variantId);
      }

      // `update`, not `save`: `save` would write back every column of the entity that was just
      // read, including `onHand` and `reserved`, so a concurrent adjustment committed between the
      // read and the write would be silently undone by a threshold edit. `@UpdateDateColumn` still
      // stamps `updatedAt` — see `AdminInventoryRow.updatedAt`, which says so on the wire.
      await manager
        .getRepository(Inventory)
        .update({ variantId }, { lowStockThreshold: input.lowStockThreshold });

      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: AuditAction.INVENTORY_UPDATE,
        entityType: AuditEntity.INVENTORY,
        entityId: variantId,
        before: { lowStockThreshold: previous },
        after: { lowStockThreshold: input.lowStockThreshold },
      });

      return this.stockPosition(manager, variantId);
    });
  }

  /**
   * One stock position, selected by the same statement the list selects — so a threshold change
   * answers with a row a client can drop straight back into the table it came from, and `low` cannot
   * mean one thing in the list and another in the reply to the write that changed it.
   *
   * Takes the caller's `manager` so the read inside `setThreshold`'s transaction sees the update it
   * just made. Through the `DataSource` it would not.
   */
  private async stockPosition(
    manager: EntityManager,
    variantId: string,
  ): Promise<AdminInventoryRow> {
    const rows = await manager.query<StockPositionRow[]>(
      `SELECT ${STOCK_POSITION_COLUMNS}
         ${STOCK_POSITION_FROM}
        WHERE i.variant_id = $1`,
      [variantId],
    );
    const row = rows[0];
    if (row === undefined) throw noSuchVariant(variantId);
    return toStockPosition(row);
  }
}
