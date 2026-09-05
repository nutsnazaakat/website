import {
  B2B_ORDER_STATUSES,
  B2C_ORDER_STATUSES,
  type OrderChannel,
  type OrderStatus,
} from "@/contract";

/**
 * Narrowing an untrusted string to an `OrderStatus`, in one place.
 *
 * Two callers need it and neither may assert. A search parameter arrives from the address bar, and
 * `details.allowed` arrives from an error envelope typed `Record<string, unknown>` — in both cases
 * `value as OrderStatus` would be a claim about data this app did not produce. The contract's own
 * tuples are the only authority on what a status is, so they are the check.
 *
 * `Set` because `processing`, `shipped` and `delivered` appear in both channels' tuples, and a
 * filter dropdown must not list them twice.
 */
export const ALL_ORDER_STATUSES: readonly OrderStatus[] = [
  ...new Set<OrderStatus>([...B2C_ORDER_STATUSES, ...B2B_ORDER_STATUSES]),
];

const STATUS_LOOKUP: ReadonlySet<string> = new Set<string>(ALL_ORDER_STATUSES);

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && STATUS_LOOKUP.has(value);
}

/** `undefined` for anything that is not a status — including the empty string a cleared select emits. */
export function parseOrderStatus(value: unknown): OrderStatus | undefined {
  return isOrderStatus(value) ? value : undefined;
}

export const ORDER_CHANNELS: readonly OrderChannel[] = ["retail", "bulk"];

export function parseOrderChannel(value: unknown): OrderChannel | undefined {
  return value === "retail" || value === "bulk" ? value : undefined;
}
