import type { OrderChannel, OrderStatus } from '../constants/order-status';
import type { CustomerSegment, SupportTicketStatus } from '../constants/taxonomy';
import type { Role } from './auth';
import type { Category, Product, Variant } from './catalog';
import type { BlogPostSummary } from './content';
import type { AccountOrder, PaymentMethod, PaymentStatus, SavedAddress } from './order';
import type { Review } from './review';
import type { RfqGiftingDetail, RfqLine, RfqSummary } from './rfq';

/**
 * The admin console's wire shapes.
 *
 * They live in `@nutwala/shared` rather than in the backend for the reason backend design spec
 * §7.1 gives: the admin console is a **separate application in its own repository** (plan 9.6),
 * and it must not redeclare `Product`, `Variant` or `Category` — "a second definition is how the
 * two drift while both still compile". Every type below therefore *extends* the storefront shape
 * instead of restating it, so a field added to `Product` reaches the admin list automatically and
 * a field renamed there stops compiling here.
 *
 * **Money is rupees**, per spec §8: the server converts from paise at the boundary, and the admin
 * app never sees a paise figure any more than the storefront does.
 */

/**
 * A variant as admin sees it: the storefront shape plus the two things a storefront must never be
 * told.
 *
 * - `id`, because `PATCH /admin/variants/:id` and `DELETE /admin/variants/:id` are addressed by
 *   uuid (spec §6.4) while the storefront addresses a variant by `size` within a product.
 * - `isActive`, because deactivating a variant is how a pack is withdrawn without destroying its
 *   stock ledger (`inventory-transaction.entity.ts` states this), and an admin list that hid
 *   inactive variants would give an operator no way back.
 *
 * Stock is **not** repeated here beyond the inherited `available` / `soldOut`. Brief §32's stock
 * screen — current, reserved, available, low, out — is `GET /admin/inventory`, which plan 9.2
 * owns; a second copy of `onHand`/`reserved` on this shape would be the drift §7.1 warns about,
 * one level down.
 */
export interface AdminVariant extends Variant {
  id: string;
  isActive: boolean;
}

/**
 * A product as admin sees it, unpublished ones included — the whole point of `GET /admin/products`.
 *
 * `variants` **widens** the inherited field to every variant, active or not. The storefront's
 * `Product.variants` carries only active ones, so an admin reading the public shape could not see
 * a pack it had just deactivated. `soldOut` is unaffected: it is still derived by
 * `productSoldOut` over the *active* variants only, so the flag means the same thing on both
 * sides.
 *
 * `category` stays the category **slug**, inherited unchanged, and `categoryId` is added beside it
 * — the write DTOs address a category by uuid, and an edit form needs to preselect it without a
 * slug lookup.
 *
 * `bulkTiers` is the `DEFAULT` ladder, the same one an anonymous storefront visitor resolves. A
 * business's negotiated or segment ladder is deliberately not merged in here: brief §31's
 * customer-specific pricing is `GET /admin/pricing-tiers` (plan 9.3), and folding it into this
 * shape would make one product carry several conflicting ladders with nothing to say whose.
 */
export interface AdminProduct extends Product {
  id: string;
  categoryId: string;
  isPublished: boolean;
  /**
   * When the product first went live, ISO-8601, or null if it never has.
   *
   * Set by `POST /admin/products/:id/publish` only when it is still null, and never cleared by
   * `unpublish` — an unpublish/republish cycle is not a new product, and rewriting the date would
   * lose the only record of when the listing first existed.
   */
  publishedAt: string | null;
  variants: AdminVariant[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A category as admin sees it, unpublished ones included.
 *
 * `sortOrder` and `isPublished` are the two fields the storefront resolves for the caller and
 * never shows — `GET /catalog/categories` filters to published and orders by `sortOrder`, so a
 * `Category` on the wire has neither.
 *
 * There is no `AdminCategory` delete shape because there is no delete route: spec §6.4 lists
 * `GET`, `POST` and `PATCH` for `/admin/categories` and nothing else.
 */
export interface AdminCategory extends Category {
  id: string;
  sortOrder: number;
  isPublished: boolean;
  seo: { title: string; description: string; ogImage: string };
}

/**
 * Brief §29's nine cards.
 *
 * **`totalSales`, `b2cSales` and `b2bSales` exclude `cancelled` and `refunded` orders.**
 * `orders` does **not** — it counts every order in the table whatever its status, so the card
 * agrees with the row count of `GET /admin/orders`, which lists them all. Both choices are
 * deliberate and they pull in opposite directions on purpose: revenue must match what Milestone
 * 5's account totals already tell the customer for the same order, and an order count that
 * silently dropped cancellations would disagree with the screen beside it.
 *
 * `b2cSales + b2bSales === totalSales` always: `channel` is a two-value enum and every order
 * carries one.
 *
 * `customers` counts every non-admin account and `b2bCustomers` is the `BUSINESS` subset of it,
 * not a disjoint bucket — brief §46 is explicit that one account switches between retail and bulk
 * shopping, so a "B2C customers" figure computed as the difference would be a claim the data
 * model does not support.
 */
export interface AdminDashboardCards {
  totalSales: number;
  b2cSales: number;
  b2bSales: number;
  orders: number;
  pendingOrders: number;
  pendingRfqs: number;
  customers: number;
  b2bCustomers: number;
  lowStock: number;
}

/**
 * One day of the sales-over-time series. `date` is `YYYY-MM-DD`.
 *
 * **In the business's timezone, not UTC** — the `business.timezone` setting, `Asia/Kolkata` by
 * default, added by plan 9.4 per spec §5b. It said UTC until then, and that was accurate rather
 * than aspirational: `placedAt` is a `timestamptz`, grouping it requires naming a zone, and nothing
 * named one. The consequence was that a 04:00 IST order landed on the previous day's bar.
 *
 * The same setting bounds `?from`/`?to` on `GET /admin/orders`, so a bar and the order list it
 * links to cannot disagree about which day an order belongs to.
 */
export interface AdminSalesPoint {
  date: string;
  sales: number;
  orders: number;
}

/** One arm of brief §29's "B2C vs B2B" split. Both arms are always present, at zero if need be. */
export interface AdminChannelSplitPoint {
  channel: OrderChannel;
  sales: number;
  orders: number;
}

/**
 * One bar of "top products" or "top categories".
 *
 * `slug` and `name` for a product come from the **`OrderItem` snapshot**, not from the `products`
 * table, so a product deleted or renamed since it was sold still reports the sales it made under
 * the name it was sold as. A category cannot do the same — `order_items` snapshots no category —
 * so `topCategories` resolves through `products.category_id` and a line whose product has since
 * been deleted contributes to no category.
 */
export interface AdminTopSeller {
  slug: string;
  name: string;
  unitsSold: number;
  sales: number;
}

/** Brief §29's four charts. */
export interface AdminDashboardCharts {
  salesOverTime: AdminSalesPoint[];
  channelSplit: AdminChannelSplitPoint[];
  topProducts: AdminTopSeller[];
  topCategories: AdminTopSeller[];
}

/** `GET /admin/dashboard` — brief §29 in full. */
export interface AdminDashboard {
  cards: AdminDashboardCards;
  charts: AdminDashboardCharts;
}

/**
 * One row of `GET /admin/inventory` — brief §32's stock screen, spec §6.4's
 * "current / reserved / available / low / out".
 *
 * A shape of its own rather than fields bolted onto `AdminVariant`, and `admin.ts`'s own note on
 * that type says why: "a second copy of `onHand`/`reserved` on this shape would be the drift §7.1
 * warns about, one level down". A variant is a catalogue entry; this is a stock position, keyed by
 * `variantId` because that is what `inventory` is keyed by and what
 * `PATCH /admin/inventory/:variantId` addresses.
 *
 * `productName` and `sku` are carried so the row is legible on its own — a low-stock list of bare
 * uuids would send the operator to a second endpoint per line — and no other product field is,
 * because `GET /admin/products/:id` is one click away and duplicating the catalogue here is how the
 * two start disagreeing.
 */
export interface AdminInventoryRow {
  variantId: string;
  sku: string;
  size: string;
  /**
   * The **variant's** flag, not a stock one.
   *
   * Inactive variants are listed, deliberately: deactivating a pack is how it is withdrawn without
   * destroying its stock ledger, and stock does not stop existing because the pack stopped being
   * offered. Hiding them would strand real inventory in a screen that claims to show all of it —
   * but reordering for a withdrawn pack is a waste, so the row says which it is.
   */
  isActive: boolean;
  productId: string;
  productName: string;
  /** Brief §32's "current stock". The physical column. */
  onHand: number;
  /** Held for in-flight operations. Zero in normal operation — spec §10.1. */
  reserved: number;
  /** `onHand - reserved`, per spec §10.1. */
  available: number;
  lowStockThreshold: number;
  /**
   * `available <= lowStockThreshold` — **spec §12's rule, which is not `checkLowStock`'s.**
   *
   * The `stock.low` notification fires on a strict `<` ("landing exactly *on* the threshold is not
   * low"), so a variant sitting exactly at its threshold reads `low: true` here and has queued no
   * notification. That disagreement is deliberate and on the record in both plan 9.1 and plan 9.2:
   * a card is a standing question ("what needs attention?") and an event is a one-off crossing, and
   * an operator who set a threshold of 10 expects the tenth pack to show up on the reorder list.
   * Neither side is to be "fixed" to match the other.
   */
  low: boolean;
  /** `available <= 0`, the same rule `variantSoldOut` applies — and applied through it. */
  outOfStock: boolean;
  /**
   * When this stock **row** last changed, ISO-8601 — `inventory.updatedAt`, stamped by the database
   * rather than by whichever host served the request.
   *
   * Not "when stock last moved": it is an `@UpdateDateColumn`, so a threshold correction through
   * `PATCH /admin/inventory/:variantId/threshold` bumps it too, having moved nothing. The question
   * "when did stock last move, and why" is answered by
   * `GET /admin/inventory/:variantId/transactions`, whose rows are the only append-only record of
   * it.
   */
  updatedAt: string;
}

/**
 * Why a stock movement happened — `inventory_transactions.type`.
 *
 * The wire spelling is the column's, uppercase, unlike `Channel` where the wire is lowercase and
 * the column is not. Nothing is gained by a second vocabulary here: these values are read by an
 * operator, never rendered as prose, and the backend mapper keys a `Record` on the database enum so
 * adding a member on either side is a compile error rather than a silently unmapped row.
 */
export type AdminStockMovement = 'RECEIPT' | 'SALE' | 'ADJUSTMENT' | 'RETURN' | 'CANCELLATION';

/**
 * One row of `GET /admin/inventory/:variantId/transactions` — brief §32's history: "stock added,
 * stock sold, stock adjusted, reason, date, admin".
 *
 * `actorName` beside `actorUserId` because the brief's column is the admin, and a uuid is not one.
 * Both are null for a movement no admin made — `SALE` rows are written by checkout on a customer's
 * behalf, and `ON DELETE SET NULL` on the actor means a deleted admin's history survives without
 * an attribution.
 *
 * `orderNumber` beside `orderId` for the same reason: `NN-2026-000123` is what the operator can
 * search for, and the ledger's soft link is the whole reason a `SALE` row is traceable to a basket.
 */
export interface AdminInventoryTransaction {
  id: string;
  variantId: string;
  /** Signed: negative for a sale or a write-off, positive for a receipt or a restock. */
  delta: number;
  type: AdminStockMovement;
  reason: string;
  /** `onHand` after this row was applied, read from the column rather than re-summed. */
  balanceAfter: number;
  orderId: string | null;
  orderNumber: string | null;
  actorUserId: string | null;
  actorName: string | null;
  createdAt: string;
}

/**
 * Who an order is for, as the admin console needs to see them — brief §33's **Customer** column,
 * and the one thing `/account/orders/:orderNumber` deliberately omits because the customer reading
 * it already knows.
 *
 * **`name`, `email` and `phone` come from the order's own address snapshot, never from the
 * account.** `order.mapper.ts` states the reasoning for `email` and it holds for all three: `orders`
 * has no contact columns, `user_id` is nullable because guest checkout is supported, and a
 * signed-in customer's order contact may legitimately differ from their account's — a gift sent to
 * a relative, a consignment to a work address. So these are the details this parcel was actually
 * addressed with, which is what an operator ringing about a delivery needs.
 *
 * **`userId` is the account, or `null` for a guest order**, and it is the field that says which.
 * It is not a contact detail: it is the link plan 9.3's `GET /admin/customers/:id` is addressed by,
 * and the only honest way to tell "no account" from "an account whose name happens to match the
 * delivery name". `businessId` and `companyName` are its B2B counterparts — `companyName` is the
 * order's own snapshotted column (brief §20's B2B checkout field), so it survives the business
 * being renamed or deleted exactly as the address does.
 */
export interface AdminOrderCustomer {
  userId: string | null;
  name: string;
  email: string;
  phone: string;
  businessId: string | null;
  companyName: string | null;
}

/**
 * One order as the admin console reads it — `GET /admin/orders/:orderNumber`, and the reply to
 * every write on that order.
 *
 * **Extends `AccountOrder` rather than restating it**, per spec §5a: items, totals, the address, the
 * tracking timeline and the payment state are the same facts the customer's own page renders, and
 * `toAccountOrder` is still the only thing that produces them. A second shape would be a second
 * contract, and the first divergence between them would be an operator and a customer looking at
 * the same order and disagreeing about it. `id` is therefore the **order number**, not the uuid —
 * `AccountOrder.id`'s docblock is explicit, and every admin order route is addressed by it.
 *
 * What is added is exactly what a customer's own view has no use for: who the order is for.
 */
export interface AdminOrder extends AccountOrder {
  customer: AdminOrderCustomer;
  /**
   * When COD was collected, ISO-8601, or null while it is still outstanding — `payments.collectedAt`.
   *
   * Beside the inherited `paymentStatus` rather than instead of it, and the two say different
   * things: `paymentStatus` is `orders.paymentStatus`, the denormalised copy the customer's own page
   * renders, while this is the `payments` row that `POST .../payment/collect` writes. They are kept
   * in step inside one transaction, and a console showing both is what would make a drift between
   * them visible rather than silent.
   */
  paymentCollectedAt: string | null;
  /**
   * The receipt number an admin recorded when collecting COD — `payments.reference`, whose own
   * docblock calls it "a gateway reference once online payment is enabled; a receipt number for
   * COD". Null when none was given, which is allowed: a delivery agent may hand over cash without
   * one.
   *
   * Not on `AccountOrder`: it is an operational reference for reconciliation, and the customer's
   * receipt is the order itself.
   */
  paymentReference: string | null;
  /**
   * The dispatches recorded against this order, oldest first — `shipments`, empty until one is.
   *
   * An array rather than a single shipment, because the table is one-to-many and always has been:
   * nothing in the schema stops a replacement parcel being recorded against an order, and a
   * `shipment: AdminShipment | null` would be a shape that has to change the day one is. There is no
   * consumer of the second element yet, and that is fine — the cost of the array is a `[0]`.
   *
   * Not on `AccountOrder`, deliberately, even though a courier and a tracking number are things a
   * customer wants. The customer's tracking today is the `timeline` — spec §10.3's "admin action and
   * customer-visible tracking are the same data" — and putting a courier reference on the storefront
   * shape is a decision about what the customer is shown, not a side effect of the admin console
   * gaining a write.
   */
  shipments: AdminShipment[];
}

/**
 * Where a dispatch is — `shipments.status`, lowercase-hyphen on the wire.
 *
 * **`in-transit`, not `in_transit`.** `order.mapper.ts` names `ShipmentStatus.IN_TRANSIT` as the
 * exact member that makes `value.toLowerCase()` wrong: every hyphenated value in this project's
 * wire vocabularies — `out-for-delivery`, `quote-requested` — says the spelling is `in-transit`,
 * while lowercasing the enum produces `in_transit`. The backend maps it through a `Record` keyed on
 * the database enum, so neither vocabulary can gain a member without the other.
 */
export type AdminShipmentStatus = 'pending' | 'dispatched' | 'in-transit' | 'delivered' | 'returned';

/**
 * One dispatch against an order — `POST /admin/orders/:orderNumber/shipment` creates it and
 * `GET /admin/orders/:orderNumber` lists it.
 *
 * `courier` is always present because the endpoint requires it; `trackingNumber` may be null,
 * matching the nullable column, since an AWB sometimes follows the parcel. `deliveredAt` is null
 * throughout plan 9.2: nothing writes it, because the order's `delivered` status is what the
 * operator sets and no route updates a shipment. Worth knowing before reading a null as "not
 * delivered" rather than "not recorded".
 */
export interface AdminShipment {
  id: string;
  courier: string;
  trackingNumber: string | null;
  status: AdminShipmentStatus;
  /** When the parcel was handed over, ISO-8601. Stamped at creation. */
  shippedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

/**
 * One row of `GET /admin/orders` — **brief §33's columns, which are normative**: Order ID,
 * Customer, B2C/B2B, Amount, Payment, Status, Date.
 *
 * A shape of its own rather than `AdminOrder[]`, and this is the one place the admin surface
 * departs from the account area's "one shape for the list and the detail". `AccountOrder` carries
 * `items` and `timeline`, so a page of 24 orders would be 24 baskets and 24 timelines — the account
 * list can afford that because it is one customer's own history, and a shop-wide order list cannot.
 * Brief §33 names seven columns and this is those seven, so nothing here is a lighter projection of
 * something the operator was promised.
 *
 * `total` is **GST-inclusive rupees**, the figure the customer paid and the figure the dashboard's
 * revenue cards sum — spec §8's boundary conversion happens once, in the mapper.
 *
 * `paymentMethod` and `paymentStatus` are brief §33's single **Payment** column, split in two
 * because "COD" and "collected" are different facts and a console that wants to render them as one
 * cell can join them; a wire that joined them first could not be taken apart again.
 */
export interface AdminOrderSummary {
  /** The order number — `NN-{year}-{at least 6 digits}` — never the uuid. */
  id: string;
  customer: AdminOrderCustomer;
  channel: OrderChannel;
  status: OrderStatus;
  total: number;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  /** Brief §33's **Date**: when the order was placed, ISO-8601. */
  placedAt: string;
}

/* -------------------------------------------------------------------------------------------- *
 * Plan 9.3 — people and B2B. Brief §31 (pricing), §34 (RFQ management), §35 (customers).
 * -------------------------------------------------------------------------------------------- */

/**
 * An admin account named as somebody's salesperson — brief §34/§35's "assigned salesperson".
 *
 * Not an `AuthUser`: that shape carries `phone`, `createdAt` and an optional `company`, none of
 * which a "who owns this account" chip needs, and one of which (`company`) would be a second,
 * staler copy of the business it is being shown next to. The three fields here are the ones an
 * operator reads or clicks.
 *
 * `businesses.assigned_salesperson_id` and `rfqs.assigned_salesperson_id` are both plain
 * `users(id)` references — brief §35 wanted a salesperson and `business.entity.ts` chose "an admin
 * user, not a separate staff table", which is why this is not its own resource.
 */
export interface AdminSalesperson {
  id: string;
  name: string;
  email: string;
}

/**
 * One row of `GET /admin/customers` — brief §35's customer list.
 *
 * **Never carries `passwordHash`.** `users.passwordHash` is `select: false`, so an ordinary find
 * does not even load it — but this shape is built field by field by a mapper precisely so that a
 * query which *does* select it (a hand-written `SELECT *`, a `addSelect`) still cannot put it on
 * the wire. `admin-customer.mapper.spec.ts` asserts the exact key list for that reason.
 *
 * **`orders` counts every order and `totalSpend` excludes `cancelled` and `refunded`**, and the two
 * pull in opposite directions on purpose — exactly as `AdminDashboardCards` already documents for
 * the same pair of figures. Revenue must agree with what the customer's own account page tells them
 * about the same orders (Milestone 5), and a count that silently dropped cancellations would
 * disagree with `GET /admin/orders`, which lists them.
 *
 * `role` is the wire role, `b2c` or `b2b`. **`admin` never appears**: an operator account is not a
 * customer, `GET /admin/dashboard`'s `customers` card already counts `role <> 'ADMIN'`, and a list
 * that included admins would disagree with the card beside it.
 */
export interface AdminCustomerSummary {
  /** `users.id` — the uuid `GET /admin/customers/:id` is addressed by. */
  id: string;
  name: string;
  email: string;
  phone: string;
  role: Role;
  /**
   * `users.isActive`. Nothing in this codebase sets it false yet — `DashboardService.people`
   * records the same fact — so it is `true` on every row today, and is carried rather than hidden
   * so the list does not have to change shape the day account deactivation ships.
   */
  isActive: boolean;
  /** Every order this account has placed, whatever its status. */
  orders: number;
  /** Rupees, excluding `cancelled` and `refunded`. See this type's docblock. */
  totalSpend: number;
  /** `placedAt` of the most recent order, whatever its status, ISO-8601. Null for none. */
  lastOrderAt: string | null;
  createdAt: string;
}

/**
 * The business behind a `b2b` customer, as the customer detail shows it.
 *
 * A summary rather than an `AdminBusiness`: the full B2B profile is `GET /admin/businesses/:id`,
 * one click away, and repeating its order and spend aggregates here would be a second derivation of
 * figures this shape already carries at the account level.
 *
 * **`segment` appears here and never on a customer-facing payload.** `business.mapper.ts` is the
 * wall on that side and states why; the operator is the one party that must see the band, because
 * `PATCH /admin/businesses/:id` (plan 9.4) is what sets it.
 */
export interface AdminCustomerBusiness {
  id: string;
  companyName: string;
  gstin: string | null;
  businessType: string;
  segment: CustomerSegment;
}

/**
 * `GET /admin/customers/:id` — one account in full.
 *
 * Extends the list row rather than restating it, the same relationship `AdminOrder` draws against
 * `AccountOrder`. What it adds is what a list cannot afford: the address book, and the business
 * record for a `b2b` account.
 *
 * `addresses` are `SavedAddress` rows through `toSavedAddress`, so a soft-deleted address is absent
 * rather than shown — the operator sees the book the customer sees.
 */
export interface AdminCustomer extends AdminCustomerSummary {
  /** `users.lastLoginAt`, ISO-8601, or null for an account that has never signed in. */
  lastLoginAt: string | null;
  addresses: SavedAddress[];
  /** Null for a `b2c` account. Always present for `b2b` — registration creates the row. */
  business: AdminCustomerBusiness | null;
}

/**
 * One row of `GET /admin/businesses` — **brief §35's B2B profile**: company, GSTIN, business type,
 * orders, total spend, RFQs, last order, assigned salesperson.
 *
 * **`orders`, `totalSpend` and `lastOrderAt` are the same three figures `AdminCustomerSummary`
 * reports for the same account, computed by the same rule, across both channels.** Scoping them to
 * `channel = bulk` was the alternative and was rejected: brief §46 puts retail and bulk shopping on
 * one account, so a bulk-only total would make this screen and `GET /admin/customers/:id` disagree
 * about what the same person has spent. `GET /business/stats`'s `bulkOrders`/`bulkSpend` are a
 * different question under different names and do not contradict these.
 *
 * **Scoped by `userId`, not by `orders.business_id`** — `BusinessStatsService`'s docblock records
 * the measurement: `CheckoutService.place` writes `businessId: null` into every order it creates,
 * so a query scoped by that column answers zero for every business that has ever bought anything.
 *
 * `email` is the **account's** email: `businesses` has no email column of its own.
 */
export interface AdminBusinessSummary {
  /** `businesses.id` — the uuid `GET /admin/businesses/:id` is addressed by. */
  id: string;
  /** The account this business belongs to — 1:1, and the key every aggregate above is scoped by. */
  userId: string;
  companyName: string;
  contactPerson: string;
  /** `''` for a business that registered but never filled in `/business/profile`. */
  mobile: string;
  email: string;
  gstin: string | null;
  businessType: string;
  /** Brief §31's price band. Admin-set, `default` until something sets otherwise. */
  segment: CustomerSegment;
  orders: number;
  totalSpend: number;
  lastOrderAt: string | null;
  /** Every enquiry this account has raised, whatever its status. */
  rfqs: number;
  /**
   * The subset still being worked — `new`, `contacted`, `quote-sent`, `negotiation`.
   *
   * Beside `rfqs` rather than instead of it: brief §35's column is "RFQs", and the answer an
   * operator triaging a queue needs is how many are live. Both come from one `count(*) FILTER`,
   * so the second figure is free, and `IS_OPEN` is the one place the split is decided —
   * `GET /business/stats` counts the same four for the business's own dashboard.
   */
  openRfqs: number;
  assignedSalesperson: AdminSalesperson | null;
  createdAt: string;
}

/**
 * `GET /admin/businesses/:id` — brief §19's stored profile as the operator reads it.
 *
 * The two addresses are resolved rows, never bare ids, and a reference to an address the customer
 * has since **soft-deleted** reads back as `null` — `BusinessesService.resolveAddresses` is the one
 * implementation of that rule and this shape is produced through it, so the operator and the
 * business see the same answer.
 */
export interface AdminBusiness extends AdminBusinessSummary {
  billingAddress: SavedAddress | null;
  shippingAddress: SavedAddress | null;
}

/**
 * One internal note on an enquiry — brief §34's "Allow internal notes", the `rfq_notes` table.
 *
 * **Never reachable from a customer-facing endpoint.** `rfq-note.entity.ts` says so in those words,
 * `RfqDetail` declares no field for it, and `RfqsService.findOne` does not load the relation. This
 * type exists only on the admin surface.
 *
 * `authorName` beside `authorUserId` because a note signed with a uuid is unreadable;
 * `rfq_notes.author_user_id` is `ON DELETE RESTRICT`, so unlike the stock ledger's actor it can
 * never be null — a note always has an author, and an admin who wrote one cannot be deleted.
 */
export interface AdminRfqNote {
  id: string;
  body: string;
  authorUserId: string;
  authorName: string;
  createdAt: string;
}

/**
 * One row of `GET /admin/rfqs` — **brief §34's columns**: RFQ ID, business, contact, products,
 * quantity, expected value, status, assigned salesperson.
 *
 * Extends `RfqSummary`, so `id` is the **RFQ number** (`RFQ-2026-000123`) and not the uuid — the
 * reference an operator reads down a phone line, and what `GET /admin/rfqs/:rfqNumber` is addressed
 * by. `kind`, `status`, `businessName` and `createdAt` are inherited unchanged.
 *
 * **`lines` are loaded for the list, unlike `AdminOrderSummary`, and the difference is the brief's
 * rather than an inconsistency.** §33 gives an order row seven columns and none of them is its
 * basket; §34 gives an enquiry row "products, quantity", so the lines *are* two of the columns. An
 * enquiry carries at most twenty of them (`CreateRfqDto`'s `@ArrayMaxSize(20)`) against an order's
 * unbounded basket plus its timeline, which is what makes the join affordable here.
 *
 * `totalKg` is the sum of the lines, carried rather than left to the client so the "quantity" column
 * is one number computed in one place. Zero for a gifting enquiry, which has no lines at all — its
 * quantity is `AdminRfq.gifting.boxes`.
 */
export interface AdminRfqSummary extends RfqSummary {
  contactPerson: string;
  mobile: string;
  email: string;
  lines: RfqLine[];
  totalKg: number;
  /** Brief §34's "expected value", rupees. Null until the sales desk sets one. */
  expectedValue: number | null;
  assignedSalesperson: AdminSalesperson | null;
}

/**
 * `GET /admin/rfqs/:rfqNumber` — one enquiry in full, with its note history.
 *
 * **`notes` and `internalNotes` are two different things and the names are chosen so they cannot be
 * confused.** `notes` is `rfqs.notes`: free text the *prospect* typed into brief §17's "additional
 * requirements" box, the same field `RfqDetail.notes` shows them back. `internalNotes` is
 * `rfq_notes`: brief §34's sales notes, written by an admin, never shown to anybody else.
 * `POST /admin/rfqs/:rfqNumber/notes` writes the second and never the first — see
 * `AdminRfqsService.addNote`.
 *
 * `userId` is the account that raised it, or `null` for a prospect who had none — `rfqs.user_id` is
 * nullable because brief §17's form is public.
 */
export interface AdminRfq extends AdminRfqSummary {
  userId: string | null;
  gstin: string | null;
  businessType: string;
  pincode: string;
  /** Null for a gifting enquiry, which has no packaging question — the gift box is the packaging. */
  packaging: string | null;
  /** Null for a gifting enquiry, which is inherently one-off. */
  frequency: string | null;
  /** The prospect's own "additional requirements". See this type's docblock. */
  notes: string | null;
  /** Brief §24's five extra questions, for a gifting enquiry. Null for a bulk one. */
  gifting: RfqGiftingDetail | null;
  /** Brief §34's internal notes, newest first. See this type's docblock. */
  internalNotes: AdminRfqNote[];
  updatedAt: string;
}

/**
 * One row of `GET /admin/pricing-tiers` — brief §31: MOQ, price/kg, quantity tiers, retailer /
 * distributor / HORECA pricing, and customer-specific pricing.
 *
 * **MOQ is not here, and is not missing.** `products.moqKg` is a product field and is already
 * editable through `PATCH /admin/products/:id` (plan 9.1). A second place to set it would be a
 * second answer to "what is the minimum for this product".
 *
 * `pricePerKg` is `null` for a slab that **requires a quote** — brief §47, and
 * `pricing_tiers."pricePerKgPaise"` is nullable for exactly that. It is not "free" and not "not set
 * yet": `CatalogService.quotePreview` answers `quoteRequired: true` for it.
 *
 * `maxKg` is `null` for the open-ended top slab, brief §16's "50kg+".
 *
 * `productSlug`, `productName` and `companyName` are carried so a row is legible on its own; a
 * ladder of bare uuids would send the operator to two more endpoints per line.
 */
export interface AdminPricingTier {
  id: string;
  productId: string;
  productSlug: string;
  productName: string;
  minKg: number;
  maxKg: number | null;
  pricePerKg: number | null;
  /** The band this slab prices. `default` is list pricing — brief §31's retailer/distributor/HORECA
   * are the other three. */
  segment: CustomerSegment;
  /** Brief §31's customer-specific pricing: the one business this ladder belongs to, or `null` for
   * a segment ladder every business in that band resolves. */
  businessId: string | null;
  /** The business's name, or `null` when `businessId` is. */
  companyName: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Plan 9.4 — content and operations. Appended in one block rather than
 * interleaved with the shapes above, so a plan editing this file concurrently
 * merges without a conflict in the middle of it.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A coupon's discount kind — `coupons.type`, lowercase on the wire.
 *
 * Lowercase rather than the column's `PERCENT`/`FLAT`, unlike `AdminStockMovement` which keeps its
 * column's spelling. The difference is deliberate: a stock movement is an operator-facing label
 * with no counterpart anywhere else, while a coupon's shape is rendered beside `AdminCouponChannel`
 * — which *is* an existing wire vocabulary (`OrderChannel`, lowercase) — and one object mixing
 * `PERCENT` with `retail` would be two vocabularies in a single row. The backend maps both through
 * a `Record` keyed on the database enum, so neither side can gain a member alone.
 */
export type AdminCouponType = 'percent' | 'flat';

/** Whether a coupon discounts the whole basket or one category's share of it — `coupons.appliesTo`. */
export type AdminCouponScope = 'all' | 'category';

/**
 * Which storefront a coupon works on — `coupons.channel`.
 *
 * Built from `OrderChannel` rather than restating `'retail' | 'bulk'`, so a third channel added to
 * the order vocabulary cannot leave coupons behind speaking the old one. `'all'` is a coupon-only
 * member: an order is always placed through exactly one channel, and a coupon may span both.
 */
export type AdminCouponChannel = OrderChannel | 'all';

/**
 * One coupon as the admin console reads it — brief §36's nine levers in full: percentage discount,
 * flat discount, minimum order value, category-specific, B2C-only, B2B-only, first-order, expiry
 * and usage limit.
 *
 * **`code` is the identifier**, not the uuid, and every admin coupon route is addressed by it.
 * `uq_coupons_code` makes it unique, `CouponService.preview` already looks a coupon up by nothing
 * else, `orders.couponCode` snapshots it, and it is the string an operator reads off a campaign
 * brief. The uuid is deliberately absent from this shape: nothing on either side of the wire has a
 * use for it, and publishing it would invite a second way to address the same row.
 *
 * **Money is rupees**, per spec §8, like every other figure in this file.
 *
 * `timesRedeemed` is counted from `coupon_redemptions` rather than stored, and it is the figure
 * `usageLimit` is measured against. It is also why a redeemed coupon cannot be deleted:
 * `coupon_redemptions.coupon_id` is `ON DELETE RESTRICT`, precisely so a coupon's redemption
 * history outlives the campaign.
 */
export interface AdminCoupon {
  code: string;
  type: AdminCouponType;
  /** Populated for a `percent` coupon, null for a `flat` one — `ck_coupons_value_exclusive`. */
  percentValue: number | null;
  /** Rupees. Populated for a `flat` coupon, null for a `percent` one. */
  flatValue: number | null;
  /** Rupees. The eligible subtotal the coupon needs before it applies, or null for no minimum. */
  minOrderValue: number | null;
  /** Rupees. Caps a percentage discount, per brief §36; null for an uncapped one. */
  maxDiscount: number | null;
  appliesTo: AdminCouponScope;
  /** The category a `category`-scoped coupon is confined to. Null when `appliesTo` is `all`. */
  categoryId: string | null;
  channel: AdminCouponChannel;
  firstOrderOnly: boolean;
  usageLimit: number | null;
  usageLimitPerUser: number | null;
  /** Rows in `coupon_redemptions` for this coupon. Counted, never stored. */
  timesRedeemed: number;
  startsAt: string | null;
  expiresAt: string | null;
  /** The soft-disable path. Switching this off is how a campaign stops without being deleted. */
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A review as the moderator sees it — brief §27's approve/reject queue.
 *
 * **Extends the storefront `Review` rather than restating it**, per spec §5a, so the body, rating,
 * image and `verifiedPurchase` badge a moderator judges are literally the fields a shopper will
 * read. What is added is the moderation trail, which the storefront has no use for and must not be
 * told: who moderated it, when, and why it was rejected.
 *
 * The inherited `status` already carries `pending` / `approved` / `rejected`.
 */
export interface AdminReview extends Review {
  /** The account that wrote it, or null once that account has been deleted (`ON DELETE SET NULL`). */
  userId: string | null;
  moderatedByUserId: string | null;
  moderatedAt: string | null;
  rejectionReason: string | null;
}

/**
 * One blog post as the admin console reads it — brief §28's categories and §39's SEO fields
 * (title, meta description, slug, OG image).
 *
 * Widens `BlogPostSummary` with everything the public shapes resolve for the caller and never show:
 * `isPublished` (the public list filters on it), the full `body` even for a draft, and the `seo`
 * block with every field present rather than optional. `publishedAt` is **nullable** here and not
 * on the public shapes, which is the same widening — a draft has never gone live.
 *
 * `readingMinutes` is absent: it is a rendering convenience derived from `body`, and an editor
 * looking at the body has it in front of them. It is now **omitted explicitly** rather than simply
 * not inherited — the public summary gained the field so the storefront's list cards could print
 * "N min read" without fetching each article, and without this `Omit` it would have arrived here
 * as a consequence of that unrelated change.
 */
export interface AdminBlogPost extends Omit<BlogPostSummary, 'publishedAt' | 'readingMinutes'> {
  body: string;
  isPublished: boolean;
  /** When it first went live, ISO-8601, or null if it never has. Never cleared by unpublishing. */
  publishedAt: string | null;
  seo: { title: string; description: string; ogImage: string };
  createdAt: string;
  updatedAt: string;
}

/**
 * One row of `GET /admin/support/tickets` — the queue brief §38's support desk is worked from.
 *
 * `ticketNumber` is the identifier, not the uuid, consistent with orders (`orderNumber`) and RFQs
 * (`rfqNumber`) and pinned by `TICKET_NUMBER_PATTERN`.
 *
 * `message` is deliberately absent: a ticket body is free text of any length, and a page of them
 * would be a page of essays. `GET /admin/support/tickets/:ticketNumber` is one hop away — the same
 * trade `AdminOrderSummary` makes against `AdminOrder`.
 */
export interface AdminSupportTicketSummary {
  ticketNumber: string;
  name: string;
  email: string;
  phone: string | null;
  /** One of `CONTACT_TOPICS`. */
  topic: string;
  /** One of `SUPPORT_TICKET_STATUSES`, which `ck_support_tickets_status` also enforces. */
  status: SupportTicketStatus;
  /** 1 is most urgent. `support_tickets.priority`, which defaults to 2. */
  priority: number;
  /**
   * The order the customer typed, if any.
   *
   * A **soft link, not a foreign key** — `SupportTicket`'s own docblock is explicit that a customer
   * may type an order number that does not exist or belongs to someone else, and the ticket must
   * still be created so support can answer. So this may name no real order.
   */
  orderNumber: string | null;
  assignedToUserId: string | null;
  /** The account that raised it, or null for a visitor who was not signed in. */
  userId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/**
 * An internal note or a customer-visible reply on a ticket — `support_ticket_notes`.
 *
 * `isInternal` is true by default at the column, so a note is staff-only unless someone says
 * otherwise. Nothing in this milestone sends a note to a customer; the flag exists so that the day
 * something does, the notes already written are not retrospectively published.
 */
export interface AdminSupportTicketNote {
  id: string;
  body: string;
  isInternal: boolean;
  authorUserId: string;
  /** The admin's name, so the trail reads without a lookup per line. */
  authorName: string;
  createdAt: string;
}

/** `GET /admin/support/tickets/:ticketNumber` — the summary plus the message and the note trail. */
export interface AdminSupportTicket extends AdminSupportTicketSummary {
  message: string;
  updatedAt: string;
  /** Oldest first, so the ticket reads as a conversation. */
  notes: AdminSupportTicketNote[];
}

/**
 * One `settings` row as the admin console reads it — `GET /admin/settings`.
 *
 * `value` is `unknown` because the column is `jsonb` and legitimately holds a string, a number, a
 * boolean or an array (`certifications`, `social` and `addressLines` are all arrays today). A
 * narrower type here would be a claim about rows this shape cannot make.
 *
 * **`isPublic` is reported and not editable.** It says whether the row reaches `GET /settings`, and
 * that is a property of what the setting *is* rather than an operational choice — a WhatsApp number
 * is public because the storefront renders it, a business timezone is private because nothing
 * outside the console has a use for it. `AdminSettingsService.replace` records the full reasoning.
 */
export interface AdminSetting {
  key: string;
  value: unknown;
  isPublic: boolean;
  updatedByUserId: string | null;
  updatedAt: string;
}

/**
 * `GET /settings` — the public subset, keyed by setting name.
 *
 * Spec §6.1 lists this endpoint and nothing had ever built it, which is why `Setting.isPublic`'s
 * own docblock described a response that did not exist. It is what a storefront's contact details,
 * WhatsApp number, GSTIN and certifications are meant to be read from: brief §26 and §37 require
 * every one of them to be admin-editable and never hardcoded, so they seed **empty** and this
 * endpoint carries whatever the business has actually configured.
 *
 * A map rather than `AdminSetting[]`, because a storefront wants `settings.whatsappNumber` and not
 * a scan over an array — and because the private rows are not merely hidden from this shape, they
 * are absent from the response.
 */
export type PublicSettings = Record<string, unknown>;

/**
 * One row of `GET /admin/audit-logs` — spec §5's *"every destructive admin action writes an
 * audit-log row"*, read back.
 *
 * **Stock movements are not in this trail, and that is by design rather than by omission.** Plan
 * 9.2 decided the `inventory_transactions` ledger *is* the audit trail for stock — an append-only
 * row carrying delta, reason, resulting balance and the acting admin, which is brief §32's history
 * in full — so no `AuditAction` member exists for a stock movement and none should. An operator
 * looking for who adjusted stock wants `GET /admin/inventory/:variantId/transactions`. Stated here,
 * on the wire, because an operator who opens this page, finds no stock movement and concludes the
 * trail is broken is the failure mode the note exists to prevent.
 *
 * `action` and `entity` are plain strings on the wire, not unions: the backend's `AuditAction` and
 * `AuditEntity` gain members with every admin write path that ships, and pinning them into a shared
 * union would make the console fail to compile against a server that had merely grown a new one.
 * Rows already written must keep deserialising whatever vocabulary wrote them.
 */
export interface AdminAuditLogEntry {
  id: string;
  /** `<entity>.<verb>`, e.g. `product.update`, `order.status-change`. */
  action: string;
  /** The kind of thing the row is about, e.g. `product`, `order`, `coupon`. */
  entity: string;
  /** The row's own identifier — a uuid for most entities, the key itself for a setting. */
  entityId: string | null;
  actorUserId: string;
  /** The admin's name, so the trail is legible without a second lookup per line. */
  actorName: string;
  /** The changed fields only, never the whole row. A create has no `before`, a delete no `after`. */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}
