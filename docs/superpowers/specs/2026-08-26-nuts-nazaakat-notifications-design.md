# Notifications (Milestone 8) — Design

## Goal

Brief §38: "Architecture supports: order confirmation, payment confirmation, order shipped,
order delivered, RFQ received, quote sent, abandoned cart, low stock. Email / WhatsApp
integrations configurable." The `Notification` entity already exists
(`backend/src/entities/ops/notification.entity.ts`) with its own docblock stating the intent
plainly: rows are persisted, a logging no-op driver marks them `SENT`, and a real provider is
a later driver swap. This milestone builds that architecture and wires every trigger whose
write path exists (or can reasonably be added) in this repository today.

Real delivery (AWS SES for email; the WhatsApp channel's real provider to be decided later) is
explicitly out of scope — confirmed with the user. The driver interface is designed so that
swap is a new class, not a redesign.

Folded into this milestone, because it shares the same "unwired entity, mock frontend seam"
shape and is naturally paired with a notification: the contact form gets a real backend.
`SupportTicket`/`SupportTicketNote` entities already exist
(`backend/src/entities/ops/support-ticket.entity.ts`) with no controller at all — the frontend
(`contentApi.submitContactMessage`) still posts to a Phase-1 mock.

## Architecture

### `NotificationsModule`

- **`Notification` entity** — already exists, unchanged.
- **`NotificationsService.queue(manager, input)`** — the one write path.
  `manager: EntityManager` is always the caller's own — every call site in this design already
  has an open transaction (order placement, RFQ/ticket creation, a status transition) — so a
  notification for a write that gets rolled back never got queued at all. `input` is
  `{ userId: string | null; channel: NotificationChannel; template: string; payload: Record<string,
  unknown> }`. There is no transaction-less overload: a caller with no transaction of its own
  is a caller this design does not have, and adding one would invite a future call site to
  queue a notification for a write that never happened.
- **`NotificationDriver` interface** — `send(notification: Notification): Promise<{ sentAt: Date }
  | { error: string }>`. One method, because "attempt delivery and report what happened" is the
  whole contract a real provider will eventually implement.
- **`LoggingNotificationDriver`** — the only implementation this milestone ships.
  `console.info`/structured-logs the notification (via the existing Winston logger, redacted the
  same way every other log line is — `payload` can carry an email address or a phone number, and
  `pii-redactor.ts` already knows how to scrub by key name), then answers `{ sentAt: new Date() }`
  unconditionally. `NotificationsService` writes that result back onto the row (`status: SENT`,
  `sentAt`) in the same statement/transaction as the insert — so a notification is never
  observably `QUEUED` once `queue()` has returned, matching "logging no-op driver marks them
  SENT" from the entity's own docblock. The driver is injected by token
  (`NOTIFICATION_DRIVER`), so a later AWS driver is a provider swap in the module, not a change
  to any call site.
- **Never throws past the caller.** A notification is a side effect of a real write (an order,
  an RFQ, a ticket), and a broken notification must never fail the write it is attached to. Any
  error the driver reports is written as `status: FAILED, error` and swallowed; `queue()`'s own
  promise only rejects on a genuine database error writing the row, which callers do not catch
  specially (a failure to even record "we tried to notify" is treated as any other write
  failure in that transaction).

### Two new, minimal status-transition surfaces, both exported for Milestone 9

**`RfqStatusService.transition(rfqNumber, to, options)`** — new file, mirroring
`OrderStatusService.transition`'s shape at a fraction of the size: no stock consequence, no
timeline table (RFQs have no `RfqEvent`), so it is a status write and a `queue()` call, nothing
else. Needs one new thing `OrderStatusService` didn't: an `RFQ_TRANSITIONS` table in
`@nutwala/shared`, mirroring `RETAIL_TRANSITIONS`/`BULK_TRANSITIONS`'s shape, one entry per
status naming every status it may legally become next:

```
new:         [contacted, rejected]
contacted:   [quote-sent, rejected]
quote-sent:  [negotiation, approved, rejected]
negotiation: [approved, rejected]
approved:    [converted]
rejected:    []
converted:   []
```

A prospect can be turned away at any pre-quote stage (`new`/`contacted`), and a quote can be
rejected outright or after negotiation, without forcing every enquiry through a `negotiation`
step it never needed. `approved → converted` is the one step brief §34's own pipeline names
explicitly; nothing moves an enquiry backward, and `rejected`/`converted` are terminal.
`canTransition`/`nextStatuses`-equivalent functions added alongside it, one vocabulary rather
than a second copy of the pattern.

This service has no controller in this repository (Milestone 9's admin console is the only
caller, in the separate repository §7.1 describes) — exactly the position `OrderStatusService`
was in before Task 17 gave it one. It is unit- and integration-tested by calling it directly,
the same way `order-status.service.spec.ts` and its integration counterpart already do for the
order side.

**`OrderStatusService.transition`** gains one thing: a `queue()` call for `to === 'shipped'`
and `to === 'delivered'`, inside the existing transaction. No signature change, no new
exported surface — the hook lives entirely inside the method that already exists and is
already exported.

### The four reachable-now event hooks

| Trigger | Call site | Template |
|---|---|---|
| Order confirmation | `CheckoutService.place`, immediately after the order (and its items) are saved, same transaction | `order.confirmed` |
| RFQ received | `RfqsService.create`, immediately after the RFQ (and its lines/gifting detail) are saved, same transaction | `rfq.received` |
| Support ticket received | new `SupportTicketsService.create`, same transaction as the ticket insert | `support.received` |
| Low stock | one shared helper, `checkLowStock(manager, variantId)`, called after every write that changes `inventory.onHand` — `InventoryService.adjust`, `CheckoutService`'s decrement, and `OrderStatusService.putStockBack`'s restore | `stock.low` |

`checkLowStock` fires **once per crossing**, not once per read: it compares the `onHand` the
write just produced against `lowStockThreshold`, and only queues when the write's own delta
took the row from *at or above* the threshold to *below* it (a decrement crossing down) — never
when the row is written while already below it (repeated small decrements or a restock still
under threshold do not each re-notify). Read the row's value the write returned (all three call
sites already read `onHand` back from their own conditional `UPDATE ... RETURNING`), and take
the *previous* value as `onHand - delta`, so no extra read is needed.

### Contact form → `SupportTicket`

**`SupportTicketsModule`** — new. `ticket-number.ts` mirrors `rfq-number.ts`/`order-number.ts`
exactly: its own Postgres sequence, `ST-{year}-{6 digits}`, a new migration. `SupportTicketsService.create`
resolves the shape `frontend/src/routes/contact.tsx`'s form already sends (name, email, optional
phone, topic from `CONTACT_TOPICS`, optional order number as a soft link — never a foreign key,
per the entity's own docblock — message), saves, queues `support.received`, returns a
`SupportTicketSummary` (ticket number, so the customer has something to quote back, same
reasoning as every other numbered reference in this codebase).

`POST /contact` — public, `@Throttle` at the same 5/hour/IP as the RFQ routes (identical
abuse shape: unauthenticated, writes a row, no account to scope by). No read routes this
milestone — nothing reads a ticket back yet, matching how a prospect's RFQ has no read path
either until they sign in.

Frontend: `features/contact/api/index.ts` (new), `contentApi.submitContactMessage` deleted,
`routes/contact.tsx` posts to the real endpoint. A seventh route-test stub,
`contact-api.stub.ts`, mirroring the RFQ stub's shape (no CSRF modelled, matching the majority).

## Data flow, end to end (order confirmation as the example)

1. Customer completes checkout. `CheckoutService.place`'s transaction inserts the `Order`, its
   `OrderItem`s, decrements stock (with `checkLowStock` after each decrement), commits.
2. Inside that same transaction, right before it commits: `notifications.queue(manager, {...})`.
3. `queue` inserts a `Notification` row (`QUEUED`), calls `LoggingNotificationDriver.send`,
   writes the result back (`SENT`, `sentAt`) — all before the outer transaction commits, so a
   rolled-back placement never leaves a stray `SENT` notification behind either.
4. Log line written (redacted). Nothing external happened. The row is the audit trail a real
   driver will read from and now, at that point, actually acts on.

## Testing

Same rigor as every task in Milestone 7: unit tests for `NotificationsService` (queue writes
the row, driver failure marks `FAILED` and does not throw, `LoggingNotificationDriver` redacts
before logging), for `RfqStatusService` (legal/illegal transitions, 404 vs 422, the same
mutation-table discipline `order-status.service.spec.ts` already models), for `checkLowStock`'s
crossing logic (exactly-at-threshold, already-below, restocked-back-above), and for each of the
four call sites (a notification is queued with the right template and payload). Integration
tests prove a `Notification` row actually exists after each trigger, and that
`RfqStatusService.transition` and `OrderStatusService.transition`'s new hook both work against
real Postgres. `POST /contact` gets the same integration treatment `POST /rfqs` did — throttle,
validation, the ticket number pattern.

## Deliberately left undone

- **Payment confirmation.** No write path exists for `Order.paymentStatus` today — COD has no
  gateway callback, and nothing in this codebase ever moves it off `PENDING`. Milestone 9's
  admin console is what will eventually record COD collection; that is the point this trigger
  hooks into, and it does not exist yet. Recorded as a gap rather than inventing a
  payment-transition service with no real caller to justify it.
- **Abandoned cart.** Time-based, not event-based — needs a scheduler (`@nestjs/schedule` is not
  a current dependency) and a decision about the abandonment window. Deferred per the user's own
  instruction.
- **Real delivery.** AWS-based, decided later. The driver interface is what makes that a
  contained change.
- **Reading a ticket back**, admin-side triage, and everything else Milestone 9 owns for both
  RFQs and tickets.
