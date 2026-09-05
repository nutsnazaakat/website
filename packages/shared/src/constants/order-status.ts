/**
 * Order status vocabularies and the legal transitions between them.
 *
 * The two tuples are verbatim from client brief §33 — do not invent, rename or reorder
 * entries. They were previously in `frontend/src/features/account/types.ts`, which carries
 * a warning that an earlier revision guessed at them and got them wrong.
 *
 * The transition maps are new in Phase 2. Phase 1 had no admin, so nothing could move an
 * order; now that admin can, an illegal move must be a rejected request rather than a
 * write that leaves the timeline nonsensical.
 */

export const B2C_ORDER_STATUSES = [
  'pending',
  'confirmed',
  'processing',
  'packed',
  'shipped',
  'out-for-delivery',
  'delivered',
  'cancelled',
  'refunded',
] as const;

export const B2B_ORDER_STATUSES = [
  'quote-requested',
  'quote-sent',
  'quote-accepted',
  'awaiting-payment',
  'approved',
  'processing',
  'shipped',
  'delivered',
] as const;

export type B2cOrderStatus = (typeof B2C_ORDER_STATUSES)[number];
export type B2bOrderStatus = (typeof B2B_ORDER_STATUSES)[number];
export type OrderStatus = B2cOrderStatus | B2bOrderStatus;

export type OrderChannel = 'retail' | 'bulk';

/**
 * Retail transitions. `cancelled` is reachable until the parcel is dispatched — after that
 * the goods are with a courier and the correct action is a return, not a cancellation.
 * `refunded` follows only `delivered`, so a refund always has a delivery behind it.
 */
const RETAIL_TRANSITIONS: Readonly<Record<B2cOrderStatus, readonly B2cOrderStatus[]>> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['packed', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['out-for-delivery'],
  'out-for-delivery': ['delivered'],
  delivered: ['refunded'],
  cancelled: [],
  refunded: [],
};

/** Bulk transitions. A B2B order is quoted and approved before it is worked. */
const BULK_TRANSITIONS: Readonly<Record<B2bOrderStatus, readonly B2bOrderStatus[]>> = {
  'quote-requested': ['quote-sent'],
  'quote-sent': ['quote-accepted'],
  'quote-accepted': ['awaiting-payment'],
  'awaiting-payment': ['approved'],
  approved: ['processing'],
  processing: ['shipped'],
  shipped: ['delivered'],
  delivered: [],
};

/**
 * The statuses reachable in one step, or `[]` for a terminal or unknown status.
 *
 * Deliberately permissive: a caller building a "what can happen next" list reasonably wants
 * an empty list for a status it cannot interpret (a cross-channel value, a typo, a bad row
 * from the database) rather than an exception. This is a query, not an assertion, so it may
 * degrade to empty. `isTerminalStatus` below makes a yes/no claim instead, and for that a
 * silent fallback would wrongly agree that garbage input is "terminal" — so it validates
 * channel membership first and throws rather than reuse this fallback.
 */
export function nextStatuses(channel: OrderChannel, from: OrderStatus): readonly OrderStatus[] {
  if (channel === 'retail') {
    return RETAIL_TRANSITIONS[from as B2cOrderStatus] ?? [];
  }
  return BULK_TRANSITIONS[from as B2bOrderStatus] ?? [];
}

/**
 * Whether `from -> to` is legal for this channel.
 *
 * A no-op (`from === to`) is false: admin clicking the same status twice must not append a
 * second identical timeline event, which would read to the customer as the step happening
 * twice.
 */
export function canTransition(channel: OrderChannel, from: OrderStatus, to: OrderStatus): boolean {
  return nextStatuses(channel, from).includes(to);
}

/**
 * A status with nowhere left to go.
 *
 * Unlike `nextStatuses`, this makes a yes/no claim about state, so it validates that
 * `status` actually belongs to `channel`'s vocabulary before answering. Without this check
 * a cross-channel status (or a typo, or a bad row from the database) would fall through
 * `nextStatuses`'s permissive `?? []` and be reported as terminal — indistinguishable from
 * a genuinely finished order.
 */
export function isTerminalStatus(channel: OrderChannel, status: OrderStatus): boolean {
  const vocabulary: readonly string[] = channel === 'retail' ? B2C_ORDER_STATUSES : B2B_ORDER_STATUSES;
  if (!vocabulary.includes(status)) {
    throw new RangeError(`"${status}" is not a valid ${channel} order status`);
  }
  return nextStatuses(channel, status).length === 0;
}
