import { ORDER_NUMBER_PATTERN } from '@nutwala/shared';
import type { EntityManager } from 'typeorm';

/**
 * Re-exported, not re-declared. The pattern moved to `shared/src/constants/identifiers.ts` so the
 * frontend can import the same one instead of hand-writing a regex that drifted to `{6}`; this
 * re-export keeps the twenty-odd call sites in this repo — specs and integration suites — working
 * against their existing import path.
 */
export { ORDER_NUMBER_PATTERN };

/** The sequence added by `20260821090000-OrderNumberSequence`. */
export const ORDER_NUMBER_SEQUENCE = 'order_number_seq';

export function formatOrderNumber(year: number, sequence: number): string {
  return `NN-${year}-${String(sequence).padStart(6, '0')}`;
}

/**
 * Allocates the next order number from Postgres.
 *
 * `nextval` rather than `max(orderNumber) + 1`, and the difference is the whole point: counting then
 * inserting is a read-then-write gap, so two placements racing would compute the same number and one
 * would die on `uq_orders_order_number` **after** its stock decrement had already run inside the same
 * transaction. `nextval` is atomic and, deliberately, is **not** rolled back by a failed transaction —
 * so a rejected placement burns a number rather than handing it to the next customer. A gap in the
 * sequence is invisible to everyone; a duplicate reference is not.
 *
 * Takes the transaction's `EntityManager` so the call joins the placement rather than opening a second
 * connection — which would work, but would make the burn-on-rollback behaviour depend on which
 * connection happened to serve it.
 */
export async function nextOrderNumber(manager: EntityManager, now = new Date()): Promise<string> {
  const rows = await manager.query<{ nextval: string }[]>(`SELECT nextval($1) AS nextval`, [
    ORDER_NUMBER_SEQUENCE,
  ]);
  const value = Number(rows[0]?.nextval);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${ORDER_NUMBER_SEQUENCE} returned ${String(rows[0]?.nextval)}`);
  }
  return formatOrderNumber(now.getFullYear(), value);
}
