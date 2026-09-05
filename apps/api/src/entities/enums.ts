/** Spec §3.2 — brief §45's `AdminUsers` collapses into this column. */
export enum UserRole {
  CUSTOMER = 'CUSTOMER',
  BUSINESS = 'BUSINESS',
  ADMIN = 'ADMIN',
}

export enum VariantChannel {
  RETAIL = 'RETAIL',
  BULK = 'BULK',
}

/** Brief §32. The reasons stock moves. */
export enum InventoryTransactionType {
  RECEIPT = 'RECEIPT',
  SALE = 'SALE',
  ADJUSTMENT = 'ADJUSTMENT',
  RETURN = 'RETURN',
  CANCELLATION = 'CANCELLATION',
}

/** Brief §31. Which buyer group a pricing tier applies to. */
export enum CustomerSegment {
  DEFAULT = 'DEFAULT',
  RETAILER = 'RETAILER',
  DISTRIBUTOR = 'DISTRIBUTOR',
  HORECA = 'HORECA',
}

export enum OrderChannelEnum {
  RETAIL = 'RETAIL',
  BULK = 'BULK',
}

export enum PaymentMethodEnum {
  COD = 'COD',
  /** Present so enabling online payment later is a settings change, not a migration. */
  ONLINE = 'ONLINE',
}

export enum PaymentStatusEnum {
  PENDING = 'PENDING',
  COLLECTED = 'COLLECTED',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
}

export enum CouponType {
  PERCENT = 'PERCENT',
  FLAT = 'FLAT',
}

export enum CouponScope {
  ALL = 'ALL',
  CATEGORY = 'CATEGORY',
}

export enum CouponChannel {
  ALL = 'ALL',
  RETAIL = 'RETAIL',
  BULK = 'BULK',
}

export enum ReviewStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum RfqKind {
  BULK = 'BULK',
  GIFTING = 'GIFTING',
}

export enum NotificationChannel {
  EMAIL = 'EMAIL',
  WHATSAPP = 'WHATSAPP',
}

export enum NotificationStatus {
  QUEUED = 'QUEUED',
  SENT = 'SENT',
  FAILED = 'FAILED',
}

export enum ShipmentStatus {
  PENDING = 'PENDING',
  DISPATCHED = 'DISPATCHED',
  IN_TRANSIT = 'IN_TRANSIT',
  DELIVERED = 'DELIVERED',
  RETURNED = 'RETURNED',
}
