import type { OrderStatus } from "./types";

/** Customer-facing wording for every status the seed data and Phase 2 can emit. */
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: "Payment pending",
  confirmed: "Confirmed",
  processing: "Processing",
  packed: "Packed",
  shipped: "Shipped",
  "out-for-delivery": "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
  refunded: "Refunded",
  "quote-requested": "Quote requested",
  "quote-sent": "Quote sent",
  "quote-accepted": "Quote accepted",
  "awaiting-payment": "Awaiting payment",
  approved: "Approved",
};

/** Badge tone. `destructive` is reserved for the two states that lost the customer money. */
export const ORDER_STATUS_VARIANT: Record<
  OrderStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  pending: "outline",
  confirmed: "secondary",
  processing: "secondary",
  packed: "secondary",
  shipped: "default",
  "out-for-delivery": "default",
  delivered: "secondary",
  cancelled: "destructive",
  refunded: "destructive",
  "quote-requested": "outline",
  "quote-sent": "outline",
  "quote-accepted": "secondary",
  "awaiting-payment": "outline",
  approved: "secondary",
};

/**
 * Whether the customer-facing timeline has nothing left to show.
 *
 * Deliberately NOT the same question as `isTerminalStatus` in `@/contract`, which asks
 * whether any legal state transition remains — and answers "no" for retail `delivered`,
 * because `delivered -> refunded` exists. Both are valid questions, so this one is named for
 * the one it actually answers.
 */
export const isTimelineComplete = (status: OrderStatus): boolean =>
  status === "delivered" || status === "cancelled" || status === "refunded";
