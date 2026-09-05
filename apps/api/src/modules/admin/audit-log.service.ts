// backend/src/modules/admin/audit-log.service.ts
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { AuditLog } from '../../entities/ops/audit-log.entity';

/**
 * What an admin did, as a closed vocabulary rather than free text.
 *
 * The `audit_logs.action` column is `varchar(60)`, so nothing at the database level stops a typo,
 * and a typo in an audit trail is not a cosmetic problem: the Milestone 9 design spec has
 * `GET /admin/audit-logs` filtering on this column, and `'product.updated'` written once beside
 * `'product.update'` twenty times makes the filter quietly incomplete. There is no way to notice
 * that from the outside, because both spellings look like real data.
 *
 * The values are `<entity>.<verb>`, matching the entity's own docblock (`product.update`), and the
 * prefix is always the `AuditEntity` the row is about. This enum covers plan 9.1's write paths
 * only — later plans add their own members as the endpoints that need them land, which is a
 * one-line change here and a compile error at any call site that guesses instead.
 */
export enum AuditAction {
  PRODUCT_CREATE = 'product.create',
  PRODUCT_UPDATE = 'product.update',
  PRODUCT_DELETE = 'product.delete',
  PRODUCT_PUBLISH = 'product.publish',
  PRODUCT_UNPUBLISH = 'product.unpublish',
  VARIANT_CREATE = 'variant.create',
  VARIANT_UPDATE = 'variant.update',
  VARIANT_DELETE = 'variant.delete',
  CATEGORY_CREATE = 'category.create',
  CATEGORY_UPDATE = 'category.update',
  /**
   * Added by plan 9.2 for `PATCH /admin/inventory/:variantId/threshold`.
   *
   * **`inventory.update`, not `inventory.threshold-change`**, and the generality is the point:
   * `product.update` covers any field change on a product with `before`/`after` naming which, and
   * an `inventory` row has exactly the same shape of write. A per-field action would mean a second
   * member the day anything else on the row becomes editable, and a filter over the trail would
   * then have to know all of them to answer "what has been done to this stock row".
   *
   * A stock **movement** deliberately has no member here. `PATCH /admin/inventory/:variantId`
   * writes an `inventory_transactions` row — append-only, carrying delta, reason, resulting balance
   * and the acting admin, which is brief §32's history in full — and that ledger is the audit trail
   * for stock. A second row in `audit_logs` saying the same thing would be a second place to look
   * and a second thing to keep in step. `GET /admin/audit-logs` (plan 9.4) therefore does not show
   * stock movements, and should say so.
   */
  INVENTORY_UPDATE = 'inventory.update',
  /**
   * Added by plan 9.2 for `POST /admin/orders/:orderNumber/status`.
   *
   * **Specific where `INVENTORY_UPDATE` is generic, and the difference is real rather than a
   * lapse.** That member's docblock argues against a per-field action because the route it serves
   * *edits a field* on a row, and the next editable field would need a second member. A status
   * change is not a field edit: it is a move through the state machine `@nutwala/shared` owns, with
   * a legality check, a timeline row and a stock consequence behind it, and spec §5 names it in
   * those words — *"a delete or a status change that leaves no trace is a defect in this
   * milestone"*. A later `PATCH /admin/orders/:orderNumber` correcting an address would be
   * `order.update`, and the two would rightly be different rows in the trail.
   *
   * `entityId` is the order's **uuid**, its primary key, matching every other member here — the
   * order *number* is an application-generated alternate key. `after.orderNumber` carries it for
   * legibility, so `GET /admin/audit-logs` (plan 9.4) can show the reference an operator can read
   * down a phone line without joining `orders`.
   *
   * The spelling differs from `audit-log.entity.ts`'s illustrative `order.status.change`, which
   * has three segments and would break this enum's stated `<entity>.<verb>` shape.
   * `INVENTORY_UPDATE` already departed from that docblock's `inventory.adjust` for the same
   * reason: the examples there predate this vocabulary.
   */
  ORDER_STATUS_CHANGE = 'order.status-change',
  /**
   * Added by plan 9.2 for `POST /admin/orders/:orderNumber/payment/collect` — spec §10.4's COD
   * collection.
   *
   * A member of its own rather than a second `order.*` action, because the row it changes is a
   * different row: `payments`, whose `status` and `collectedAt` are what an accounts query reads.
   * `entityId` is the payment's uuid for that reason, and `after.orderNumber` carries the reference
   * an operator can search for, since the order is otherwise a join away.
   *
   * There is no `payment.refund` member and should not be one until something refunds. A refund
   * today is an order transition — `delivered -> refunded` — and `orders.paymentStatus` is what it
   * moves; a `payments` row is not touched by it at all.
   */
  PAYMENT_COLLECT = 'payment.collect',
  /**
   * Added by plan 9.2 for `POST /admin/orders/:orderNumber/shipment`.
   *
   * A `shipment.create` row and an `order.status-change` row are written by that one request, in one
   * transaction, and both belong in the trail: they record different facts about different tables —
   * that a parcel was handed to a named courier, and that the order moved to `shipped`. Collapsing
   * them into one would make "which courier" a field of a status change, and would leave the day a
   * shipment is recorded some other way with nothing to write.
   *
   * There is no `shipment.update` member because no route updates a shipment; see
   * `CreateShipmentDto`, which records that gap.
   */
  SHIPMENT_CREATE = 'shipment.create',
  /**
   * Added by plan 9.3 for the status half of `PATCH /admin/rfqs/:rfqNumber`.
   *
   * Specific rather than folded into `RFQ_UPDATE` below, for the reason `ORDER_STATUS_CHANGE`
   * gives: a status change is not a field edit. It is a move through the state machine
   * `@nutwala/shared`'s `RFQ_TRANSITIONS` owns, with a legality check and a queued notification
   * behind it, and spec §5 names it in those words — *"a delete or a status change that leaves no
   * trace is a defect in this milestone"*. Written **inside** `RfqStatusService.transition`'s own
   * transaction, which is the only place it can be atomic with the change.
   *
   * `entityId` is the RFQ's uuid; `after.rfqNumber` carries the readable reference.
   */
  RFQ_STATUS_CHANGE = 'rfq.status-change',
  /**
   * Added by plan 9.3 for the field half of `PATCH /admin/rfqs/:rfqNumber` — brief §34's expected
   * value and assigned salesperson.
   *
   * Generic where `RFQ_STATUS_CHANGE` is specific, exactly the split `INVENTORY_UPDATE` and
   * `ORDER_STATUS_CHANGE` already draw: this route *edits fields* on a row, with `before`/`after`
   * naming which, and a per-field action would need a second member the next time anything on an
   * enquiry becomes editable.
   *
   * One request can write **both** this and `RFQ_STATUS_CHANGE`, in one transaction, and both
   * belong: they record different facts, and collapsing them would make "which salesperson" a
   * field of a status change. `SHIPMENT_CREATE` sits beside `ORDER_STATUS_CHANGE` the same way.
   */
  RFQ_UPDATE = 'rfq.update',
  /**
   * Added by plan 9.3 for `POST /admin/rfqs/:rfqNumber/notes` — brief §34's internal notes.
   *
   * **`after` carries the note's id and the RFQ's number, and deliberately not its body.** The
   * `rfq_notes` row *is* the record: append-only, carrying the author (`ON DELETE RESTRICT`, so it
   * can never lose one), the timestamp and the text. Copying the text here would put a confidential
   * sales note in a second table, which is a second place it has to be protected and a second place
   * it can be read from. What this row adds is that the note was written at all, by whom, and
   * against which enquiry — which is what an audit trail is for.
   *
   * `entityType` is `RFQ` rather than a `rfq-note` member of its own, so filtering the trail by
   * `entity = 'rfq'` and `entityId = <uuid>` answers "everything that has been done to this
   * enquiry" in one query. `SHIPMENT_CREATE` chose the opposite because a shipment is a row an
   * operator addresses in its own right; a note is not.
   */
  RFQ_NOTE_ADD = 'rfq.note-add',
  /**
   * Added by plan 9.3 for `POST /admin/pricing-tiers` and `PATCH /admin/pricing-tiers/:id` — brief
   * §31's quantity tiers and customer-specific pricing.
   *
   * Two members rather than one `pricing-tier.write`, matching every other create/update pair here:
   * a create has only an `after` and an update has both, and `GET /admin/audit-logs` (plan 9.4)
   * filtering for "who introduced this price" is a different question from "who changed it".
   *
   * There is no delete member because there is no delete route — spec §6.4 lists `GET`, `POST` and
   * `PATCH` for this resource and nothing else.
   */
  PRICING_TIER_CREATE = 'pricing-tier.create',
  PRICING_TIER_UPDATE = 'pricing-tier.update',
  /**
   * Added by plan 9.4 for `/admin/coupons` — brief §36.
   *
   * `entityId` is the coupon **code**, not its uuid, and this is the first member here to depart
   * from "the row's primary key". The departure is the same one the routes make: a coupon is
   * addressed by `:code` everywhere (`AdminCoupon`'s docblock has the full case), `uq_coupons_code`
   * makes it unique, and `orders.couponCode` already snapshots it as the permanent record of which
   * coupon an order used. A trail keyed on a uuid could not be joined to that snapshot at all,
   * which is the one question anybody asks of a coupon's history — *"who created WELCOME10, and did
   * anyone change it after it went out?"*
   *
   * That is also why `AdminCouponsService.update` refuses to change `code`: an immutable identifier
   * is what makes it safe to key both this trail and the order snapshot on.
   */
  COUPON_CREATE = 'coupon.create',
  COUPON_UPDATE = 'coupon.update',
  COUPON_DELETE = 'coupon.delete',
  /**
   * Added by plan 9.4 for `POST /admin/reviews/:id/approve` and `.../reject` — brief §27.
   *
   * **Two members, not one `review.moderate` carrying the outcome**, and the reasoning is
   * `ORDER_STATUS_CHANGE`'s in reverse. That member is one action because a status change is one
   * kind of event whose destination is data; these are two because approving and rejecting have
   * different consequences — an approval moves `products.ratingAvg` and puts the review on the
   * storefront, a rejection carries a reason and does neither. "What did we reject last week" is a
   * real question of this trail, and it is unanswerable through an indexed `action` column if the
   * outcome is buried in a jsonb payload.
   *
   * `entityId` is the review's uuid, which is what `POST /admin/reviews/:id/...` addresses.
   */
  REVIEW_APPROVE = 'review.approve',
  REVIEW_REJECT = 'review.reject',
  /**
   * Added by plan 9.4 for `/admin/posts` — brief §28.
   *
   * `entityId` is the post's **slug**, for `COUPON_CREATE`'s reason and one more: the slug is the
   * live URL, so a trail keyed on it answers "what happened to `/blog/how-to-store-dry-fruits`"
   * directly. Unlike a coupon code the slug **is** mutable — `AdminPostsService.update` allows it,
   * because brief §39 makes the slug an editable SEO field — so a rename writes a `post.update` row
   * whose `before.slug` and `after.slug` are the only join between the two identities. That is why
   * the rename is audited with both halves rather than with the new value alone.
   *
   * There is no `post.publish` / `post.unpublish` pair, unlike products. §6.4 gives a product a
   * publish endpoint of its own and gives a post none, so a publication change is a `post.update`
   * carrying `isPublished` in `before`/`after`, exactly like any other field.
   */
  POST_CREATE = 'post.create',
  POST_UPDATE = 'post.update',
  POST_DELETE = 'post.delete',
  /**
   * Added by plan 9.4 for `PATCH /admin/support/tickets/:ticketNumber` — brief §38.
   *
   * **Generic, following `INVENTORY_UPDATE` rather than `ORDER_STATUS_CHANGE`.** A ticket's status,
   * priority and assignee are three editable fields on one row and an operator routinely moves two
   * at once ("assign to me and mark it open"); a per-field action would mean three members, and a
   * filter over the trail would have to know all of them to answer "what has been done to this
   * ticket". A ticket status is not a state machine either — nothing in `shared/` validates a move
   * between `SUPPORT_TICKET_STATUSES`, unlike the order vocabulary `ORDER_STATUS_CHANGE` exists for.
   *
   * `entityId` is the ticket's **number**, the identifier every support route is addressed by.
   */
  SUPPORT_TICKET_UPDATE = 'support-ticket.update',
  /**
   * Added by plan 9.4 for `POST /admin/support/tickets/:ticketNumber/notes`.
   *
   * A member of its own rather than a `support-ticket.update`, because it writes a different row —
   * `support_ticket_notes` — and changes nothing on the ticket itself. Collapsing the two would
   * make "what was said" indistinguishable from "what was changed" in a trail whose whole job is
   * telling them apart.
   */
  SUPPORT_TICKET_NOTE = 'support-ticket.note',
  /**
   * Added by plan 9.4 for `PUT /admin/settings` — brief §26 and §37.
   *
   * **One row per key changed, not one per request.** A `PUT` carrying five keys of which two
   * differ writes two rows, and `entityId` is the `settings` key itself — the table's actual
   * primary key, a `varchar(60)` — so this is not a departure from "the row's key" the way
   * `COUPON_CREATE` is. Keying on the request instead would make "when did the WhatsApp number last
   * change" a scan of every payload in the trail rather than a filter on the indexed column.
   *
   * There is no `setting.create` or `setting.delete`: `replace` refuses a key that does not already
   * exist, and nothing deletes one. `AdminSettingsService` records why.
   */
  SETTING_UPDATE = 'setting.update',
}

/**
 * Which kind of thing the row is about, written to `audit_logs.entity` (`varchar(40)`, indexed).
 *
 * Typed for the same reason `AuditAction` is, and the reason is stronger here rather than weaker:
 * the column is *indexed* precisely so it can be filtered on, and `'product'` / `'Product'` /
 * `'products'` drifting across the twenty-five admin write paths still to come would make that
 * index answer a question nobody asked. The plan only names `action` as an enum; extending the
 * same treatment to this field is a judgment call, recorded here so it can be reversed knowingly.
 */
export enum AuditEntity {
  PRODUCT = 'product',
  VARIANT = 'variant',
  CATEGORY = 'category',
  /**
   * Added by plan 9.2. `entityId` is the **variant id**, because that is what `inventory` is keyed
   * by — the table has no surrogate key of its own — and what `/admin/inventory/:variantId`
   * addresses. So an `inventory` row and a `variant` row in this trail share an `entityId` and are
   * told apart by `entity`, which is exactly what the column is indexed for.
   */
  INVENTORY = 'inventory',
  /**
   * Added by plan 9.2. `entityId` is the order's uuid — `orders.id`, its primary key — not the
   * order number, so this trail addresses rows the same way the rest of it does. The readable
   * `orderNumber` travels in the payload instead.
   */
  ORDER = 'order',
  /**
   * Added by plan 9.2. `entityId` is the `payments` row's own uuid — the row that changed — with
   * the order number in the payload, because an audit trail keyed on a payment uuid is unreadable
   * without it.
   */
  PAYMENT = 'payment',
  /** Added by plan 9.2. `entityId` is the `shipments` row's uuid, with the order number in the payload. */
  SHIPMENT = 'shipment',
  /**
   * Added by plan 9.3. `entityId` is the RFQ's uuid — `rfqs.id` — not the RFQ number, so this trail
   * addresses rows the same way the rest of it does; the readable `RFQ-2026-000123` travels in the
   * payload instead.
   *
   * Internal notes are recorded against this entity too rather than under a `rfq-note` kind of their
   * own, so one filter answers "everything that has been done to this enquiry". See
   * `AuditAction.RFQ_NOTE_ADD`.
   */
  RFQ = 'rfq',
  /**
   * Added by plan 9.3. `entityId` is the `pricing_tiers` row's own uuid, with the product's slug and
   * the tier's bounds in the payload — a ladder rung addressed by uuid is unreadable without them,
   * and the row it prices is the thing an operator is actually asking about.
   */
  PRICING_TIER = 'pricing-tier',
  /**
   * Added by plan 9.4. `entityId` is the coupon's **code**, not its uuid — see `COUPON_CREATE`.
   *
   * The first entity in this trail keyed on something other than a primary key, and the reason is
   * that `orders.couponCode` is a snapshot string: keyed on a uuid, no row in this trail could ever
   * be joined to the orders that used the coupon.
   */
  COUPON = 'coupon',
  /** Added by plan 9.4. `entityId` is the review's uuid, which `/admin/reviews/:id/...` addresses. */
  REVIEW = 'review',
  /** Added by plan 9.4. `entityId` is the post's **slug**, which is also its live URL — see `POST_CREATE`. */
  POST = 'post',
  /**
   * Added by plan 9.4. `entityId` is the ticket **number** (`ST-2026-000123`), not the uuid.
   *
   * Hyphenated, unlike every member above, because the wire and the routes both spell it
   * `support/tickets` and `support-ticket.update` is what the `<entity>.<verb>` rule then produces.
   * `varchar(40)` has room for it several times over.
   */
  SUPPORT_TICKET = 'support-ticket',
  /**
   * Added by plan 9.4. `entityId` is the setting's key — which *is* `settings`' primary key, so
   * unlike `COUPON` and `POST` this member keeps the original convention rather than departing
   * from it.
   */
  SETTING = 'setting',
}

export interface AuditLogInput {
  /** From the signed token, never from a request body. See `InventoryController.adjust`. */
  actorUserId: string;
  action: AuditAction;
  /** Maps onto the entity's `entity` column; spelled `entityType` because `entity: 'product'`
   * reads as an instance rather than a kind, and both plan 9.1 and the task brief name it so. */
  entityType: AuditEntity;
  entityId: string;
  /**
   * The changed fields, not the whole row: a create has only an `after`, a delete only a `before`,
   * an update both. Omitted means `null`, which is what the column stores.
   */
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/**
 * The one write path onto `audit_logs`.
 *
 * `manager` is the caller's own open transaction, always, and there is deliberately no
 * transaction-less overload — the contract `NotificationsService.queue` states, for the identical
 * reason. An audit row committed separately from the change it describes fails in both directions:
 * it can outlive a write that rolled back, claiming a change that never happened, or be lost while
 * the write survives, hiding one that did. Both are worse than having no audit trail at all,
 * because both get trusted. Sharing the caller's transaction makes the row and the change it
 * records atomic by construction rather than by anybody's care.
 *
 * **One deliberate difference from notifications: a failed audit write fails the operation.**
 * `queue` catches a driver error and records `FAILED`, because a broken notification must not undo
 * a real order. Nothing here is caught. An admin mutation that cannot be attributed is not a
 * mutation this service is willing to have made, so the exception propagates and takes the
 * caller's transaction down with it. That is the whole reason `record` has no error channel of
 * its own to swallow into.
 *
 * There is no repository, no `DataSource` and no constructor argument, and that is load-bearing
 * rather than incidental: with nothing of its own to open a transaction *with*, the contract above
 * cannot be broken by a later edit that reaches for a convenience. `audit-log.service.spec.ts`
 * pins it.
 *
 * `ip` and `userAgent` are left `null`. Both columns exist for the request-scoped
 * `AuditInterceptor` the initial schema anticipated, which was never built; a service called from
 * inside a transaction has no request to read them from. Populating them means passing them in
 * from a controller, which is a change to this input shape and to every call site, not a change
 * here — worth knowing before someone assumes the columns are simply unused.
 */
@Injectable()
export class AuditLogService {
  /**
   * `save`, not `insert`, and not by preference: `insert` types its argument as
   * `QueryDeepPartialEntity`, which recurses into the `before`/`after` jsonb columns and turns
   * `Record<string, unknown>` into a shape no arbitrary object satisfies (TS2322 on both columns).
   * `DeepPartial` admits the unmapped type, so `save` accepts them. `NotificationsService.queue`
   * writes its row the same way. The row has no `id`, so this is an insert either way.
   */
  async record(manager: EntityManager, input: AuditLogInput): Promise<void> {
    await manager.getRepository(AuditLog).save({
      actorUserId: input.actorUserId,
      action: input.action,
      entity: input.entityType,
      entityId: input.entityId,
      before: input.before ?? null,
      after: input.after ?? null,
      ip: null,
      userAgent: null,
    });
  }
}
