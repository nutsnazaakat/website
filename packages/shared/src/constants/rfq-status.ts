// shared/src/constants/rfq-status.ts
import { RFQ_STATUSES, type RfqStatus } from './taxonomy';

/**
 * Legal next steps for brief §34's seven-state RFQ pipeline, `order-status.ts`'s
 * `RETAIL_TRANSITIONS`/`BULK_TRANSITIONS` in the same shape and for the same reason: the rule
 * lives in exactly one place, and every server-side caller — today just `RfqStatusService`,
 * eventually Milestone 9's admin console through it — reads this table rather than inventing a
 * second copy that drifts.
 *
 * A prospect can be turned away at either pre-quote stage (`new`/`contacted`) without being
 * forced through a `negotiation` step it never needed, and a quote can be rejected outright or
 * after negotiation. `approved -> converted` is the one step brief §34's own pipeline names
 * explicitly. `rejected` and `converted` are terminal; nothing moves an enquiry backward.
 */
export const RFQ_TRANSITIONS: Readonly<Record<RfqStatus, readonly RfqStatus[]>> = {
  new: ['contacted', 'rejected'],
  contacted: ['quote-sent', 'rejected'],
  'quote-sent': ['negotiation', 'approved', 'rejected'],
  negotiation: ['approved', 'rejected'],
  approved: ['converted'],
  rejected: [],
  converted: [],
};

/**
 * The statuses reachable in one step, or `[]` for a terminal or unrecognised status.
 *
 * `RFQ_TRANSITIONS[from]` is exhaustive by the type of `from`, so the `?? []` only matters for a
 * value that reached here by a cast from something looser than `RfqStatus` — a stray database
 * row, say. `order-status.ts`'s `nextStatuses` states the identical reasoning for degrading to
 * empty rather than throwing: this is a query, not an assertion.
 */
export function nextRfqStatuses(from: RfqStatus): readonly RfqStatus[] {
  return RFQ_TRANSITIONS[from] ?? [];
}

/**
 * Whether `from -> to` is legal. A no-op (`from === to`) is false, the same rule
 * `order-status.ts`'s `canTransition` states: moving an RFQ to the status it already holds must
 * not read as a real transition to whatever eventually renders one.
 */
export function canTransitionRfq(from: RfqStatus, to: RfqStatus): boolean {
  return nextRfqStatuses(from).includes(to);
}

// Re-exported so a caller can import the vocabulary and the transition table from one module.
export { RFQ_STATUSES };
export type { RfqStatus };
