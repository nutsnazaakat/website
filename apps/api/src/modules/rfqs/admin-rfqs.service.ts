import { HttpStatus, Injectable } from '@nestjs/common';
import { toPaise, type AdminRfq, type AdminRfqSummary, type Paginated } from '@nutwala/shared';
import { DataSource, In, type EntityManager } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { RfqNote } from '../../entities/b2b/rfq-note.entity';
import { Rfq } from '../../entities/b2b/rfq.entity';
import { RfqKind, UserRole } from '../../entities/enums';
import { User } from '../../entities/identity/user.entity';
import { AuditAction, AuditEntity, AuditLogService } from '../admin/audit-log.service';
import { toAdminRfq, toAdminRfqSummary } from './mappers/admin-rfq.mapper';
import type { AddRfqNoteDto } from './dto/add-rfq-note.dto';
import type { AdminRfqQueryDto } from './dto/admin-rfq-query.dto';
import type { UpdateRfqDto } from './dto/update-rfq.dto';
import { RfqStatusService } from './rfq-status.service';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

/** The wire kind a filter names, mapped to the column's enum. Never `toUpperCase()`: `@IsIn` has
 * already refused anything outside the tuple, and this is the map that cannot grow on one side
 * alone. */
const KIND: Record<'bulk' | 'gifting', RfqKind> = {
  bulk: RfqKind.BULK,
  gifting: RfqKind.GIFTING,
};

/**
 * The operator's half of RFQs — spec §6.4's `/admin/rfqs` block, brief §34.
 *
 * **A second service beside `RfqsService`, not extra methods on it**, and the difference is the one
 * thing that must not blur: every read in `RfqsService` carries `userId` in its `where` clause, and
 * its docblock calls that *"the actual guard"* against a stranger's enquiry being reachable. An
 * admin read has no owner to scope to — the console triages the shop's queue — so an `Rfq` fetched
 * here is fetched by `rfqNumber` alone. Putting an unscoped read beside the scoped ones would leave
 * a method one careless reuse away from serving a prospect somebody else's enquiry.
 *
 * **`notesList` is loaded here and nowhere else.** `RfqsService.findOne` deliberately does not
 * select it, and `RfqDetail` declares no field for it, because `rfq-note.entity.ts` says internal
 * notes are *"never exposed on a customer-facing endpoint"*. This is the endpoint they exist for.
 */
@Injectable()
export class AdminRfqsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly statuses: RfqStatusService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * `GET /admin/rfqs` — brief §34's queue: filterable by status and kind, searchable, paginated.
   *
   * **Ordered `createdAt DESC`, then `rfqNumber DESC`**, and the tiebreak is not decoration.
   * `@CreateDateColumn` defaults to `now()`, which under Postgres is *transaction-start* time, so
   * several enquiries written in one transaction — every seeded fixture, and any batch import —
   * share one timestamp exactly. An unstable tiebreak over `LIMIT`/`OFFSET` returns the same
   * enquiry on two pages and loses another entirely. `rfqNumber` carries `uq_rfqs_rfq_number`, so
   * it is arbitrary but *total*, which is the property paging actually needs.
   *
   * **`items` is joined for the list, unlike `AdminOrderSummary`'s deliberate refusal to join a
   * basket.** Brief §34 names "products, quantity" as two of the row's own columns, so the lines
   * *are* the row; and `CreateRfqDto` caps an enquiry at twenty of them, against an order's
   * unbounded basket plus its timeline. `getManyAndCount` issues the count as a second statement
   * over the same `where`, so the join cannot make the total count line items instead of enquiries.
   */
  async list(query: AdminRfqQueryDto): Promise<Paginated<AdminRfqSummary>> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)));

    const builder = this.dataSource
      .getRepository(Rfq)
      .createQueryBuilder('rfq')
      .leftJoinAndSelect('rfq.items', 'item');

    if (query.status !== undefined) {
      builder.andWhere('rfq.status = :status', { status: query.status });
    }
    if (query.kind !== undefined) {
      builder.andWhere('rfq.kind = :kind', { kind: KIND[query.kind] });
    }
    if (query.q !== undefined && query.q.trim() !== '') {
      builder.andWhere(
        `(rfq.rfqNumber ILIKE :q
          OR rfq.businessName ILIKE :q
          OR rfq.contactPerson ILIKE :q
          OR rfq.email ILIKE :q)`,
        { q: `%${query.q.trim()}%` },
      );
    }

    const [rows, total] = await builder
      .orderBy('rfq.createdAt', 'DESC')
      .addOrderBy('rfq.rfqNumber', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const salespeople = await this.salespeopleFor(rows);

    return {
      items: rows.map((rfq) =>
        toAdminRfqSummary(rfq, {
          salesperson:
            rfq.assignedSalespersonId === null
              ? null
              : (salespeople.get(rfq.assignedSalespersonId) ?? null),
        }),
      ),
      total,
      page,
      limit,
    };
  }

  /**
   * `GET /admin/rfqs/:rfqNumber` — one enquiry in full, with its lines, its gifting detail and its
   * note history.
   *
   * **`:rfqNumber`, not `:id`.** Spec §6.4 spells this row `GET /admin/rfqs/:id`, and an RFQ does
   * have a uuid — but nothing addresses one by it: `RfqSummary.id` *is* the number,
   * `RfqsController` is `:rfqNumber` on its own detail route, and the number is what a prospect
   * quotes down a phone line. The same correction §6.4 already carries for
   * `PATCH /admin/inventory/:variantId` and the four order routes.
   *
   * The note history is newest first — an operator picking up an enquiry reads the last thing said
   * about it, not the first. `rfq_notes.createdAt` is a `@CreateDateColumn` and shares the same
   * transaction-time hazard as everything else here, so `id` is the tiebreak.
   */
  async get(rfqNumber: string): Promise<AdminRfq> {
    const rfq = await this.loadOrThrow(rfqNumber);
    const salespeople = await this.salespeopleFor([rfq]);

    return toAdminRfq(rfq, {
      salesperson:
        rfq.assignedSalespersonId === null
          ? null
          : (salespeople.get(rfq.assignedSalespersonId) ?? null),
    });
  }

  /**
   * The read behind the detail route and, from plan 9.3 Task 4, behind every write's reply — so no
   * two of them can answer different shapes.
   *
   * Public rather than private because `AdminRfqsService`'s own write methods are its only other
   * callers and they all reload through it; a second `findOne` with a different `relations` clause
   * is how a reply comes to omit the note somebody just added.
   */
  async loadOrThrow(rfqNumber: string): Promise<Rfq> {
    const rfq = await this.dataSource.getRepository(Rfq).findOne({
      where: { rfqNumber },
      relations: { items: true, gifting: true, notesList: { authorUser: true } },
      order: { notesList: { createdAt: 'DESC', id: 'DESC' } },
    });

    if (rfq === null) throw noSuchRfq(rfqNumber);

    return rfq;
  }

  /**
   * `PATCH /admin/rfqs/:rfqNumber` — spec §6.4's `PATCH /admin/rfqs/:id`, brief §34's three
   * editable facts: status, assigned salesperson, expected value.
   *
   * **One transaction covering all three**, joined by `RfqTransitionOptions.manager`. The status
   * move, the field write and both audit rows commit together or not at all; without that, a
   * failure between them would leave an enquiry the operator was told had moved to `quote-sent`
   * whose expected value never changed, with an audit trail claiming both.
   *
   * **The transition goes first, so a refusal costs no write.** An illegal move is refused with the
   * same `422 ILLEGAL_STATUS_TRANSITION` carrying `allowed` that the order route answers, and the
   * salesperson and value are left exactly as they were. `AdminOrdersService.createShipment` orders
   * its own work the same way for the same reason.
   *
   * **Everything about the move is `RfqStatusService`'s**, deliberately: the legality check against
   * `RFQ_TRANSITIONS`, the guarded `UPDATE`, the `rfq.status-changed` notification and the
   * `rfq.status-change` audit row. Re-implementing any of it here would be the second copy that
   * drifts. What this method contributes is the actor, the two other fields, and re-reading the
   * enquiry so the console renders the committed result.
   *
   * **A request that changes nothing writes nothing** — no audit row, not even for a `status` equal
   * to the one the enquiry already holds, which `canTransitionRfq` refuses as a no-op with a 422
   * rather than accepting silently. A field set to the value it already has is dropped by the diff.
   */
  async update(
    rfqNumber: string,
    input: UpdateRfqDto & { actorUserId: string },
  ): Promise<AdminRfq> {
    await this.dataSource.transaction(async (manager) => {
      if (input.status !== undefined) {
        await this.statuses.transition(rfqNumber, input.status, {
          manager,
          // Recorded inside the transition's own transaction — spec §5, and the only place it can
          // be atomic with the change. See `RfqTransitionOptions.audit`.
          audit: { actorUserId: input.actorUserId },
        });
      }

      const rfq = await manager.getRepository(Rfq).findOne({ where: { rfqNumber } });
      // Unreachable once `transition` has answered for the same reference, and the honest answer
      // for a PATCH that names only the fields.
      if (rfq === null) throw noSuchRfq(rfqNumber);

      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const patch: { assignedSalespersonId?: string | null; expectedValuePaise?: bigint | null } =
        {};

      if (input.assignedSalespersonId !== undefined) {
        if (input.assignedSalespersonId !== null) {
          await this.requireAdmin(manager, input.assignedSalespersonId);
        }
        if (rfq.assignedSalespersonId !== input.assignedSalespersonId) {
          before.assignedSalespersonId = rfq.assignedSalespersonId;
          after.assignedSalespersonId = input.assignedSalespersonId;
          patch.assignedSalespersonId = input.assignedSalespersonId;
        }
      }

      if (input.expectedValue !== undefined) {
        // Rupees in, paise stored — spec §8's boundary, converted once and never re-derived.
        const value = input.expectedValue === null ? null : toPaise(input.expectedValue);
        if (rfq.expectedValuePaise !== value) {
          // Serialised as strings: `audit_logs.before`/`.after` are jsonb, and `JSON.stringify`
          // **throws** on a bigint rather than dropping it — so a raw paise value here would fail
          // the whole transaction at the driver, which is a real defect wearing a type error's
          // clothes. Rupees would be the other option and are worse: the trail would then disagree
          // with the column it describes.
          before.expectedValuePaise =
            rfq.expectedValuePaise === null ? null : String(rfq.expectedValuePaise);
          after.expectedValuePaise = value === null ? null : String(value);
          patch.expectedValuePaise = value;
        }
      }

      if (Object.keys(patch).length === 0) return;

      await manager.getRepository(Rfq).update({ id: rfq.id }, patch);
      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: AuditAction.RFQ_UPDATE,
        entityType: AuditEntity.RFQ,
        entityId: rfq.id,
        before,
        after: { ...after, rfqNumber: rfq.rfqNumber },
      });
    });

    return this.get(rfqNumber);
  }

  /**
   * `POST /admin/rfqs/:rfqNumber/notes` — brief §34's *"Allow internal notes"*.
   *
   * **The note goes to `rfq_notes` and never to `rfqs.notes`, and the two are not the same
   * thing.** `RfqNote` is the internal history: an entity whose own docblock says *"Never exposed
   * on a customer-facing endpoint"*, carrying an author (`ON DELETE RESTRICT`), a timestamp and a
   * body, appended to. `rfqs.notes` is a single `text` column holding what the **prospect** typed
   * into brief §17's "additional requirements" box — `CreateRfqDto.notes` writes it,
   * `RfqDetail.notes` shows it straight back to them, and `toAdminRfq` surfaces it under the same
   * name. Writing a sales note there would do two things at once, both bad: destroy what the
   * customer wrote, and publish a confidential note to the customer on their own enquiry page. The
   * column is therefore **not legacy** and is not written here; `admin-rfqs.integration.spec.ts`
   * asserts it is unchanged by a note, and that the note is absent from `GET /rfqs/:rfqNumber`.
   *
   * The audit row is in the same transaction as the note. It carries the note's id and the RFQ's
   * number and **not the body** — the `rfq_notes` row is the record, and copying confidential text
   * into a second table is a second place it has to be protected. See `AuditAction.RFQ_NOTE_ADD`.
   *
   * A blank body is refused rather than stored: `@MinLength(1)` cannot see through surrounding
   * whitespace, and a note with no content still appears in the history as though something was
   * said.
   */
  async addNote(
    rfqNumber: string,
    input: AddRfqNoteDto & { actorUserId: string },
  ): Promise<AdminRfq> {
    const body = input.body.trim();
    if (body === '') {
      throw new DomainError(
        ErrorCodes.VALIDATION_FAILED,
        'A note needs something in it.',
        HttpStatus.BAD_REQUEST,
        { field: 'body' },
      );
    }

    await this.dataSource.transaction(async (manager) => {
      const rfq = await manager.getRepository(Rfq).findOne({ where: { rfqNumber } });
      if (rfq === null) throw noSuchRfq(rfqNumber);

      const note = await manager
        .getRepository(RfqNote)
        .save(
          manager
            .getRepository(RfqNote)
            .create({ rfqId: rfq.id, authorUserId: input.actorUserId, body }),
        );

      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: AuditAction.RFQ_NOTE_ADD,
        entityType: AuditEntity.RFQ,
        entityId: rfq.id,
        // A create has no `before` — `AuditLogInput` says so, and the column stores null.
        after: { noteId: note.id, rfqNumber: rfq.rfqNumber },
      });
    });

    return this.get(rfqNumber);
  }

  /**
   * The account named as a salesperson must exist **and be an admin**.
   *
   * `business.entity.ts` settled that a salesperson is *"an admin user, not a separate staff
   * table"*, and the column is a bare `users(id)` reference, so nothing at the database level stops
   * an enquiry being assigned to a customer — whose name would then appear on the operator's queue,
   * and whose account would be one `GET /admin/rfqs` away from looking like staff.
   *
   * A **404 naming the id** for both "no such user" and "not an admin", the same shape
   * `BusinessesService.requireOwnedAddress` answers with and for the same reason: a distinguishable
   * refusal would make this endpoint an oracle for which uuids are operator accounts, which is
   * exactly what `GET /admin/customers/:id` is arranged not to be.
   */
  private async requireAdmin(manager: EntityManager, id: string): Promise<void> {
    const found = await manager
      .getRepository(User)
      .findOne({ where: { id, role: UserRole.ADMIN } });

    if (found === null) {
      throw new DomainError(ErrorCodes.NOT_FOUND, `No admin user ${id}.`, HttpStatus.NOT_FOUND, {
        assignedSalespersonId: id,
      });
    }
  }

  /**
   * The admins named as `assigned_salesperson_id` across a page, in one read.
   *
   * A `leftJoinAndSelect` onto the relation would be simpler and is wrong here: the relation is a
   * `User`, so joining it would load `users` rows into the same query the lines are joined into,
   * multiplying an already-multiplied result — and `User` carries `passwordHash`, which
   * `toAdminSalesperson` refuses to publish but which a hydrated entity would then be carrying
   * around the request. Two statements, and the second is skipped entirely when no row names
   * anybody.
   */
  private async salespeopleFor(rfqs: readonly Rfq[]): Promise<Map<string, User>> {
    const ids = [
      ...new Set(
        rfqs.map((rfq) => rfq.assignedSalespersonId).filter((id): id is string => id !== null),
      ),
    ];
    if (ids.length === 0) return new Map();

    const rows = await this.dataSource.getRepository(User).find({ where: { id: In(ids) } });
    return new Map(rows.map((row) => [row.id, row]));
  }
}

/** The one refusal every route on this service answers with, in `RfqStatusService.transition`'s own
 * words — so a mistyped reference reads identically whether it was caught by the read, by the
 * transition or by a write. */
function noSuchRfq(rfqNumber: string): DomainError {
  return new DomainError(ErrorCodes.NOT_FOUND, `No RFQ ${rfqNumber}.`, HttpStatus.NOT_FOUND, {
    rfqNumber,
  });
}
