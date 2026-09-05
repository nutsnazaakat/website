/**
 * Brief §33's status vocabularies now live in `@/contract` so the backend's transition
 * machine and this file cannot disagree. The warning that used to sit here still applies:
 * these values are verbatim from the brief, and an earlier revision got them wrong by
 * guessing.
 *
 * This module's remaining job is to keep `@/features/account/types` working as an import
 * path for the components and mocks that already use it.
 */
export { B2B_ORDER_STATUSES, B2C_ORDER_STATUSES } from "@/contract";
export type {
  B2bOrderStatus,
  B2cOrderStatus,
  OrderChannel,
  OrderEvent,
  OrderLine,
  OrderStatus,
} from "@/contract";
export type { AccountOrder, OrderFilters, SavedAddress } from "@/contract";
