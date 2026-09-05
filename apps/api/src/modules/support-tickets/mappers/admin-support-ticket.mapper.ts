import type {
  AdminSupportTicket,
  AdminSupportTicketNote,
  AdminSupportTicketSummary,
  SupportTicketStatus,
} from '@nutwala/shared';
import type { SupportTicket } from '../../../entities/ops/support-ticket.entity';
import type { SupportTicketNote } from '../../../entities/ops/support-ticket-note.entity';

/**
 * `support_tickets.status` is a plain `varchar(20)` with a `ck_support_tickets_status` check
 * constraint, not a Postgres enum — so unlike every other status in this codebase there is no
 * database enum to map *from*, and the column already holds the wire spelling.
 *
 * That makes the cast below the one place the two vocabularies meet, and it is narrow rather than
 * loose: the constraint enforces exactly `SUPPORT_TICKET_STATUSES`' five values at the database,
 * `ChangeSupportTicketDto` enforces the same tuple on the way in, and `schema-invariants` covers
 * the constraint itself. A row outside the union cannot be written through any path this service
 * owns. Spelled as a function rather than inline so there is one place to change if the column ever
 * becomes an enum with an uppercase vocabulary of its own.
 */
function toWireStatus(status: string): SupportTicketStatus {
  return status as SupportTicketStatus;
}

export function toAdminSupportTicketSummary(ticket: SupportTicket): AdminSupportTicketSummary {
  return {
    ticketNumber: ticket.ticketNumber,
    name: ticket.name,
    email: ticket.email,
    phone: ticket.phone,
    topic: ticket.topic,
    status: toWireStatus(ticket.status),
    priority: ticket.priority,
    orderNumber: ticket.orderNumber,
    assignedToUserId: ticket.assignedToUserId,
    userId: ticket.userId,
    createdAt: ticket.createdAt.toISOString(),
    resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
  };
}

/**
 * One note, with its author's name resolved.
 *
 * `authorName` is passed in rather than read off `note.authorUser`, because the ticket detail
 * resolves every author in one query — a relation load per note would be one round trip per line
 * of the conversation. `AdminInventoryTransaction.actorName` exists for the same reason: a trail of
 * bare uuids sends the operator to a second endpoint per row.
 *
 * `authorUserId` is `ON DELETE RESTRICT`, so unlike a stock movement's actor there is always a real
 * account behind a note and the name is never null. The fallback is therefore a bug report rather
 * than an expected case.
 */
export function toAdminSupportTicketNote(
  note: SupportTicketNote,
  authorName: string | undefined,
): AdminSupportTicketNote {
  return {
    id: note.id,
    body: note.body,
    isInternal: note.isInternal,
    authorUserId: note.authorUserId,
    authorName: authorName ?? 'Unknown',
    createdAt: note.createdAt.toISOString(),
  };
}

export function toAdminSupportTicket(
  ticket: SupportTicket,
  notes: AdminSupportTicketNote[],
): AdminSupportTicket {
  return {
    ...toAdminSupportTicketSummary(ticket),
    message: ticket.message,
    updatedAt: ticket.updatedAt.toISOString(),
    notes,
  };
}
