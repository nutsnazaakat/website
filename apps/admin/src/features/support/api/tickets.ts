import type {
  AdminSupportTicket,
  AdminSupportTicketSummary,
  ContactTopic,
  Paginated,
  SupportTicketStatus,
} from "@/contract";
import { CONTACT_TOPICS, SUPPORT_TICKET_STATUSES } from "@/contract";
import { http } from "@/lib/http";
import { toQueryString } from "@/lib/query-string";

/**
 * The support seam — brief §38. `GET /admin/support/tickets`, its detail, `PATCH`, and the notes.
 *
 * Tickets arrive from the storefront's contact form (`POST /contact`), which is public: a visitor
 * who is not signed in raises one, so `userId` is legitimately null and `name`/`email` are what
 * they typed rather than an account's.
 *
 * **`orderNumber` is a soft link, not a foreign key.** A customer may type an order number that
 * does not exist, or one belonging to somebody else, and the ticket is still created so support can
 * answer — `SupportTicket`'s own docblock is explicit about it. So the screen must never render it
 * as a link that is guaranteed to resolve.
 *
 * Addressed by `ticketNumber` (`ST-2026-000123`), consistent with orders and RFQs.
 */

export const TICKET_STATUSES: readonly SupportTicketStatus[] = SUPPORT_TICKET_STATUSES;
export const TICKET_TOPICS: readonly ContactTopic[] = CONTACT_TOPICS;

const STATUS_LOOKUP: ReadonlySet<string> = new Set<string>(SUPPORT_TICKET_STATUSES);
const TOPIC_LOOKUP: ReadonlySet<string> = new Set<string>(CONTACT_TOPICS);

export function isTicketStatus(value: unknown): value is SupportTicketStatus {
  return typeof value === "string" && STATUS_LOOKUP.has(value);
}

export function parseTicketStatus(value: unknown): SupportTicketStatus | undefined {
  return isTicketStatus(value) ? value : undefined;
}

export function isContactTopic(value: unknown): value is ContactTopic {
  return typeof value === "string" && TOPIC_LOOKUP.has(value);
}

export function parseContactTopic(value: unknown): ContactTopic | undefined {
  return isContactTopic(value) ? value : undefined;
}

/**
 * What `GET /admin/support/tickets` accepts.
 *
 * **There is no `priority` filter**, though `AdminSupportTicketsService.list`'s own docblock says
 * the desk "uses `?status=` and `?priority` to find the rest". `AdminSupportTicketQueryDto` declares
 * `status`, `topic`, `assignedToUserId`, `page` and `limit` and nothing else, and
 * `forbidNonWhitelisted` turns the invented parameter into a 400 rather than an ignored filter. The
 * comment is out of date; this list is not.
 */
export interface TicketListQuery {
  status?: SupportTicketStatus;
  topic?: ContactTopic;
  /** A uuid. `@IsUUID()` on the DTO, so anything else is a 400. */
  assignedToUserId?: string;
  page?: number;
  limit?: number;
}

/** `AdminSupportTicketQueryDto`'s `@Min(1) @Max(60)`. */
export const TICKETS_PAGE_SIZE = 24;

export function fetchTickets(
  query: TicketListQuery,
  signal?: AbortSignal,
): Promise<Paginated<AdminSupportTicketSummary>> {
  return http.get<Paginated<AdminSupportTicketSummary>>(
    `/admin/support/tickets${toQueryString({ ...query })}`,
    signal,
  );
}

export function fetchTicket(
  ticketNumber: string,
  signal?: AbortSignal,
): Promise<AdminSupportTicket> {
  return http.get<AdminSupportTicket>(
    `/admin/support/tickets/${encodeURIComponent(ticketNumber)}`,
    signal,
  );
}

/**
 * `PATCH /admin/support/tickets/:ticketNumber` — status, priority and assignment in one write.
 *
 * **The status decides `resolvedAt`, and the rule is not the blog's stamp-once rule.** Entering
 * `resolved` stamps the time freshly each time; leaving it for `new`/`open`/`waiting` **clears**
 * it, because a resolution date on an open ticket is simply false; `resolved -> closed` keeps it,
 * which is what distinguishes "we fixed it" from "the customer stopped replying". So a ticket
 * closed without ever being resolved keeps a null resolution date on purpose.
 *
 * `assignedToUserId: null` clears the assignment; omitting the key leaves it alone.
 *
 * Answers 200 with the whole re-read ticket, notes included.
 */
export interface UpdateTicketInput {
  status?: SupportTicketStatus;
  /** 1 is most urgent. `@Min(1) @Max(5)`, defaulting to 2 at the column. */
  priority?: number;
  assignedToUserId?: string | null;
}

export function updateTicket(
  ticketNumber: string,
  input: UpdateTicketInput,
): Promise<AdminSupportTicket> {
  const body: Record<string, unknown> = {};
  if (input.status !== undefined) body["status"] = input.status;
  if (input.priority !== undefined) body["priority"] = input.priority;
  if (input.assignedToUserId !== undefined) body["assignedToUserId"] = input.assignedToUserId;

  return http.patch<AdminSupportTicket>(
    `/admin/support/tickets/${encodeURIComponent(ticketNumber)}`,
    body,
  );
}

/**
 * `POST /admin/support/tickets/:ticketNumber/notes` — brief §38's internal note.
 *
 * **`isInternal` is deliberately not sent**, so the column's `true` default applies. The flag
 * exists so that the day something *does* send a note to a customer, the notes already written are
 * not retrospectively published — and nothing in this milestone sends one. Offering a "visible to
 * the customer" tick that no delivery path reads would be a promise the system cannot keep.
 *
 * Adding a note does **not** move the ticket or bump its `updatedAt`: a note is a record of work,
 * not a change of state. Answers 200 with the re-read ticket.
 */
export function addTicketNote(ticketNumber: string, body: string): Promise<AdminSupportTicket> {
  return http.post<AdminSupportTicket>(
    `/admin/support/tickets/${encodeURIComponent(ticketNumber)}/notes`,
    { body },
  );
}
