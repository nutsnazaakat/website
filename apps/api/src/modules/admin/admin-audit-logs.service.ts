import { Injectable } from '@nestjs/common';
import type { AdminAuditLogEntry, Paginated } from '@nutwala/shared';
import { DataSource, In } from 'typeorm';
import { AuditLog } from '../../entities/ops/audit-log.entity';
import { User } from '../../entities/identity/user.entity';
import { businessTimezone, DATE_ONLY_PATTERN } from '../settings/business-timezone';
import type { AuditLogQueryDto } from './dto/audit-log-query.dto';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

/**
 * `GET /admin/audit-logs` — spec §6.4's last row, and the read half of spec §5's *"every
 * destructive admin action writes an audit-log row"*.
 *
 * ---
 *
 * **Stock movements are not in this trail, and that is a decision rather than a gap.**
 *
 * Say it here, on the wire (`AdminAuditLogEntry`), and in `AuditAction`'s own docblock, because the
 * failure mode is an operator opening this page to find out who wrote off 40kg of cashews, finding
 * nothing, and concluding the audit trail is broken.
 *
 * Plan 9.2 decided that the `inventory_transactions` ledger **is** the audit trail for stock: it is
 * append-only and carries the delta, the reason, the resulting balance and the acting admin, which
 * is brief §32's history in full. A second row in `audit_logs` saying the same thing would be a
 * second place to look and a second thing to keep in step. So no `AuditAction` member exists for a
 * stock movement and none should.
 *
 * What *is* here for inventory is `inventory.update` — a change to a stock row's **threshold**,
 * which moves no stock. The two are told apart by exactly that: if stock moved, it is in
 * `GET /admin/inventory/:variantId/transactions`.
 *
 * Two further absences worth stating, since an empty result is otherwise ambiguous:
 *
 * - **Customer actions are not here.** Placing an order, writing a review, cancelling an order — a
 *   customer's own writes leave no `audit_logs` row, because `actor_user_id` is `NOT NULL` and
 *   `ON DELETE RESTRICT`, and this table is about what *admins* did. An order's own history is its
 *   `order_events` timeline.
 * - **`ip` and `userAgent` are always null.** They exist for a request-scoped `AuditInterceptor`
 *   the initial schema anticipated and nobody built; `AuditLogService` writes from inside a
 *   transaction and has no request to read them from. They are not on `AdminAuditLogEntry` at all,
 *   rather than being published as columns that are always empty.
 *
 * ---
 *
 * **Read-only, and there is deliberately no write path here.** `AuditLogService.record` is the one
 * writer, and it takes the caller's open transaction so the row and the change it describes commit
 * together. This service takes the `DataSource` and only ever reads.
 */
@Injectable()
export class AdminAuditLogsService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Newest first, with a **total** tiebreak.
   *
   * `createdAt` is a `@CreateDateColumn` stamped at transaction-start time, so every row written by
   * one request shares it exactly — `POST /admin/orders/:orderNumber/shipment` writes a
   * `shipment.create` and an `order.status-change` at the identical timestamp, and
   * `PUT /admin/settings` writes one per changed key. Without a second key a `LIMIT`/`OFFSET`
   * window returns one row on two pages and loses another, and nothing about a single page would
   * look wrong. `id` is the table's uuid primary key, so it is arbitrary but *total*, which is what
   * paging needs. `AdminOrdersService.list` records the same trap.
   *
   * **Two statements, not a join.** The rows come back first, then the actors' names in one
   * `WHERE id IN` — a `leftJoinAndSelect` onto `users` would load a whole `User` entity per row,
   * password hash included, to render one name. `AdminSupportTicketsService.reload` resolves note
   * authors the same way.
   */
  async list(query: AuditLogQueryDto): Promise<Paginated<AdminAuditLogEntry>> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)));

    const builder = this.dataSource.getRepository(AuditLog).createQueryBuilder('log');

    if (query.actorUserId !== undefined) {
      builder.andWhere('log.actorUserId = :actorUserId', { actorUserId: query.actorUserId });
    }
    if (query.entity !== undefined) {
      builder.andWhere('log.entity = :entity', { entity: query.entity });
    }
    if (query.entityId !== undefined) {
      builder.andWhere('log.entityId = :entityId', { entityId: query.entityId });
    }
    if (query.action !== undefined) {
      builder.andWhere('log.action = :action', { action: query.action });
    }

    /**
     * The same date rule as `GET /admin/orders`, through the same reader — spec §5b's "every dated
     * admin figure at once", applied to a filter this plan introduced rather than inherited. A
     * date-only bound is a day in the business's timezone; a full instant is used as sent. See
     * `AdminOrdersService.list` for why the upper bound is a strict `<` on the following midnight.
     */
    if (query.from !== undefined || query.to !== undefined) {
      const timezone = await businessTimezone(this.dataSource.manager);

      if (query.from !== undefined) {
        if (DATE_ONLY_PATTERN.test(query.from)) {
          builder.andWhere('log.createdAt >= (CAST(:from AS timestamp) AT TIME ZONE :fromZone)', {
            from: query.from,
            fromZone: timezone,
          });
        } else {
          builder.andWhere('log.createdAt >= :from', { from: new Date(query.from) });
        }
      }

      if (query.to !== undefined) {
        if (DATE_ONLY_PATTERN.test(query.to)) {
          builder.andWhere(
            `log.createdAt < ((CAST(:to AS timestamp) + INTERVAL '1 day') AT TIME ZONE :toZone)`,
            { to: query.to, toZone: timezone },
          );
        } else {
          builder.andWhere('log.createdAt <= :to', { to: new Date(query.to) });
        }
      }
    }

    const [rows, total] = await builder
      .orderBy('log.createdAt', 'DESC')
      .addOrderBy('log.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const names = await this.actorNames(rows.map((row) => row.actorUserId));

    return {
      items: rows.map((row) => ({
        id: row.id,
        action: row.action,
        entity: row.entity,
        entityId: row.entityId,
        actorUserId: row.actorUserId,
        // `actor_user_id` is `NOT NULL` and `ON DELETE RESTRICT`, so a name is always found. The
        // fallback is a bug report, not an expected case — the same position
        // `toAdminSupportTicketNote` takes about a note's author.
        actorName: names.get(row.actorUserId) ?? 'Unknown',
        before: row.before,
        after: row.after,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      page,
      limit,
    };
  }

  private async actorNames(actorIds: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(actorIds)];
    if (unique.length === 0) return new Map();

    const users = await this.dataSource
      .getRepository(User)
      // `select` is not an optimisation here so much as a boundary: this table holds
      // `passwordHash`, and a trail rendering a name has no business loading one.
      .find({ where: { id: In(unique) }, select: { id: true, name: true } });
    return new Map(users.map((user) => [user.id, user.name]));
  }
}
