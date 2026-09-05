import { RFQ_NUMBER_PATTERN } from '@nutwala/shared';
import type { EntityManager } from 'typeorm';

/**
 * Re-exported, not re-declared — `order-number.ts`'s identical arrangement, and for the identical
 * reason: the pattern lives in `shared/src/constants/identifiers.ts` so the frontend can import
 * the same one, and this re-export keeps this module's own call sites working against the import
 * path they already use.
 */
export { RFQ_NUMBER_PATTERN };

/** The sequence added by `20260822100000-RfqNumberSequence`. */
export const RFQ_NUMBER_SEQUENCE = 'rfq_number_seq';

export function formatRfqNumber(year: number, sequence: number): string {
  return `RFQ-${year}-${String(sequence).padStart(6, '0')}`;
}

/**
 * Allocates the next RFQ number from Postgres. `order-number.ts`'s `nextOrderNumber`, unchanged
 * in shape, because the two problems are the same problem: `nextval` rather than
 * `max(rfqNumber) + 1` closes the read-then-write gap two enquiries racing would otherwise hit,
 * and the sequence is deliberately not rolled back by a failed transaction, so a rejected RFQ
 * burns a number rather than handing it to the next one.
 *
 * **This is a `SELECT`, so it is safe — and that is the whole point of saying so.** TypeORM's
 * Postgres driver returns `[rows, rowCount]` for `UPDATE`/`DELETE` and `raw.rows` for everything
 * else, a distinction that has already shipped broken twice in this codebase because a write's
 * return value was read as though it were a normal row array. `nextval` via `SELECT` returns rows
 * normally; nothing here is exempt from checking which shape a query actually returns.
 *
 * Takes the transaction's `EntityManager` so the call joins whatever transaction is creating the
 * RFQ, rather than opening a second connection — which would work, but would make the
 * burn-on-rollback behaviour depend on which connection happened to serve it.
 */
export async function nextRfqNumber(manager: EntityManager, now = new Date()): Promise<string> {
  const rows = await manager.query<{ nextval: string }[]>(`SELECT nextval($1) AS nextval`, [
    RFQ_NUMBER_SEQUENCE,
  ]);
  const value = Number(rows[0]?.nextval);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${RFQ_NUMBER_SEQUENCE} returned ${String(rows[0]?.nextval)}`);
  }
  return formatRfqNumber(now.getFullYear(), value);
}
