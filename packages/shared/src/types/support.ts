// shared/src/types/support.ts
/**
 * `POST /contact`'s response — just enough for the customer to quote the ticket back, the same
 * reasoning every other numbered reference in this codebase gives (`AccountOrder.id`,
 * `RfqSummary.id`).
 */
export interface SupportTicketSummary {
  /** `ST-{year}-{at least 6 digits}`. See `TICKET_NUMBER_PATTERN`. */
  ticketNumber: string;
}

/**
 * `POST /contact`'s body. Every field exists on `CreateContactMessageDto`; the two are checked
 * against each other by the backend's own compilation, since the controller binds the DTO.
 *
 * `orderNumber` is optional and deliberately unvalidated for shape on both sides — `SupportTicket`
 * carries it as a soft link, not a foreign key, so a customer who is unsure of the exact number
 * still raises a ticket.
 */
export interface CreateContactMessageRequest {
  name: string;
  email: string;
  phone?: string;
  topic: string;
  orderNumber?: string;
  message: string;
}
