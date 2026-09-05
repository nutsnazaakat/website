import { HttpStatus, Injectable } from '@nestjs/common';
import type { AdminSupportTicket, AdminSupportTicketSummary, Paginated } from '@nutwala/shared';
import { DataSource, In, type EntityManager } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { UserRole } from '../../entities/enums';
import { User } from '../../entities/identity/user.entity';
import { SupportTicket } from '../../entities/ops/support-ticket.entity';
import { SupportTicketNote } from '../../entities/ops/support-ticket-note.entity';
import { AuditAction, AuditEntity, AuditLogService } from '../admin/audit-log.service';
import type {
  AdminSupportTicketQueryDto,
  ChangeSupportTicketDto,
  CreateSupportTicketNoteDto,
} from './dto/admin-support-ticket.dto';
import {
  toAdminSupportTicket,
  toAdminSupportTicketNote,
  toAdminSupportTicketSummary,
} from './mappers/admin-support-ticket.mapper';
import { TICKET_NUMBER_PATTERN } from './ticket-number';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

/** The status that means the customer's problem is over. See `resolvedAtFor`. */
const RESOLVED = 'resolved';
/** Terminal, but not itself a resolution: a ticket can be closed without ever being resolved. */
const CLOSED = 'closed';

interface TicketSnapshot {
  status: string;
  priority: number;
  assignedToUserId: string | null;
  resolvedAt: string | null;
}

function snapshot(ticket: SupportTicket): TicketSnapshot {
  return {
    status: ticket.status,
    priority: ticket.priority,
    assignedToUserId: ticket.assignedToUserId,
    resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
  };
}

/** The changed fields only, or null when nothing moved. `AdminCategoriesService`'s helper verbatim. */
function diff(
  before: TicketSnapshot,
  after: TicketSnapshot,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  for (const key of Object.keys(before) as (keyof TicketSnapshot)[]) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    changedBefore[key] = before[key];
    changedAfter[key] = after[key];
  }

  return Object.keys(changedAfter).length === 0
    ? null
    : { before: changedBefore, after: changedAfter };
}

/**
 * `resolvedAt` for a status move, so the column can never contradict the status beside it.
 *
 * Three rules, and each one is a case an operator meets:
 *
 * - **Entering `resolved` stamps now**, freshly each time. A ticket reopened and resolved again has
 *   a *new* resolution date, because the first one did not hold — keeping the original would report
 *   a resolution that was later undone.
 * - **Leaving `resolved` for `new` / `open` / `waiting` clears it.** A resolution date on an open
 *   ticket is simply false, and it is the figure any "time to resolve" report would read.
 * - **`resolved` → `closed` keeps it.** Closing a resolved ticket does not unresolve it, and a
 *   ticket closed without ever being resolved keeps its null — which is exactly the distinction
 *   between "we fixed it" and "the customer stopped replying".
 *
 * Deliberately *not* the `publishedAt` rule, which is stamp-once-never-clear. A post that is
 * unpublished was still, historically, published; a ticket that is reopened is not resolved now,
 * and this column answers a question about the present.
 */
function resolvedAtFor(
  currentStatus: string,
  nextStatus: string,
  currentResolvedAt: Date | null,
): Date | null {
  if (nextStatus === RESOLVED) {
    return currentStatus === RESOLVED ? currentResolvedAt : new Date();
  }
  if (nextStatus === CLOSED) return currentResolvedAt;
  return null;
}

/**
 * Brief §38's support queue, read and worked — spec §6.4's `/admin/support/tickets` block.
 *
 * **Milestone 8 built `POST /contact` and deliberately no read routes** — "no route reads a ticket
 * back yet", in `SupportTicketsService`'s own words. These are them.
 *
 * **Addressed by `:ticketNumber`.** §6.4 spells these `:id`; `TICKET_NUMBER_PATTERN` is a
 * committed, tested contract in `shared/`, `uq_support_tickets_ticket_number` makes it unique, and
 * `ST-2026-000123` is the reference the customer was given in the reply to their contact form and
 * will quote back. Consistent with `:orderNumber` and `:rfqNumber`, and §6.4 needs the same
 * correction it already carries for `PATCH /admin/inventory/:variantId`.
 *
 * **A second service beside `SupportTicketsService`, not extra methods on it.** That one is reached
 * from `POST /contact`, which is `@Public()` and rate-limited; every method here is behind
 * `@Roles(ADMIN)` and reads rows no customer may see. Keeping an unscoped read out of the public
 * service is the rule `AdminOrdersService` states at length.
 *
 * **`orderNumber` is not resolved to an order here**, and that is worth saying because §6.4's table
 * implies an admin would want it joined. `SupportTicket`'s own docblock is explicit that it is a
 * soft link — "a customer may type an order number that does not exist or belongs to someone else,
 * and the ticket must still be created" — so it travels as the string the customer typed, and the
 * console looks it up through `GET /admin/orders/:orderNumber` if it wants to. Joining it here
 * would have to answer what a non-existent order means in the middle of a ticket list.
 */
@Injectable()
export class AdminSupportTicketsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * `GET /admin/support/tickets` — newest first, `ticketNumber` as the tiebreak.
   *
   * Newest first rather than oldest, unlike the review moderation queue, and the difference is real:
   * a review queue is worked to exhaustion in order, while a support desk triages what has just
   * arrived and uses `?status=` and `?priority` to find the rest. `ticketNumber` carries
   * `uq_support_tickets_ticket_number`, so it is arbitrary but *total*, which is what stable paging
   * over `LIMIT`/`OFFSET` needs — `createdAt` alone is not unique.
   *
   * No `notes` relation: a page of 24 tickets would be 24 conversations. `AdminSupportTicketSummary`
   * omits both the message and the notes for the reason `AdminOrderSummary` omits items and
   * timelines.
   */
  async list(query: AdminSupportTicketQueryDto): Promise<Paginated<AdminSupportTicketSummary>> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)));

    const builder = this.dataSource.getRepository(SupportTicket).createQueryBuilder('ticket');
    if (query.status !== undefined) {
      builder.andWhere('ticket.status = :status', { status: query.status });
    }
    if (query.topic !== undefined) {
      builder.andWhere('ticket.topic = :topic', { topic: query.topic });
    }
    if (query.assignedToUserId !== undefined) {
      builder.andWhere('ticket.assignedToUserId = :assignedToUserId', {
        assignedToUserId: query.assignedToUserId,
      });
    }

    const [rows, total] = await builder
      .orderBy('ticket.createdAt', 'DESC')
      .addOrderBy('ticket.ticketNumber', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { items: rows.map(toAdminSupportTicketSummary), total, page, limit };
  }

  /** `GET /admin/support/tickets/:ticketNumber` — the ticket, its message and its note trail. */
  async get(ticketNumber: string): Promise<AdminSupportTicket> {
    return this.reload(this.dataSource.manager, ticketNumber);
  }

  /**
   * `PATCH /admin/support/tickets/:ticketNumber` — status, priority and assignment, in one write.
   *
   * All three in one endpoint because an operator moves two at once as a matter of course ("assign
   * it to me and mark it open"), and splitting them would make that two requests with a window in
   * between where the ticket is assigned but still `new`.
   */
  async update(
    ticketNumber: string,
    input: ChangeSupportTicketDto & { actorUserId: string },
  ): Promise<AdminSupportTicket> {
    return this.dataSource.transaction(async (manager) => {
      const ticket = await this.loadOrThrow(manager, ticketNumber);
      const before = snapshot(ticket);

      if (input.assignedToUserId !== undefined) {
        if (input.assignedToUserId !== null) {
          await this.assertAssignable(manager, input.assignedToUserId);
        }
        ticket.assignedToUserId = input.assignedToUserId;
      }
      if (input.priority !== undefined) ticket.priority = input.priority;
      if (input.status !== undefined) {
        ticket.resolvedAt = resolvedAtFor(ticket.status, input.status, ticket.resolvedAt);
        ticket.status = input.status;
      }

      const changed = diff(before, snapshot(ticket));
      // A write that changes nothing writes no audit row — plan 9.1's rule. A PATCH with an empty
      // body reaches here and is a no-op rather than a 400, which is the right answer for a form
      // that submits every field whether or not the operator touched one.
      if (changed === null) return this.reload(manager, ticketNumber);

      await manager.getRepository(SupportTicket).save(ticket);
      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: AuditAction.SUPPORT_TICKET_UPDATE,
        entityType: AuditEntity.SUPPORT_TICKET,
        entityId: ticket.ticketNumber,
        before: changed.before,
        after: changed.after,
      });

      return this.reload(manager, ticketNumber);
    });
  }

  /**
   * `POST /admin/support/tickets/:ticketNumber/notes` — brief §38's internal notes.
   *
   * **Always writes**, unlike every other method here: a note is an append, and two identical notes
   * are two things somebody said rather than one write repeated. The no-op rule is about a *change*
   * that did not happen; nothing about this one is idempotent, and treating a repeated note as a
   * no-op would silently swallow a second agent's identical observation.
   *
   * The ticket itself is untouched — no status move, no `updatedAt` bump — because adding a note is
   * not triage. An agent who wants both sends the `PATCH` too, and the trail then carries the two
   * facts separately, which is what `SUPPORT_TICKET_NOTE` exists for.
   */
  async addNote(
    ticketNumber: string,
    input: CreateSupportTicketNoteDto & { actorUserId: string },
  ): Promise<AdminSupportTicket> {
    return this.dataSource.transaction(async (manager) => {
      const ticket = await this.loadOrThrow(manager, ticketNumber);

      const notes = manager.getRepository(SupportTicketNote);
      const created = await notes.save(
        notes.create({
          ticketId: ticket.id,
          authorUserId: input.actorUserId,
          body: input.body.trim(),
          // Staff-only unless the caller says otherwise, matching the column's default.
          isInternal: input.isInternal ?? true,
        }),
      );

      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: AuditAction.SUPPORT_TICKET_NOTE,
        entityType: AuditEntity.SUPPORT_TICKET,
        entityId: ticket.ticketNumber,
        // The note's id and visibility, not its text: the note itself lives in
        // `support_ticket_notes` and nothing edits or deletes one, so the trail needs only to say
        // that it was added and by whom — which `actorUserId` and `createdAt` already carry.
        after: { noteId: created.id, isInternal: created.isInternal },
      });

      return this.reload(manager, ticketNumber);
    });
  }

  /**
   * The one read that builds a detail, so the ticket an operator opens and the ticket they get back
   * from a write cannot be different shapes.
   *
   * Notes and their authors are two statements rather than a `relations: { notes: true }` load with
   * a nested user: TypeORM would issue the author join per note, and the names are a `WHERE id IN`
   * over a handful of admins. Oldest first, so the ticket reads as a conversation.
   */
  private async reload(manager: EntityManager, ticketNumber: string): Promise<AdminSupportTicket> {
    const ticket = await this.loadOrThrow(manager, ticketNumber);

    const notes = await manager.getRepository(SupportTicketNote).find({
      where: { ticketId: ticket.id },
      order: { createdAt: 'ASC', id: 'ASC' },
    });

    const authorIds = [...new Set(notes.map((note) => note.authorUserId))];
    const authors =
      authorIds.length === 0
        ? []
        : await manager.getRepository(User).find({
            where: { id: In(authorIds) },
            select: { id: true, name: true },
          });
    const nameById = new Map(authors.map((author) => [author.id, author.name]));

    return toAdminSupportTicket(
      ticket,
      notes.map((note) => toAdminSupportTicketNote(note, nameById.get(note.authorUserId))),
    );
  }

  /**
   * A **404 for a malformed reference**, not a 400.
   *
   * `TICKET_NUMBER_PATTERN` is checked here rather than by a pipe on the route, because the question
   * "is `ST-20-1` a ticket" has one honest answer and it is "no such ticket" — the same answer an
   * unknown but well-formed number gets. Two different statuses for two ways of naming a ticket
   * that does not exist would make this route an oracle for the number format, and would send an
   * operator who mistyped a reference hunting for a validation rule.
   */
  private async loadOrThrow(manager: EntityManager, ticketNumber: string): Promise<SupportTicket> {
    const notFound = new DomainError(
      ErrorCodes.NOT_FOUND,
      `No ticket ${ticketNumber}.`,
      HttpStatus.NOT_FOUND,
      { ticketNumber },
    );
    if (!TICKET_NUMBER_PATTERN.test(ticketNumber)) throw notFound;

    const ticket = await manager.getRepository(SupportTicket).findOne({ where: { ticketNumber } });
    if (!ticket) throw notFound;
    return ticket;
  }

  /**
   * `assigned_to_user_id` is a plain FK to `users`, which would accept a customer's id happily.
   *
   * A ticket assigned to a shopper is a ticket nobody is working that still reads as assigned, and
   * it would drop out of any "unassigned" view an operator built. So the role is checked, and the
   * refusal names the field rather than surfacing as a foreign-key error for a missing account.
   */
  private async assertAssignable(manager: EntityManager, userId: string): Promise<void> {
    const assignee = await manager
      .getRepository(User)
      .findOne({ where: { id: userId }, select: { id: true, role: true } });

    if (!assignee || assignee.role !== UserRole.ADMIN) {
      throw new DomainError(
        ErrorCodes.VALIDATION_FAILED,
        'A ticket can only be assigned to an admin account.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { field: 'assignedToUserId', value: userId },
      );
    }
  }
}
