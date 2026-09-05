import { TICKET_NUMBER_PATTERN } from '@nutwala/shared';
import type { EntityManager } from 'typeorm';

/** Re-exported, not re-declared — `rfq-number.ts` and `order-number.ts`'s identical arrangement,
 * for the identical reason: one definition, so the frontend and this module import the same one. */
export { TICKET_NUMBER_PATTERN };

/** The sequence added by `20260826100000-TicketNumberSequence`. */
export const TICKET_NUMBER_SEQUENCE = 'ticket_number_seq';

export function formatTicketNumber(year: number, sequence: number): string {
  return `ST-${year}-${String(sequence).padStart(6, '0')}`;
}

/**
 * Allocates the next support-ticket number from Postgres. `nextRfqNumber`'s shape, unchanged,
 * because it is the same problem: `nextval` closes the read-then-write gap two submissions racing
 * would otherwise hit, and takes the transaction's own `EntityManager` so the allocation joins
 * whichever transaction is creating the ticket, rather than opening a second connection.
 */
export async function nextTicketNumber(manager: EntityManager, now = new Date()): Promise<string> {
  const rows = await manager.query<{ nextval: string }[]>(`SELECT nextval($1) AS nextval`, [
    TICKET_NUMBER_SEQUENCE,
  ]);
  const value = Number(rows[0]?.nextval);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${TICKET_NUMBER_SEQUENCE} returned ${String(rows[0]?.nextval)}`);
  }
  return formatTicketNumber(now.getFullYear(), value);
}
