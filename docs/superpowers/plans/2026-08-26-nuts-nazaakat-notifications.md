# Notifications (Milestone 8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the notifications architecture brief §38 asks for (queue + a logging no-op driver, real delivery deferred), wire its four reachable-now triggers (order confirmed, RFQ received, support ticket received, low stock), add the RFQ status-transition service Milestone 9's admin console will call, and give the contact form a real backend (`SupportTicket`) in place of its Phase‑1 mock.

**Architecture:** A `NotificationsService.queue(manager, input)` is the one write path onto the existing `Notification` table — it always takes the caller's own open transaction, inserts a `QUEUED` row, calls a driver bound by DI token, and writes back `SENT`/`FAILED` before the caller's transaction can commit. This milestone ships exactly one driver, `LoggingNotificationDriver`, which logs (redacted) and answers success unconditionally; a real provider (AWS SES, WhatsApp — decided later) is a second class bound to the same token. Four services gain a `queue()` call inside a transaction they already run: `CheckoutService.place` (order confirmed), `RfqsService.create` (RFQ received), the new `SupportTicketsService.create` (support ticket received), and a shared `checkLowStock` helper wired into every write that changes `inventory.onHand`. A new `RfqStatusService.transition`, mirroring `OrderStatusService.transition` at a fraction of the size, is exported with no controller — Milestone 9's admin console, in its own separate repository, is its only intended caller, exactly the position `OrderStatusService` was in before Task 17 of the B2B plan gave it a route.

**Tech Stack:** NestJS 11, TypeORM 0.3.31, Postgres 15, Jest (backend), Vitest (shared, frontend), React 19, TanStack Router/Query.

---

## Before you start

- Branch: continue on `feat/phase-2-backend` (same branch Milestone 7 finished on), or whatever branch the dispatching session tells you to use. Do not start on `main`.
- Every backend integration test needs a real Postgres instance. `useIntegrationApp()` (`backend/test/integration/helpers/use-integration-app.ts`) manages the container lifecycle itself when run through the normal `npm run test:integration -w backend` command — do not start a container by hand for these.
- **`NODE_ENV` hazard, learned the hard way earlier in this project:** any ad hoc backend command (`npm run migration:run`, `npm run seed`, booting the app directly) must be run with `NODE_ENV=test` inlined on the same shell line as the command itself, never a separate `export`. Any other value silently lets `.env`'s real values override whatever `DB_HOST`/`DB_PORT` the shell already has, which can point the command at the real dev database. The tasks below only need `npm run test`/`npm run test:integration`, which already set this up — this note is for anyone tempted to shortcut with a direct `migration:run` or `seed` call.
- Money crosses the wire in rupees, is stored in paise (`bigint`), via `toPaise`/`toRupees` at the boundary. Every task below that touches money follows that rule; none of this milestone's own writes introduce new money columns, but the `order.confirmed` notification payload borrows `toRupees` to keep a `bigint` out of a `jsonb` column (a raw `bigint` cannot be `JSON.stringify`'d — Task 5 explains why this matters concretely).
- After Task 1 (the only task that edits `shared/src`), run `npm run build -w @nutwala/shared` once. Backend Jest tests resolve `@nutwala/shared` straight from `shared/src/index.ts` (see `backend/jest.config.ts`'s `moduleNameMapper`) and never need this, but both `npm run typecheck -w backend`, `npm run typecheck -w frontend` and `npm run test -w frontend` (Vitest) resolve the package via `node_modules/@nutwala/shared` → `shared/package.json`'s `"types": "dist/index.d.ts"` / `"main": "dist/index.js"` — stale until rebuilt. No later task edits `shared/src` again, so this is a one-time step.

## File structure

```
shared/src/
  constants/
    rfq-status.ts              NEW  RFQ_TRANSITIONS, nextRfqStatuses, canTransitionRfq
    rfq-status.test.ts         NEW
    identifiers.ts              +   TICKET_NUMBER_PATTERN
  types/
    support.ts                 NEW  SupportTicketSummary, CreateContactMessageRequest
  index.ts                      +   two barrel lines

backend/src/
  modules/
    notifications/              NEW module
      notification-driver.ts     NotificationDriver interface, NOTIFICATION_DRIVER token
      logging-notification.driver.ts + .spec.ts
      notifications.service.ts   + .spec.ts
      notifications.module.ts
    rfqs/
      rfq-status.service.ts     NEW  + .spec.ts
      rfqs.module.ts              +   imports NotificationsModule, providers/exports RfqStatusService
      rfqs.service.ts             +   queues rfq.received
      rfqs.service.spec.ts        +   notifications fake threaded through both harnesses
    inventory/
      check-low-stock.ts        NEW  + .spec.ts
      inventory.service.ts       +   injects NotificationsService, calls checkLowStock
      inventory.service.spec.ts   +   notifications fake
      inventory.module.ts         +   imports NotificationsModule
    checkout/
      checkout.service.ts         +   injects NotificationsService, queues order.confirmed, calls checkLowStock
      checkout.service.spec.ts    +   notifications fake
      checkout.module.ts          +   imports NotificationsModule
    orders/
      order-status.service.ts     +   injects NotificationsService, queues order.shipped/order.delivered, calls checkLowStock
      order-status.service.spec.ts +  notifications fake
      orders.module.ts             +  imports NotificationsModule
    support-tickets/            NEW module
      ticket-number.ts           + .spec.ts
      dto/create-contact-message.dto.ts
      support-tickets.service.ts  + .spec.ts
      support-tickets.controller.ts + .spec.ts
      support-tickets.module.ts
  database/migrations/
    20260826100000-TicketNumberSequence.ts   NEW
  app.module.ts                   +   registers NotificationsModule, SupportTicketsModule

backend/test/integration/
  notifications.integration.spec.ts   NEW
  rfq-status.integration.spec.ts      NEW
  support-tickets.integration.spec.ts NEW
  checkout.integration.spec.ts         +  order.confirmed test
  orders.integration.spec.ts           +  order.shipped/order.delivered test
  inventory.integration.spec.ts        +  stock.low crossing test
  rfqs.integration.spec.ts             +  rfq.received test

frontend/src/
  features/
    contact/                    NEW feature folder
      schema.ts                  moved from features/content/schema.ts, orderId renamed to orderNumber
      api/index.ts                NEW  contactApi.submit
      hooks/useContact.ts         NEW  useSubmitContactMessage
    content/
      schema.ts                  DELETE (contact-only file, fully moved)
      types.ts                    -    ContactMessageDraft/ContactMessage removed (blog types stay)
      api/index.ts                 -   submitContactMessage removed
      hooks/useContent.ts          -   useSubmitContactMessage removed
  routes/contact.tsx              rewritten: real endpoint, orderNumber field, shows the ticket number back
  test/
    contact-api.stub.ts         NEW  8th route-test handler
    auth-api.stub.ts             +   registers it
    routes.smoke.test.tsx        +   contact-submission test

docs/superpowers/plans/2026-08-26-nuts-nazaakat-notifications.md   this file, gains a "Milestone 8 complete" section in Task 11
```

---

### Task 1: Shared — RFQ status transitions and support-ticket wire types

**Files:**
- Create: `shared/src/constants/rfq-status.ts`
- Create: `shared/src/constants/rfq-status.test.ts`
- Create: `shared/src/types/support.ts`
- Modify: `shared/src/constants/identifiers.ts`
- Modify: `shared/src/index.ts`

- [ ] **Step 1: Write `rfq-status.ts`**

```typescript
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
```

- [ ] **Step 2: Write `rfq-status.test.ts`**

```typescript
// shared/src/constants/rfq-status.test.ts
import { describe, expect, it } from 'vitest';
import { canTransitionRfq, nextRfqStatuses, RFQ_TRANSITIONS } from './rfq-status';
import { RFQ_STATUSES } from './taxonomy';

describe('RFQ_TRANSITIONS', () => {
  it('has exactly one entry per status in RFQ_STATUSES', () => {
    expect(Object.keys(RFQ_TRANSITIONS).sort()).toEqual([...RFQ_STATUSES].sort());
  });

  it('allows each forward step of the happy path', () => {
    expect(canTransitionRfq('new', 'contacted')).toBe(true);
    expect(canTransitionRfq('contacted', 'quote-sent')).toBe(true);
    expect(canTransitionRfq('quote-sent', 'negotiation')).toBe(true);
    expect(canTransitionRfq('negotiation', 'approved')).toBe(true);
    expect(canTransitionRfq('approved', 'converted')).toBe(true);
  });

  it('lets a prospect be turned away at either pre-quote stage', () => {
    expect(canTransitionRfq('new', 'rejected')).toBe(true);
    expect(canTransitionRfq('contacted', 'rejected')).toBe(true);
  });

  it('lets a quote be rejected outright, or after negotiation', () => {
    expect(canTransitionRfq('quote-sent', 'rejected')).toBe(true);
    expect(canTransitionRfq('negotiation', 'rejected')).toBe(true);
  });

  it('lets a sent quote skip negotiation and go straight to approved', () => {
    expect(canTransitionRfq('quote-sent', 'approved')).toBe(true);
  });

  it('refuses to move backwards', () => {
    expect(canTransitionRfq('approved', 'new')).toBe(false);
    expect(canTransitionRfq('negotiation', 'contacted')).toBe(false);
  });

  it('refuses a no-op', () => {
    for (const status of RFQ_STATUSES) {
      expect(canTransitionRfq(status, status)).toBe(false);
    }
  });

  it('treats rejected and converted as terminal', () => {
    expect(nextRfqStatuses('rejected')).toEqual([]);
    expect(nextRfqStatuses('converted')).toEqual([]);
  });

  it('refuses to skip straight from new to approved', () => {
    expect(canTransitionRfq('new', 'approved')).toBe(false);
  });
});
```

- [ ] **Step 3: Append `TICKET_NUMBER_PATTERN` to `identifiers.ts`**

Add after `RFQ_NUMBER_PATTERN`'s declaration:

```typescript
/**
 * `ST-{year}-{at least 6 digits}` — a support ticket's reference, the same shape as
 * `ORDER_NUMBER_PATTERN`/`RFQ_NUMBER_PATTERN` and for the identical reason: declared here so the
 * frontend's contact-form stub and the backend's `ticket-number.ts` import the one definition
 * instead of a second regex that drifts to `{6}`.
 */
export const TICKET_NUMBER_PATTERN = /^ST-\d{4}-\d{6,}$/;
```

- [ ] **Step 4: Write `shared/src/types/support.ts`**

```typescript
// shared/src/types/support.ts
/**
 * `POST /contact`'s response — just enough for the customer to quote the ticket back, the same
 * reasoning every other numbered reference in this codebase gives (`AccountOrder.id`,
 * `RfqSummary.id`).
 */
export interface SupportTicketSummary {
  /** `ST-{year}-{at least 6 digits}`. See `TICKET_NUMBER_PATTERN`. */
  ticketNumber: string;
}

/**
 * `POST /contact`'s body. Every field exists on `CreateContactMessageDto`; the two are checked
 * against each other by the backend's own compilation, since the controller binds the DTO.
 *
 * `orderNumber` is optional and deliberately unvalidated for shape on both sides — `SupportTicket`
 * carries it as a soft link, not a foreign key, so a customer who is unsure of the exact number
 * still raises a ticket.
 */
export interface CreateContactMessageRequest {
  name: string;
  email: string;
  phone?: string;
  topic: string;
  orderNumber?: string;
  message: string;
}
```

- [ ] **Step 5: Add the two barrel lines to `shared/src/index.ts`**

```typescript
export * from './constants/rfq-status';
export * from './types/support';
```

Grouped alphabetically with their neighbours: `constants/rfq-status` goes *before* `constants/taxonomy` (between it and `constants/order-status`), and `types/support` goes after `types/business`, which is currently the last `types/*` line.

- [ ] **Step 6: Run the shared test suite**

Run: `npm run test -w @nutwala/shared`
Expected: all tests pass, including the new `rfq-status.test.ts`.

- [ ] **Step 7: Build shared, so downstream typecheck and frontend Vitest see the new exports**

Run: `npm run build -w @nutwala/shared`
Expected: exits 0. Confirm `shared/dist/constants/rfq-status.js` and `shared/dist/types/support.d.ts` now exist.

- [ ] **Step 8: Commit**

```bash
git add shared/src/constants/rfq-status.ts shared/src/constants/rfq-status.test.ts \
  shared/src/constants/identifiers.ts shared/src/types/support.ts shared/src/index.ts
git commit -m "feat(shared): RFQ status transitions and support-ticket wire types"
```

(`shared/dist` is gitignored in this repo and must stay that way — Step 7's build is a local artifact for downstream typecheck/Vitest to resolve against, not something to commit. Do not `git add -f` it.)

---

### Task 2: Backend — Notifications core

**Files:**
- Create: `backend/src/modules/notifications/notification-driver.ts`
- Create: `backend/src/modules/notifications/logging-notification.driver.ts`
- Create: `backend/src/modules/notifications/logging-notification.driver.spec.ts`
- Create: `backend/src/modules/notifications/notifications.service.ts`
- Create: `backend/src/modules/notifications/notifications.service.spec.ts`
- Create: `backend/src/modules/notifications/notifications.module.ts`
- Create: `backend/test/integration/notifications.integration.spec.ts`
- Modify: `backend/src/app.module.ts`

- [ ] **Step 1: Write `notification-driver.ts`**

```typescript
// backend/src/modules/notifications/notification-driver.ts
import type { Notification } from '../../entities/ops/notification.entity';

/**
 * The one thing a delivery channel has to do: attempt to send, and report what happened.
 *
 * `send` is expected never to throw — a driver that cannot reach its provider answers
 * `{ error }` rather than rejecting, so `NotificationsService.queue` can write `FAILED` and move
 * on without wrapping every call in a try/catch of its own. `NotificationsService` still guards
 * the call defensively, in case a future driver does not honour this.
 */
export interface NotificationDriver {
  send(notification: Notification): Promise<{ sentAt: Date } | { error: string }>;
}

/**
 * The DI token `NotificationsModule` binds a driver to. A later real provider (AWS SES for
 * email; WhatsApp's provider, decided later) is a second class bound to this same token in that
 * module — no call site of `NotificationsService.queue` changes.
 */
export const NOTIFICATION_DRIVER = Symbol('NOTIFICATION_DRIVER');
```

- [ ] **Step 2: Write `logging-notification.driver.ts`**

```typescript
// backend/src/modules/notifications/logging-notification.driver.ts
import { Injectable } from '@nestjs/common';
import { WinstonLoggerService } from '../../common/logging/winston-logger.service';
import type { Notification } from '../../entities/ops/notification.entity';
import type { NotificationDriver } from './notification-driver';

/**
 * Brief §38's architecture, with no real provider yet. Logs the notification through the shared
 * Winston logger — which redacts `meta` the same way every other log line is scrubbed
 * (`pii-redactor.ts` masks `email`/`phone`/`mobile` by key name wherever they appear inside a
 * nested object, including inside `payload` here) — and answers success unconditionally.
 * `NotificationsService` writes that answer onto the row in the same transaction, so nothing is
 * ever left `QUEUED` once `queue()` returns, matching the entity's own docblock: *"a logging
 * no-op driver marks them SENT."*
 */
@Injectable()
export class LoggingNotificationDriver implements NotificationDriver {
  private readonly logger: WinstonLoggerService;

  constructor(logger: WinstonLoggerService) {
    this.logger = logger.setContext(LoggingNotificationDriver.name);
  }

  async send(notification: Notification): Promise<{ sentAt: Date }> {
    this.logger.log('Notification (logging driver — no real delivery configured yet)', {
      event: 'notification.logged',
      notificationId: notification.id,
      userId: notification.userId,
      channel: notification.channel,
      template: notification.template,
      payload: notification.payload,
    });
    return { sentAt: new Date() };
  }
}
```

- [ ] **Step 3: Write `logging-notification.driver.spec.ts`**

```typescript
// backend/src/modules/notifications/logging-notification.driver.spec.ts
import { NotificationChannel, NotificationStatus } from '../../entities/enums';
import type { Notification } from '../../entities/ops/notification.entity';
import type { WinstonLoggerService } from '../../common/logging/winston-logger.service';
import { LoggingNotificationDriver } from './logging-notification.driver';

interface RecordedLog {
  message: string;
  meta?: unknown;
}

/** `sessions.service.spec.ts`'s own `fakeLogger` shape — a closure-recorded double, not a mock
 * library object, so a call's arguments are asserted directly rather than through matchers. */
function fakeLogger(): WinstonLoggerService & { entries: RecordedLog[] } {
  const entries: RecordedLog[] = [];
  const logger: Partial<WinstonLoggerService> & { entries: RecordedLog[] } = {
    entries,
    setContext: () => logger as WinstonLoggerService,
    log: (message: string, meta?: unknown) => void entries.push({ message, meta }),
    error: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
  };
  return logger as WinstonLoggerService & { entries: RecordedLog[] };
}

const NOTIFICATION: Notification = {
  id: 'notif-1',
  createdAt: new Date('2026-08-26T00:00:00.000Z'),
  updatedAt: new Date('2026-08-26T00:00:00.000Z'),
  user: null,
  userId: 'user-1',
  channel: NotificationChannel.EMAIL,
  template: 'order.confirmed',
  payload: { orderNumber: 'NN-2026-100000', email: 'asha@demo.in' },
  status: NotificationStatus.QUEUED,
  sentAt: null,
  error: null,
};

describe('LoggingNotificationDriver.send', () => {
  it('logs the notification and answers a fresh sentAt, unconditionally', async () => {
    const logger = fakeLogger();
    const driver = new LoggingNotificationDriver(logger);

    const before = Date.now();
    const result = await driver.send(NOTIFICATION);

    expect(result.sentAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.meta).toMatchObject({
      event: 'notification.logged',
      notificationId: 'notif-1',
      userId: 'user-1',
      channel: NotificationChannel.EMAIL,
      template: 'order.confirmed',
      payload: { orderNumber: 'NN-2026-100000', email: 'asha@demo.in' },
    });
  });

  it('sets its own logger context to its class name', () => {
    const logger = fakeLogger();
    const setContext = jest.spyOn(logger, 'setContext');
    new LoggingNotificationDriver(logger);
    expect(setContext).toHaveBeenCalledWith('LoggingNotificationDriver');
  });
});
```

- [ ] **Step 4: Run the new spec**

Run: `npx jest logging-notification.driver.spec.ts --config backend/jest.config.ts` (from repo root) or `cd backend && npx jest logging-notification.driver.spec.ts`
Expected: 2 passed.

- [ ] **Step 5: Write `notifications.service.ts`**

```typescript
// backend/src/modules/notifications/notifications.service.ts
import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { NotificationChannel, NotificationStatus } from '../../entities/enums';
import { Notification } from '../../entities/ops/notification.entity';
import { NOTIFICATION_DRIVER, type NotificationDriver } from './notification-driver';

/** `notifications.error` is `varchar(300)`; `OrderStatusService`'s `CANCEL_REASON_MAX` states the
 * identical reason for truncating rather than letting a long message fail the write outright. */
const ERROR_MAX = 300;

export interface QueueInput {
  userId: string | null;
  channel: NotificationChannel;
  template: string;
  payload: Record<string, unknown>;
}

/**
 * The one write path onto `notifications`. Brief §38's architecture: rows are always persisted,
 * and the driver bound to `NOTIFICATION_DRIVER` decides whether "sent" means a real provider was
 * called or (this milestone, always) a log line.
 *
 * `manager` is the caller's own open transaction, always — there is deliberately no
 * transaction-less overload. Every call site in this design already has one open (placing an
 * order, creating an RFQ or a ticket, a status transition), so a write that rolls back never
 * leaves a queued notification behind either. A caller with no transaction of its own is a
 * caller this service does not have; adding a convenience overload would invite exactly that one.
 *
 * Never throws past its own database write. A broken notification must not fail the real write
 * it is attached to, so a driver's reported failure — or an exception it throws despite its own
 * contract — is written as `FAILED` and swallowed. Only a genuine failure to write the row
 * itself propagates, and that is treated as any other failure inside the caller's transaction: a
 * notification is a side effect of the write, not a separate concern with its own error channel.
 */
@Injectable()
export class NotificationsService {
  constructor(@Inject(NOTIFICATION_DRIVER) private readonly driver: NotificationDriver) {}

  async queue(manager: EntityManager, input: QueueInput): Promise<void> {
    const notification = await manager.getRepository(Notification).save({
      userId: input.userId,
      channel: input.channel,
      template: input.template,
      payload: input.payload,
      status: NotificationStatus.QUEUED,
      sentAt: null,
      error: null,
    });

    let result: { sentAt: Date } | { error: string };
    try {
      result = await this.driver.send(notification);
    } catch (caught) {
      result = { error: caught instanceof Error ? caught.message : String(caught) };
    }

    if ('error' in result) {
      await manager.getRepository(Notification).update(
        { id: notification.id },
        { status: NotificationStatus.FAILED, error: result.error.slice(0, ERROR_MAX) },
      );
      return;
    }

    await manager
      .getRepository(Notification)
      .update({ id: notification.id }, { status: NotificationStatus.SENT, sentAt: result.sentAt });
  }
}
```

- [ ] **Step 6: Write `notifications.service.spec.ts`**

```typescript
// backend/src/modules/notifications/notifications.service.spec.ts
import { NotificationChannel, NotificationStatus } from '../../entities/enums';
import { NotificationsService, type QueueInput } from './notifications.service';

type DriverAnswer = { sentAt: Date } | { error: string } | (() => never);

function harness(driverAnswer: DriverAnswer) {
  const saved: Record<string, unknown>[] = [];
  const updates: { criteria: unknown; patch: Record<string, unknown> }[] = [];

  const manager = {
    getRepository: () => ({
      save: (row: Record<string, unknown>) => {
        const withId = { ...row, id: 'notif-1' };
        saved.push(withId);
        return Promise.resolve(withId);
      },
      update: (criteria: unknown, patch: Record<string, unknown>) => {
        updates.push({ criteria, patch });
        return Promise.resolve({ affected: 1 });
      },
    }),
  };

  const driver = {
    send: () =>
      typeof driverAnswer === 'function' ? driverAnswer() : Promise.resolve(driverAnswer),
  };

  const service = new NotificationsService(driver as never);
  return { service, manager, saved, updates };
}

const INPUT: QueueInput = {
  userId: 'user-1',
  channel: NotificationChannel.EMAIL,
  template: 'order.confirmed',
  payload: { orderNumber: 'NN-2026-100000' },
};

describe('NotificationsService.queue', () => {
  it('inserts a QUEUED row, then marks it SENT on a successful send', async () => {
    const sentAt = new Date('2026-08-26T00:00:00.000Z');
    const { service, manager, saved, updates } = harness({ sentAt });

    await service.queue(manager as never, INPUT);

    expect(saved).toEqual([
      {
        ...INPUT,
        status: NotificationStatus.QUEUED,
        sentAt: null,
        error: null,
        id: 'notif-1',
      },
    ]);
    expect(updates).toEqual([
      { criteria: { id: 'notif-1' }, patch: { status: NotificationStatus.SENT, sentAt } },
    ]);
  });

  it('marks the row FAILED and resolves normally when the driver reports an error', async () => {
    const { service, manager, updates } = harness({ error: 'SES is down' });

    await expect(service.queue(manager as never, INPUT)).resolves.toBeUndefined();

    expect(updates).toEqual([
      {
        criteria: { id: 'notif-1' },
        patch: { status: NotificationStatus.FAILED, error: 'SES is down' },
      },
    ]);
  });

  it('treats a driver that throws the same as a reported error, rather than rejecting', async () => {
    const { service, manager, updates } = harness(() => {
      throw new Error('network unreachable');
    });

    await expect(service.queue(manager as never, INPUT)).resolves.toBeUndefined();

    expect(updates[0]?.patch.error).toBe('network unreachable');
  });

  it('truncates an error message to fit the 300-character column', async () => {
    const long = 'x'.repeat(400);
    const { service, manager, updates } = harness({ error: long });

    await service.queue(manager as never, INPUT);

    expect((updates[0]?.patch.error as string)).toHaveLength(300);
  });

  it('handles a driver that throws something other than an Error', async () => {
    const { service, manager, updates } = harness(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'a plain string, not an Error';
    });

    await service.queue(manager as never, INPUT);

    expect(updates[0]?.patch.error).toBe('a plain string, not an Error');
  });
});
```

- [ ] **Step 7: Write `notifications.module.ts`**

```typescript
// backend/src/modules/notifications/notifications.module.ts
import { Module } from '@nestjs/common';
import { LoggingModule } from '../../common/logging/logging.module';
import { LoggingNotificationDriver } from './logging-notification.driver';
import { NOTIFICATION_DRIVER } from './notification-driver';
import { NotificationsService } from './notifications.service';

/**
 * No `TypeOrmModule.forFeature` here — `RfqsModule`'s own reasoning applies verbatim:
 * `NotificationsService` takes no repository of its own, and `queue()`'s `manager` is always the
 * caller's own open transaction, through which `Notification` is reached.
 *
 * `LoggingModule` is `@Global()`, so `LoggingNotificationDriver`'s `WinstonLoggerService`
 * dependency would resolve either way; imported explicitly regardless, matching
 * `SessionsModule`'s own documented reason: `@Global()` is about registration, not about which
 * imports state what a module actually depends on.
 */
@Module({
  imports: [LoggingModule],
  providers: [
    NotificationsService,
    { provide: NOTIFICATION_DRIVER, useClass: LoggingNotificationDriver },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
```

- [ ] **Step 8: Register `NotificationsModule` in `AppModule`**

In `backend/src/app.module.ts`, add the import alphabetically between `InventoryModule` and `OrdersModule`:

```typescript
import { NotificationsModule } from './modules/notifications/notifications.module';
```

And in the `imports` array, add `NotificationsModule` between `InventoryModule` and `OrdersModule`:

```typescript
    InventoryModule,
    NotificationsModule,
    OrdersModule,
```

- [ ] **Step 9: Run the unit specs**

Run: `cd backend && npx jest notifications`
Expected: `logging-notification.driver.spec.ts` and `notifications.service.spec.ts` both pass, 7 tests total.

- [ ] **Step 10: Write `notifications.integration.spec.ts`**

```typescript
// backend/test/integration/notifications.integration.spec.ts
import { NotificationChannel, NotificationStatus } from '../../src/entities/enums';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { useIntegrationApp } from './helpers';

interface NotificationRow {
  user_id: string | null;
  channel: string;
  template: string;
  payload: Record<string, unknown>;
  status: string;
  sentAt: Date | null;
  error: string | null;
}

/**
 * `NotificationsService`'s only real-database claim: that `queue()` writes and updates one row
 * inside whatever transaction it is handed, and that a caller's rollback takes the row with it.
 * Everything about the driver contract and the FAILED path is `notifications.service.spec.ts`'s
 * to prove with a double — nothing here needs a real provider, because this milestone ships none.
 */
describe('NotificationsService.queue, against real Postgres', () => {
  const integration = useIntegrationApp();

  const rowsFor = (template: string): Promise<NotificationRow[]> =>
    integration.dataSource.query<NotificationRow[]>(
      `SELECT user_id, channel::text AS channel, template, payload, status::text AS status,
              "sentAt", error
         FROM notifications WHERE template = $1`,
      [template],
    );

  it('writes a QUEUED row, then SENT with a timestamp, in one call', async () => {
    const notifications = integration.app.get(NotificationsService);

    await integration.dataSource.transaction((manager) =>
      notifications.queue(manager, {
        userId: null,
        channel: NotificationChannel.EMAIL,
        template: 'test.round-trip',
        payload: { hello: 'world' },
      }),
    );

    const [row] = await rowsFor('test.round-trip');
    expect(row).toMatchObject({
      user_id: null,
      channel: 'EMAIL',
      template: 'test.round-trip',
      payload: { hello: 'world' },
      status: NotificationStatus.SENT,
    });
    expect(row?.sentAt).toBeInstanceOf(Date);
    expect(row?.error).toBeNull();
  });

  it('never leaves a row behind for a transaction that rolled back', async () => {
    const notifications = integration.app.get(NotificationsService);

    await expect(
      integration.dataSource.transaction(async (manager) => {
        await notifications.queue(manager, {
          userId: null,
          channel: NotificationChannel.EMAIL,
          template: 'test.rolled-back',
          payload: {},
        });
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    expect(await rowsFor('test.rolled-back')).toEqual([]);
  });
});
```

- [ ] **Step 11: Run the integration suite**

Run: `npm run test:integration -w backend`
Expected: all suites pass, including the two new tests in `notifications.integration.spec.ts`.

- [ ] **Step 12: Typecheck, lint, format**

Run: `npm run typecheck -w backend && npm run lint -w backend && npm run format:check -w backend`
Expected: all clean.

- [ ] **Step 13: Commit**

```bash
git add backend/src/modules/notifications backend/src/app.module.ts \
  backend/test/integration/notifications.integration.spec.ts
git commit -m "feat(notifications): the queue, the logging driver, and the one write path"
```

---

### Task 3: Backend — RfqStatusService

**Files:**
- Create: `backend/src/modules/rfqs/rfq-status.service.ts`
- Create: `backend/src/modules/rfqs/rfq-status.service.spec.ts`
- Modify: `backend/src/modules/rfqs/rfqs.module.ts`
- Create: `backend/test/integration/rfq-status.integration.spec.ts`

- [ ] **Step 1: Write `rfq-status.service.ts`**

```typescript
// backend/src/modules/rfqs/rfq-status.service.ts
import { HttpStatus, Injectable } from '@nestjs/common';
import { canTransitionRfq, nextRfqStatuses, type RfqStatus } from '@nutwala/shared';
import { DataSource } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Rfq } from '../../entities/b2b/rfq.entity';
import { NotificationChannel } from '../../entities/enums';
import { NotificationsService } from '../notifications/notifications.service';

export interface RfqTransitionResult {
  rfqId: string;
  rfqNumber: string;
  from: RfqStatus;
  to: RfqStatus;
}

/**
 * The one server-side owner of "which RFQ status changes are legal" — `OrderStatusService`'s
 * sibling, at a fraction of the size. An RFQ has no stock consequence and no timeline table (no
 * `RfqEvent` exists), so a legal transition is a status write and a queued notification, and
 * nothing else.
 *
 * **No `options` parameter.** `OrderStatusService.transition`'s `options` carries `note` and
 * `restock` — somewhere to attach free text to the timeline, and a judgement about stock. Neither
 * has anywhere to land here: there is no timeline row to carry a note on, and no stock to make a
 * judgement about. An empty options bag on the chance Milestone 9's admin console eventually
 * wants one is exactly the kind of placeholder this plan avoids adding; it can be added the day
 * something real needs it.
 *
 * **No controller in this repository.** Brief §7.1 puts the admin console in a separate
 * application and repository; this service is exported from `RfqsModule` for that repository's
 * own plan to wire up, the same position `OrderStatusService` was in before Task 17 of the B2B
 * plan gave it a route. Unit- and integration-tested by calling it directly.
 */
@Injectable()
export class RfqStatusService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  async transition(rfqNumber: string, to: RfqStatus): Promise<RfqTransitionResult> {
    return this.dataSource.transaction(async (manager) => {
      const rfq = await manager.getRepository(Rfq).findOne({ where: { rfqNumber } });

      if (!rfq) {
        throw new DomainError(ErrorCodes.NOT_FOUND, `No RFQ ${rfqNumber}.`, HttpStatus.NOT_FOUND, {
          rfqNumber,
        });
      }

      // `ck_rfqs_status` guarantees the column holds one of the seven values, so the cast is a
      // claim the database already enforces — `OrderStatusService.transition`'s identical cast
      // of `order.status` states the same reasoning.
      const from = rfq.status as RfqStatus;

      if (!canTransitionRfq(from, to)) {
        throw new DomainError(
          ErrorCodes.ILLEGAL_STATUS_TRANSITION,
          `An RFQ that is "${from}" cannot become "${to}".`,
          HttpStatus.UNPROCESSABLE_ENTITY,
          { rfqNumber, from, to, allowed: nextRfqStatuses(from) },
        );
      }

      /**
       * Guarded on the status just read, the same reasoning `OrderStatusService.transition`
       * states in full: two admins moving the same RFQ at once both read `from`, both pass
       * `canTransitionRfq`, and the second `UPDATE` re-checks its own `WHERE` against the row the
       * first one committed and matches nothing — reporting a conflict rather than silently
       * overwriting or appending a duplicate.
       */
      const moved = await manager
        .getRepository(Rfq)
        .update({ id: rfq.id, status: from }, { status: to });

      if (moved.affected !== 1) {
        throw new DomainError(
          ErrorCodes.ILLEGAL_STATUS_TRANSITION,
          `RFQ ${rfqNumber} is no longer "${from}". Reload it and try again.`,
          HttpStatus.CONFLICT,
          { rfqNumber, from, to },
        );
      }

      await this.notifications.queue(manager, {
        userId: rfq.userId,
        channel: NotificationChannel.EMAIL,
        template: 'rfq.status-changed',
        payload: { rfqNumber, from, to },
      });

      return { rfqId: rfq.id, rfqNumber: rfq.rfqNumber, from, to };
    });
  }
}
```

- [ ] **Step 2: Write `rfq-status.service.spec.ts`**

```typescript
// backend/src/modules/rfqs/rfq-status.service.spec.ts
import { HttpStatus } from '@nestjs/common';
import { RfqStatusService } from './rfq-status.service';

const RFQ_NUMBER = 'RFQ-2026-100000';

interface RfqPatch {
  status?: string;
}

function harness(rfq: { status: string; userId?: string | null; updateAffected?: number }) {
  const recorded: { queued: unknown[]; patch: RfqPatch | null } = { queued: [], patch: null };

  const manager = {
    getRepository: () => ({
      findOne: (options: { where?: { rfqNumber?: string } }) =>
        Promise.resolve(
          options.where?.rfqNumber === RFQ_NUMBER
            ? { id: 'rfq-1', rfqNumber: RFQ_NUMBER, status: rfq.status, userId: rfq.userId ?? null }
            : null,
        ),
      update: (_criteria: unknown, patch: RfqPatch) => {
        recorded.patch = patch;
        return Promise.resolve({ affected: rfq.updateAffected ?? 1 });
      },
    }),
  };

  const dataSource = { transaction: <T>(run: (m: unknown) => Promise<T>) => run(manager) };
  const notifications = {
    queue: (_manager: unknown, input: unknown) => {
      recorded.queued.push(input);
      return Promise.resolve();
    },
  };

  return { service: new RfqStatusService(dataSource as never, notifications as never), recorded };
}

describe('RfqStatusService.transition', () => {
  it('moves a new RFQ to contacted and queues rfq.status-changed', async () => {
    const { service, recorded } = harness({ status: 'new', userId: 'user-1' });

    const result = await service.transition(RFQ_NUMBER, 'contacted');

    expect(result).toEqual({ rfqId: 'rfq-1', rfqNumber: RFQ_NUMBER, from: 'new', to: 'contacted' });
    expect(recorded.patch).toEqual({ status: 'contacted' });
    expect(recorded.queued).toEqual([
      {
        userId: 'user-1',
        channel: 'EMAIL',
        template: 'rfq.status-changed',
        payload: { rfqNumber: RFQ_NUMBER, from: 'new', to: 'contacted' },
      },
    ]);
  });

  it('carries a null userId through to the notification for a prospect with no account', async () => {
    const { service, recorded } = harness({ status: 'new', userId: null });

    await service.transition(RFQ_NUMBER, 'rejected');

    expect(recorded.queued).toEqual([
      expect.objectContaining({ userId: null }),
    ]);
  });

  it('refuses an illegal transition with 422, and queues nothing', async () => {
    const { service, recorded } = harness({ status: 'new' });

    await expect(service.transition(RFQ_NUMBER, 'approved')).rejects.toMatchObject({
      code: 'ILLEGAL_STATUS_TRANSITION',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
    expect(recorded.queued).toEqual([]);
    expect(recorded.patch).toBeNull();
  });

  it('names the statuses that were available instead', async () => {
    const { service } = harness({ status: 'quote-sent' });

    const error = await service.transition(RFQ_NUMBER, 'new').catch((thrown: unknown) => thrown);

    expect((error as { details?: unknown }).details).toEqual({
      rfqNumber: RFQ_NUMBER,
      from: 'quote-sent',
      to: 'new',
      allowed: ['negotiation', 'approved', 'rejected'],
    });
  });

  it('refuses a terminal RFQ moving anywhere at all', async () => {
    const { service } = harness({ status: 'converted' });

    await expect(service.transition(RFQ_NUMBER, 'contacted')).rejects.toMatchObject({
      code: 'ILLEGAL_STATUS_TRANSITION',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
  });

  it('refuses a no-op transition to the status the RFQ already holds', async () => {
    const { service } = harness({ status: 'contacted' });

    await expect(service.transition(RFQ_NUMBER, 'contacted')).rejects.toMatchObject({
      code: 'ILLEGAL_STATUS_TRANSITION',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
  });

  it('answers 404 for an rfqNumber it does not recognise', async () => {
    const { service } = harness({ status: 'new' });

    await expect(service.transition('RFQ-2026-999999', 'contacted')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: HttpStatus.NOT_FOUND,
    });
  });

  it('answers 409 when the row moved under the caller between the read and the write', async () => {
    const { service } = harness({ status: 'new', updateAffected: 0 });

    await expect(service.transition(RFQ_NUMBER, 'contacted')).rejects.toMatchObject({
      code: 'ILLEGAL_STATUS_TRANSITION',
      status: HttpStatus.CONFLICT,
    });
  });
});
```

- [ ] **Step 3: Wire `RfqStatusService` into `RfqsModule`**

Rewrite `backend/src/modules/rfqs/rfqs.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { RfqsController } from './rfqs.controller';
import { RfqStatusService } from './rfq-status.service';
import { RfqsService } from './rfqs.service';

/**
 * No `TypeOrmModule.forFeature` here — `RfqsService` and `RfqStatusService` both take the
 * `DataSource` and reach `Rfq`/`Product` through one transaction's `EntityManager`, the same
 * arrangement `CheckoutService` uses. `DataSource` is a globally-provided token from the root
 * `TypeOrmModule.forRootAsync` in `AppModule`, so nothing here needs to ask for it either.
 *
 * `NotificationsModule` is imported for both services' sake: `RfqsService.create` queues
 * `rfq.received` (Task 8 of this plan) and `RfqStatusService.transition` queues
 * `rfq.status-changed` on every legal move.
 *
 * **`RfqStatusService` is exported, and that export is the point of this line existing.**
 * §7.1 puts the admin console in a separate application and repository, and its status screens
 * are the only thing that will transition an RFQ. Exported, that repository's own plan wires
 * those screens to this implementation — the single server-side consumer of `@nutwala/shared`'s
 * `RFQ_TRANSITIONS`. `RfqsService` stays unexported: nothing outside this module reads or writes
 * an RFQ through it today.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [RfqsController],
  providers: [RfqsService, RfqStatusService],
  exports: [RfqStatusService],
})
export class RfqsModule {}
```

- [ ] **Step 4: Run the unit specs**

Run: `cd backend && npx jest rfq-status.service.spec.ts rfqs.module.spec.ts`
Expected: `rfq-status.service.spec.ts` passes (8 tests); `rfqs.module.spec.ts` still passes unmodified (the module still compiles and `RfqsController` is still registered).

- [ ] **Step 5: Write `rfq-status.integration.spec.ts`**

```typescript
// backend/test/integration/rfq-status.integration.spec.ts
import { HttpStatus } from '@nestjs/common';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { RfqKind } from '../../src/entities/enums';
import { RfqStatusService } from '../../src/modules/rfqs/rfq-status.service';
import { RfqsService } from '../../src/modules/rfqs/rfqs.service';
import { useIntegrationApp } from './helpers';

/**
 * `RfqStatusService` has no controller in this repository, so — like
 * `checkout-concurrency.integration.spec.ts` does for `CheckoutService` — it is reached directly
 * off the DI container rather than through an HTTP route.
 */
describe('RfqStatusService.transition, against real Postgres', () => {
  const integration = useIntegrationApp();

  beforeEach(async () => {
    await seedSettings(integration.dataSource);
    await seedCatalog(integration.dataSource);
  });

  const freshRfq = () =>
    integration.app.get(RfqsService).create(
      {
        kind: RfqKind.BULK,
        businessName: 'Crumb & Co Bakery',
        contactPerson: 'Priya Menon',
        mobile: '9820098200',
        email: 'priya@crumbandco.example',
        businessType: 'Bakery',
        pincode: '400050',
        lines: [{ productSlug: 'premium-california-almonds', kg: 60 }],
        packaging: 'Vacuum packs (5 kg)',
        frequency: 'Fortnightly',
      },
      null,
    );

  // Filtered by template as well as by rfqNumber, deliberately: `RfqsService.create` queuing
  // `rfq.received` is Task 8's own concern to prove, and this file must not become order-
  // dependent on that task having already run.
  const statusChangedNotifications = (rfqNumber: string) =>
    integration.dataSource.query<{ payload: Record<string, unknown> }[]>(
      `SELECT payload FROM notifications
        WHERE template = 'rfq.status-changed' AND payload->>'rfqNumber' = $1`,
      [rfqNumber],
    );

  it('moves a legal transition and queues rfq.status-changed', async () => {
    const rfq = await freshRfq();
    const statuses = integration.app.get(RfqStatusService);

    const result = await statuses.transition(rfq.rfqNumber, 'contacted');

    expect(result).toEqual({
      rfqId: rfq.id,
      rfqNumber: rfq.rfqNumber,
      from: 'new',
      to: 'contacted',
    });
    const rows = await statusChangedNotifications(rfq.rfqNumber);
    expect(rows).toEqual([
      { payload: { rfqNumber: rfq.rfqNumber, from: 'new', to: 'contacted' } },
    ]);
  });

  it('refuses an illegal transition with 422 and moves nothing', async () => {
    const rfq = await freshRfq();
    const statuses = integration.app.get(RfqStatusService);

    await expect(statuses.transition(rfq.rfqNumber, 'approved')).rejects.toMatchObject({
      code: 'ILLEGAL_STATUS_TRANSITION',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });

    const [row] = await integration.dataSource.query<{ status: string }[]>(
      'SELECT status FROM rfqs WHERE "rfqNumber" = $1',
      [rfq.rfqNumber],
    );
    expect(row?.status).toBe('new');
    expect(await statusChangedNotifications(rfq.rfqNumber)).toEqual([]);
  });

  it('answers 404 for an unknown rfqNumber', async () => {
    const statuses = integration.app.get(RfqStatusService);

    await expect(statuses.transition('RFQ-2026-999999', 'contacted')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: HttpStatus.NOT_FOUND,
    });
  });

  it('carries a full pipeline through to converted', async () => {
    const rfq = await freshRfq();
    const statuses = integration.app.get(RfqStatusService);

    await statuses.transition(rfq.rfqNumber, 'contacted');
    await statuses.transition(rfq.rfqNumber, 'quote-sent');
    await statuses.transition(rfq.rfqNumber, 'approved');
    const final = await statuses.transition(rfq.rfqNumber, 'converted');

    expect(final.to).toBe('converted');
    const [row] = await integration.dataSource.query<{ status: string }[]>(
      'SELECT status FROM rfqs WHERE "rfqNumber" = $1',
      [rfq.rfqNumber],
    );
    expect(row?.status).toBe('converted');
    expect(await statusChangedNotifications(rfq.rfqNumber)).toHaveLength(4);
  });
});
```

- [ ] **Step 6: Run the integration suite twice**

Run: `npm run test:integration -w backend` (twice, back to back)
Expected: all suites pass both times, including the four new tests.

- [ ] **Step 7: Typecheck, lint, format**

Run: `npm run typecheck -w backend && npm run lint -w backend && npm run format:check -w backend`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules/rfqs backend/test/integration/rfq-status.integration.spec.ts
git commit -m "feat(rfqs): RfqStatusService, exported for Milestone 9's admin console"
```

---

### Task 4: Backend — the `checkLowStock` helper

**Files:**
- Create: `backend/src/modules/inventory/check-low-stock.ts`
- Create: `backend/src/modules/inventory/check-low-stock.spec.ts`

- [ ] **Step 1: Write `check-low-stock.ts`**

```typescript
// backend/src/modules/inventory/check-low-stock.ts
import type { EntityManager } from 'typeorm';
import { NotificationChannel } from '../../entities/enums';
import type { NotificationsService } from '../notifications/notifications.service';

export interface CheckLowStockInput {
  variantId: string;
  /** Signed — negative for a decrement, positive for a restock or an upward adjustment. */
  delta: number;
  /** The value the write that called this just produced. */
  onHand: number;
  lowStockThreshold: number;
}

/**
 * Queues `stock.low` exactly once per crossing, never once per read.
 *
 * "Crossing" means the write itself took the row from *at or above* `lowStockThreshold` to
 * *below* it — `previous >= threshold && onHand < threshold`. `previous` is computed as
 * `onHand - delta` rather than read separately, because every call site (`InventoryService.adjust`,
 * `CheckoutService`'s decrement, `OrderStatusService.putStockBack`) already has both values from
 * the write it just performed — no extra read is needed. Three consequences fall out of the one
 * formula rather than each needing its own branch:
 *
 * - a row already below the threshold that drops further (an already-low variant losing more
 *   stock) does not re-notify, because `previous` is below the threshold too;
 * - a restock that lands back above the threshold does not notify either, because `onHand` is
 *   not below it;
 * - landing exactly *on* the threshold is not "low" — `onHand < threshold` is strict, so the
 *   notification fires one unit later than the row that merely equals the threshold.
 */
export async function checkLowStock(
  manager: EntityManager,
  notifications: NotificationsService,
  input: CheckLowStockInput,
): Promise<void> {
  const previous = input.onHand - input.delta;
  const crossedDown = previous >= input.lowStockThreshold && input.onHand < input.lowStockThreshold;
  if (!crossedDown) return;

  await notifications.queue(manager, {
    userId: null,
    channel: NotificationChannel.EMAIL,
    template: 'stock.low',
    payload: {
      variantId: input.variantId,
      onHand: input.onHand,
      lowStockThreshold: input.lowStockThreshold,
    },
  });
}
```

- [ ] **Step 2: Write `check-low-stock.spec.ts`**

```typescript
// backend/src/modules/inventory/check-low-stock.spec.ts
import { NotificationChannel } from '../../entities/enums';
import { checkLowStock } from './check-low-stock';

function harness() {
  const queued: unknown[] = [];
  const notifications = {
    queue: (_manager: unknown, input: unknown) => {
      queued.push(input);
      return Promise.resolve();
    },
  };
  return { notifications, queued };
}

describe('checkLowStock', () => {
  it('queues stock.low when the write crosses from at-or-above to below the threshold', async () => {
    const { notifications, queued } = harness();

    await checkLowStock({} as never, notifications as never, {
      variantId: 'var-1',
      delta: -7,
      onHand: 8,
      lowStockThreshold: 10,
    });

    expect(queued).toEqual([
      {
        userId: null,
        channel: NotificationChannel.EMAIL,
        template: 'stock.low',
        payload: { variantId: 'var-1', onHand: 8, lowStockThreshold: 10 },
      },
    ]);
  });

  it('does not notify when the row was already below the threshold', async () => {
    const { notifications, queued } = harness();

    await checkLowStock({} as never, notifications as never, {
      variantId: 'var-1',
      delta: -3,
      onHand: 5,
      lowStockThreshold: 10,
    });

    expect(queued).toEqual([]);
  });

  it('does not notify when a restock lands back above the threshold', async () => {
    const { notifications, queued } = harness();

    await checkLowStock({} as never, notifications as never, {
      variantId: 'var-1',
      delta: 10,
      onHand: 15,
      lowStockThreshold: 10,
    });

    expect(queued).toEqual([]);
  });

  it('does not treat landing exactly on the threshold as low', async () => {
    const { notifications, queued } = harness();

    await checkLowStock({} as never, notifications as never, {
      variantId: 'var-1',
      delta: -1,
      onHand: 10,
      lowStockThreshold: 10,
    });

    expect(queued).toEqual([]);
  });

  it('notifies on the exact step that drops one unit below the threshold', async () => {
    const { notifications, queued } = harness();

    await checkLowStock({} as never, notifications as never, {
      variantId: 'var-1',
      delta: -1,
      onHand: 9,
      lowStockThreshold: 10,
    });

    expect(queued).toHaveLength(1);
  });

  it('never fires from a positive delta that started below the threshold too', async () => {
    const { notifications, queued } = harness();

    await checkLowStock({} as never, notifications as never, {
      variantId: 'var-1',
      delta: 2,
      onHand: 4,
      lowStockThreshold: 10,
    });

    expect(queued).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the spec**

Run: `cd backend && npx jest check-low-stock.spec.ts`
Expected: 6 passed.

- [ ] **Step 4: Typecheck, lint, format**

Run: `npm run typecheck -w backend && npm run lint -w backend && npm run format:check -w backend`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/inventory/check-low-stock.ts backend/src/modules/inventory/check-low-stock.spec.ts
git commit -m "feat(inventory): checkLowStock — one crossing, one notification"
```

---

### Task 5: Backend — Checkout: order confirmation and the low-stock hook

**Files:**
- Modify: `backend/src/modules/checkout/checkout.service.ts`
- Modify: `backend/src/modules/checkout/checkout.service.spec.ts`
- Modify: `backend/src/modules/checkout/checkout.module.ts`
- Modify: `backend/test/integration/checkout.integration.spec.ts`

- [ ] **Step 1: Inject `NotificationsService` into `CheckoutService`**

In `backend/src/modules/checkout/checkout.service.ts`, add the import:

```typescript
import { toRupees } from '@nutwala/shared';
```

(add it to the existing `@nutwala/shared` import block, alongside `applyFlat`, `gstOn`, etc.)

```typescript
import { checkLowStock } from '../inventory/check-low-stock';
import { NotificationChannel } from '../../entities/enums';
import { NotificationsService } from '../notifications/notifications.service';
```

(`InventoryTransactionType`, `OrderChannelEnum`, `PaymentMethodEnum` and `PaymentStatusEnum` already share one destructured import line from `../../entities/enums` — add `NotificationChannel` to that existing line rather than a second import statement.)

Add the new constructor parameter, after `settings`:

```typescript
  constructor(
    private readonly dataSource: DataSource,
    private readonly cart: CartService,
    private readonly cartRead: CartReadService,
    private readonly pricing: CartPricingService,
    private readonly pincodes: PincodeService,
    private readonly coupons: CouponService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}
```

- [ ] **Step 2: Queue `order.confirmed` right before `place` commits**

Immediately before the final `return order;` in `place` — i.e. right after the existing `await manager.getRepository(CartItem).delete({ cartId: cart.id });` line and its docblock — add:

```typescript
      /**
       * Queued **last, inside the same transaction**, mirroring why the basket is emptied last:
       * a placement that fails after this point does not exist, so nothing should have been
       * queued for it either. `totalPaise` is converted with `toRupees` before it reaches the
       * payload, not left as a `bigint` — Postgres's driver can `JSON.stringify` a `jsonb` column
       * fine, but a raw `BigInt` inside that payload throws `TypeError: Do not know how to
       * serialize a BigInt` first, since `bigint` has no native JSON representation. This is the
       * one call site in this milestone with money in its payload; every other trigger's payload
       * carries only strings, ids, and plain small integers.
       */
      await this.notifications.queue(manager, {
        userId: order.userId,
        channel: NotificationChannel.EMAIL,
        template: 'order.confirmed',
        payload: {
          orderNumber: order.orderNumber,
          email: dto.shipping.email,
          totalRupees: toRupees(order.totalPaise),
        },
      });

      return order;
```

- [ ] **Step 3: Call `checkLowStock` after each decrement in `sell`**

In the `sell` method's SQL, add `"lowStockThreshold"` to both the `RETURNING` clause and the outer `SELECT`:

```typescript
  private async sell(
    manager: EntityManager,
    input: { orderId: string; orderNumber: string; variantId: string; qty: number },
  ): Promise<void> {
    const rows = await manager.query<{ onHand: number; lowStockThreshold: number }[]>(
      `WITH sold AS (
         UPDATE "inventory"
            SET "onHand" = "onHand" - $1, "updatedAt" = now()
          WHERE "variant_id" = $2
            AND "onHand" - $1 >= "reserved"
        RETURNING "onHand", "lowStockThreshold"
       )
       SELECT "onHand", "lowStockThreshold" FROM sold`,
      [input.qty, input.variantId],
    );

    const onHand = rows[0]?.onHand;
    const lowStockThreshold = rows[0]?.lowStockThreshold;

    if (onHand === undefined) {
      throw new DomainError(
        ErrorCodes.OUT_OF_STOCK,
        'One of your items sold out while you were checking out. Review your basket and try again.',
        HttpStatus.CONFLICT,
        { variantId: input.variantId, qty: input.qty },
      );
    }

    await manager.getRepository(InventoryTransaction).insert({
      variantId: input.variantId,
      delta: -input.qty,
      type: InventoryTransactionType.SALE,
      reason: `Order ${input.orderNumber}`,
      orderId: input.orderId,
      actorUserId: null,
      balanceAfter: Number(onHand),
    });

    await checkLowStock(manager, this.notifications, {
      variantId: input.variantId,
      delta: -input.qty,
      onHand: Number(onHand),
      lowStockThreshold: Number(lowStockThreshold),
    });
  }
```

(Only the type parameter, the two `RETURNING`/`SELECT` clauses, the `lowStockThreshold` read, and the new `checkLowStock` call at the end are new — the rest of the method, including its long docblock about the data-modifying CTE, is unchanged and stays exactly where it is.)

- [ ] **Step 4: Update `checkout.module.ts`**

In `backend/src/modules/checkout/checkout.module.ts`, add the import:

```typescript
import { NotificationsModule } from '../notifications/notifications.module';
```

And add it to `imports`:

```typescript
  imports: [
    TypeOrmModule.forFeature([Coupon, CouponRedemption, Order, ServiceablePincode, IdempotencyKey]),
    CartModule,
    SettingsModule,
    NotificationsModule,
  ],
```

- [ ] **Step 5: Update `checkout.service.spec.ts`'s harness**

In `backend/src/modules/checkout/checkout.service.spec.ts`, the harness's options type declares `stockRows?: { onHand: number }[][]`. Widen the element type to carry the threshold too:

```typescript
  stockRows?: { onHand: number; lowStockThreshold?: number }[][];
```

Find the `manager.query`'s inventory branch, which currently reads:

```typescript
        const answer = options.stockRows?.[stockCall] ?? [{ onHand: 100 }];
```

and give the default row a threshold as well, chosen far below 100 so no pre-existing test's quantities cross it and start asserting on `checkLowStock`'s behaviour by accident:

```typescript
        const answer = options.stockRows?.[stockCall] ?? [{ onHand: 100, lowStockThreshold: 10 }];
```

(Every existing test that passes its own `stockRows` — e.g. the ledger test's `stockRows: [[{ onHand: 118 }], [{ onHand: 39 }]]` — still works unmodified: `lowStockThreshold` is now optional on the element type, and `checkLowStock` reading `undefined` there produces `input.onHand < undefined`, which is always `false`, so those tests silently never cross a threshold. That is correct — they are not testing low stock and must not start asserting on it by accident.)

Add a `queued: unknown[]` field to the `Recorded` interface (alongside `sequenceReads: number;`), initialise it to `[]` wherever `recorded` is constructed, then add a `notifications` fake and thread it into the constructor call:

```typescript
  const notifications = {
    queue: (_manager: unknown, input: unknown) => {
      recorded.queued.push(input);
      return Promise.resolve();
    },
  };

  const service = new CheckoutService(
    { transaction: <T>(run: (m: unknown) => Promise<T>) => run(manager) } as never,
    cartService as never,
    cartRead,
    new CartPricingService(),
    pincodes as never,
    coupons as never,
    settingsService as never,
    notifications as never,
  );

  return { service, recorded, cartService, cartRead, pincodes, coupons, manager, settingsService, notifications };
```

- [ ] **Step 6: Add a unit test proving the queue call**

In `checkout.service.spec.ts`, add a new test to `describe('CheckoutService.place — what the transaction writes', ...)`, alongside its existing `'writes exactly one pending OrderEvent, unattributed'` test — this file's module-scoped `OWNER` (`{ userId: 'user-1' }`) and `DTO` (`PlaceOrderDto` built from `SHIPPING_ADDRESS`) fixtures are exactly what every other test in that block already calls `service.place` with:

```typescript
  it('queues order.confirmed with the order number, the shipping email and the rupee total', async () => {
    const { service, recorded } = harness({});

    await service.place(OWNER, DTO, undefined);

    expect(recorded.queued).toEqual([
      expect.objectContaining({
        userId: 'user-1',
        channel: 'EMAIL',
        template: 'order.confirmed',
        payload: {
          orderNumber: `NN-${new Date().getFullYear()}-000017`,
          email: SHIPPING_ADDRESS.email,
          totalRupees: expect.any(Number),
        },
      }),
    ]);
  });
```

(`NN-${new Date().getFullYear()}-000017` is this file's own established convention for the order number the harness's `nextval: '17'` fake produces — the `'allocates the order number from the sequence'` test a few lines above asserts the identical string.)

- [ ] **Step 7: Run the unit spec**

Run: `cd backend && npx jest checkout.service.spec.ts`
Expected: every existing test in the file still passes (proving the `lowStockThreshold: 10` addition did not change any existing assertion), plus the new test.

- [ ] **Step 8: Add integration tests**

In `backend/test/integration/checkout.integration.spec.ts`, add a `notificationsFor` helper near the file's other `countRows`/`countOrders` helpers:

```typescript
  const notificationsFor = (template: string, orderNumber: string) =>
    integration.dataSource.query<{ user_id: string | null; payload: Record<string, unknown> }[]>(
      `SELECT user_id, payload FROM notifications
        WHERE template = $1 AND payload->>'orderNumber' = $2`,
      [template, orderNumber],
    );
```

Add a new test inside `describe('placement, happy path', ...)`:

```typescript
    it('queues order.confirmed with the order number, the shipping email and the rupee total', async () => {
      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds, cashews]);

      const response = await place(client, csrf).expect(HttpStatus.CREATED);
      const order = expectSuccess<AccountOrder>(response);

      const rows = await notificationsFor('order.confirmed', order.id);
      expect(rows).toEqual([
        {
          user_id: expect.any(String),
          payload: {
            orderNumber: order.id,
            email: shipping().email,
            totalRupees: order.total,
          },
        },
      ]);
    });
```

Add a second test proving the low-stock crossing, near the existing stock-decrement test (`'empties the basket, decrements exactly what was ordered...'`):

```typescript
    it('queues stock.low when a placement takes a variant across its threshold', async () => {
      const [{ id: variantId, lowStockThreshold }] = await integration.dataSource.query<
        { id: string; lowStockThreshold: number }[]
      >(
        `SELECT v.id, i."lowStockThreshold"
           FROM product_variants v
           JOIN products p ON p.id = v.product_id
           JOIN inventory i ON i.variant_id = v.id
          WHERE p.slug = $1 AND v.size = $2`,
        ['premium-california-almonds', '250g'],
      );

      // `almonds` (this file's own fixture) orders 2 packs. Drive onHand to
      // `lowStockThreshold + 1` first, so that placement is the exact decrement that crosses it.
      await integration.dataSource.query(
        'UPDATE inventory SET "onHand" = $1 WHERE variant_id = $2',
        [lowStockThreshold + 1, variantId],
      );

      const { client, csrf } = await signedIn();
      await putCart(client, csrf, [almonds]);
      await place(client, csrf).expect(HttpStatus.CREATED);

      const rows = await integration.dataSource.query<{ payload: Record<string, unknown> }[]>(
        `SELECT payload FROM notifications WHERE template = 'stock.low' AND payload->>'variantId' = $1`,
        [variantId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toMatchObject({ variantId, onHand: lowStockThreshold - 1 });
    });
```

- [ ] **Step 9: Run the integration suite twice**

Run: `npm run test:integration -w backend` (twice, back to back)
Expected: all suites pass both times.

- [ ] **Step 10: Typecheck, lint, format**

Run: `npm run typecheck -w backend && npm run lint -w backend && npm run format:check -w backend`
Expected: all clean.

- [ ] **Step 11: Commit**

```bash
git add backend/src/modules/checkout backend/test/integration/checkout.integration.spec.ts
git commit -m "feat(checkout): order.confirmed on placement, stock.low on the crossing decrement"
```

---

### Task 6: Backend — OrderStatusService: shipped/delivered and the low-stock hook

**Files:**
- Modify: `backend/src/modules/orders/order-status.service.ts`
- Modify: `backend/src/modules/orders/order-status.service.spec.ts`
- Modify: `backend/src/modules/orders/orders.module.ts`
- Modify: `backend/test/integration/orders.integration.spec.ts`

- [ ] **Step 1: Inject `NotificationsService` into `OrderStatusService`**

Add imports:

```typescript
import { checkLowStock } from '../inventory/check-low-stock';
import { NotificationsService } from '../notifications/notifications.service';
```

(`InventoryTransactionType` and `OrderChannelEnum` already share one destructured import line from `../../entities/enums` — add `NotificationChannel` to that existing line rather than a second import statement.)

Change the constructor:

```typescript
  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}
```

- [ ] **Step 2: Queue `order.shipped`/`order.delivered` in `transition`**

Immediately before `return { orderId: order.id, orderNumber: order.orderNumber, from, to, restored };` in `transition`, add:

```typescript
      /**
       * The one addition `transition` gains this milestone, and the only two `to` values it
       * fires for. Brief §38 names "order shipped" and "order delivered" as two of its eight
       * triggers; every other forward step (`confirmed`, `processing`, `packed`,
       * `out-for-delivery`) is an operational state change with nothing a customer is waiting to
       * hear, so this does not fire unconditionally the way `RfqStatusService.transition` does —
       * an RFQ's every step *is* the point of the pipeline, an order's is not.
       */
      if (to === 'shipped' || to === 'delivered') {
        await this.notifications.queue(manager, {
          userId: order.userId,
          channel: NotificationChannel.EMAIL,
          template: to === 'shipped' ? 'order.shipped' : 'order.delivered',
          payload: { orderNumber: order.orderNumber, status: to },
        });
      }

      return { orderId: order.id, orderNumber: order.orderNumber, from, to, restored };
```

- [ ] **Step 3: Call `checkLowStock` after each restore in `putStockBack`**

Add `"lowStockThreshold"` to both the `RETURNING` clause and the outer `SELECT`, and read it back:

```typescript
  private async putStockBack(
    manager: EntityManager,
    input: {
      orderId: string;
      variantId: string;
      qty: number;
      type: InventoryTransactionType;
      reason: string;
      actorUserId: string | null;
    },
  ): Promise<void> {
    const rows = await manager.query<{ onHand: number; lowStockThreshold: number }[]>(
      `WITH restored AS (
         UPDATE "inventory"
            SET "onHand" = "onHand" + $1, "updatedAt" = now()
          WHERE "variant_id" = $2
            AND "onHand" + $1 >= "reserved"
        RETURNING "onHand", "lowStockThreshold"
       )
       SELECT "onHand", "lowStockThreshold" FROM restored`,
      [input.qty, input.variantId],
    );

    const onHand = rows[0]?.onHand;
    const lowStockThreshold = rows[0]?.lowStockThreshold;

    if (onHand === undefined) {
      throw new DomainError(
        ErrorCodes.NOT_FOUND,
        'No stock record for a line on this order, so it could not be restocked.',
        HttpStatus.NOT_FOUND,
        { variantId: input.variantId },
      );
    }

    await manager.getRepository(InventoryTransaction).insert({
      variantId: input.variantId,
      delta: input.qty,
      type: input.type,
      reason: input.reason,
      orderId: input.orderId,
      actorUserId: input.actorUserId,
      balanceAfter: Number(onHand),
    });

    await checkLowStock(manager, this.notifications, {
      variantId: input.variantId,
      delta: input.qty,
      onHand: Number(onHand),
      lowStockThreshold: Number(lowStockThreshold),
    });
  }
```

- [ ] **Step 4: Update `orders.module.ts`**

Add the import:

```typescript
import { NotificationsModule } from '../notifications/notifications.module';
```

Add it to `imports`:

```typescript
@Module({
  imports: [TypeOrmModule.forFeature([Order]), NotificationsModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderStatusService],
  exports: [OrderStatusService, OrdersService],
})
export class OrdersModule {}
```

- [ ] **Step 5: Update `order-status.service.spec.ts`'s harness**

In the harness function, widen the `manager.query` fake's returned row to also carry `lowStockThreshold`:

```typescript
    query: (sql: string, parameters: unknown[]) => {
      if (/inventory/i.test(sql)) {
        recorded.stockUpdates.push({
          variantId: String(parameters[1]),
          delta: Number(parameters[0]),
        });
      }
      return Promise.resolve([{ onHand: 120, lowStockThreshold: 10 }]);
    },
```

Add a `queued` array to `Recorded`, a `notifications` fake, and thread it into the constructor call:

```typescript
interface Recorded {
  events: { orderId: string; status: string; note: string | null; actorUserId: string | null }[];
  ledger: { variantId: string; delta: number; type: InventoryTransactionType }[];
  stockUpdates: { variantId: string; delta: number }[];
  orderStatus: string | null;
  orderPatch: OrderPatch | null;
  queued: unknown[];
}
```

(add `queued: []` where `recorded` is constructed), and:

```typescript
  const dataSource = { transaction: <T>(run: (m: unknown) => Promise<T>) => run(manager) };
  const notifications = {
    queue: (_manager: unknown, input: unknown) => {
      recorded.queued.push(input);
      return Promise.resolve();
    },
  };
  return { service: new OrderStatusService(dataSource as never, notifications as never), recorded };
```

- [ ] **Step 6: Add unit tests for the shipped/delivered hook**

```typescript
describe('OrderStatusService.transition — notifications', () => {
  it('queues order.shipped when a packed order ships', async () => {
    const { service, recorded } = harness({ channel: OrderChannelEnum.RETAIL, status: 'packed' });

    await service.transition(ORDER_NUMBER, 'shipped', {});

    expect(recorded.queued).toEqual([
      expect.objectContaining({
        channel: 'EMAIL',
        template: 'order.shipped',
        payload: { orderNumber: ORDER_NUMBER, status: 'shipped' },
      }),
    ]);
  });

  it('queues order.delivered when an out-for-delivery order is delivered', async () => {
    const { service, recorded } = harness({
      channel: OrderChannelEnum.RETAIL,
      status: 'out-for-delivery',
    });

    await service.transition(ORDER_NUMBER, 'delivered', {});

    expect(recorded.queued).toEqual([
      expect.objectContaining({ template: 'order.delivered' }),
    ]);
  });

  it('queues nothing for a step that is neither shipped nor delivered', async () => {
    const { service, recorded } = harness({ channel: OrderChannelEnum.RETAIL, status: 'pending' });

    await service.transition(ORDER_NUMBER, 'confirmed', {});

    expect(recorded.queued).toEqual([]);
  });
});
```

- [ ] **Step 7: Run the unit spec**

Run: `cd backend && npx jest order-status.service.spec.ts`
Expected: every existing test still passes, plus the three new ones.

- [ ] **Step 8: Add an integration test walking an order to delivered**

In `backend/test/integration/orders.integration.spec.ts`, add the import:

```typescript
import { OrderStatusService } from '../../src/modules/orders/order-status.service';
```

Add a new `describe` block as a sibling of `describe('POST /account/orders/:orderNumber/cancel', ...)` — i.e. nested at the same level, directly inside the file's single outer `describe('account orders', () => { ... })`, so it closes over that outer block's own `signedIn`, `putCart`, `B2C`, `PLACE` and `CSRF_HEADER`, exactly as the cancel block already does:

```typescript
  describe('OrderStatusService.transition — notifications', () => {
    it('queues order.confirmed at placement, order.shipped and order.delivered at those two steps, and nothing else along the way', async () => {
      const { client, csrf } = await signedIn(B2C);
      await putCart(client, csrf, [
        { slug: 'premium-california-almonds', mode: 'retail' as const, size: '250g', qty: 2 },
      ]);
      const placed = expectSuccess<AccountOrder>(
        await client
          .post(PLACE)
          .set(CSRF_HEADER, csrf)
          .send({
            shipping: {
              fullName: 'Asha Menon',
              phone: '9876543210',
              email: 'asha@demo.in',
              line1: '14 Lalbagh Road',
              city: 'Bengaluru',
              state: 'Karnataka',
              pincode: '560001',
            },
            paymentMethod: 'cod',
          })
          .expect(201),
      );

      const statusService = integration.app.get(OrderStatusService);
      for (const to of ['confirmed', 'processing', 'packed', 'shipped', 'out-for-delivery', 'delivered'] as const) {
        await statusService.transition(placed.id, to);
      }

      const rows = await integration.dataSource.query<{ template: string }[]>(
        `SELECT template FROM notifications
          WHERE payload->>'orderNumber' = $1 ORDER BY "createdAt"`,
        [placed.id],
      );
      expect(rows.map((r) => r.template)).toEqual(['order.confirmed', 'order.shipped', 'order.delivered']);
    });
  });
```

(`B2C`/`PLACE`/`signedIn`/`putCart` are this file's own existing constants and helpers — reuse them exactly as the surrounding tests already do; do not redeclare them.)

- [ ] **Step 9: Run the integration suite twice**

Run: `npm run test:integration -w backend` (twice, back to back)
Expected: all suites pass both times.

- [ ] **Step 10: Typecheck, lint, format**

Run: `npm run typecheck -w backend && npm run lint -w backend && npm run format:check -w backend`
Expected: all clean.

- [ ] **Step 11: Commit**

```bash
git add backend/src/modules/orders backend/test/integration/orders.integration.spec.ts
git commit -m "feat(orders): order.shipped and order.delivered, plus the low-stock hook on a restore"
```

---

### Task 7: Backend — InventoryService: the low-stock hook

**Files:**
- Modify: `backend/src/modules/inventory/inventory.service.ts`
- Modify: `backend/src/modules/inventory/inventory.service.spec.ts`
- Modify: `backend/src/modules/inventory/inventory.module.ts`
- Modify: `backend/test/integration/inventory.integration.spec.ts`

- [ ] **Step 1: Inject `NotificationsService` into `InventoryService`**

Add imports:

```typescript
import { checkLowStock } from './check-low-stock';
import { NotificationsService } from '../notifications/notifications.service';
```

Change the constructor:

```typescript
  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}
```

- [ ] **Step 2: Call `checkLowStock` after the ledger insert in `adjust`**

Immediately before `return { onHand: inventory.onHand, balanceAfter: inventory.onHand };`, add:

```typescript
      await checkLowStock(manager, this.notifications, {
        variantId: input.variantId,
        delta,
        onHand: inventory.onHand,
        lowStockThreshold: inventory.lowStockThreshold,
      });

      return { onHand: inventory.onHand, balanceAfter: inventory.onHand };
```

- [ ] **Step 3: Update `inventory.module.ts`**

Add the import:

```typescript
import { NotificationsModule } from '../notifications/notifications.module';
```

Add it to `imports`:

```typescript
  imports: [TypeOrmModule.forFeature([Inventory, InventoryTransaction]), NotificationsModule],
```

- [ ] **Step 4: Update `inventory.service.spec.ts`'s harness**

Add `lowStockThreshold: number;` to the `StockRow` interface, and give the harness's default fixture row a threshold:

```typescript
interface StockRow {
  variantId: string;
  onHand: number;
  reserved: number;
  lowStockThreshold: number;
}
```

```typescript
function harness(
  rows: StockRow[] = [{ variantId: VARIANT, onHand: 120, reserved: 0, lowStockThreshold: 10 }],
): Harness {
```

(`findOneOrFail` already returns the matched `StockRow` object directly, so `inventory.lowStockThreshold` is now present on it with no other change to `inventoryRepository`.)

Add `queued: unknown[];` to the `Harness` interface, a `queued` local, a `notifications` fake, and thread it into the constructor call and the returned object:

```typescript
  const queued: unknown[] = [];
  const notifications = {
    queue: (_manager: unknown, input: unknown) => {
      queued.push(input);
      return Promise.resolve();
    },
  };

  return {
    service: new InventoryService(dataSource as never, notifications as never),
    stock,
    ledger,
    statements,
    trace,
    queued,
  };
```

- [ ] **Step 5: Add unit tests for the crossing**

Add a new `describe` block after `describe('InventoryService.adjust', ...)`'s existing tests:

```typescript
describe('InventoryService.adjust — low stock', () => {
  it('queues stock.low when an adjustment crosses the threshold downward', async () => {
    const { service, queued } = harness([
      { variantId: VARIANT, onHand: 12, reserved: 0, lowStockThreshold: 10 },
    ]);

    await service.adjust(adjustment({ delta: -5 }));

    expect(queued).toEqual([
      {
        userId: null,
        channel: 'EMAIL',
        template: 'stock.low',
        payload: { variantId: VARIANT, onHand: 7, lowStockThreshold: 10 },
      },
    ]);
  });

  it('queues nothing when the adjustment stays above the threshold', async () => {
    const { service, queued } = harness([
      { variantId: VARIANT, onHand: 30, reserved: 0, lowStockThreshold: 10 },
    ]);

    await service.adjust(adjustment({ delta: -5 }));

    expect(queued).toEqual([]);
  });

  it('queues nothing for a positive adjustment, even one that starts below the threshold', async () => {
    const { service, queued } = harness([
      { variantId: VARIANT, onHand: 4, reserved: 0, lowStockThreshold: 10 },
    ]);

    await service.adjust(adjustment({ delta: 40 }));

    expect(queued).toEqual([]);
  });
});
```

(`VARIANT` and the exact shape `harness(...)` accepts for pre-seeding a fixture's `onHand`/`lowStockThreshold` are this file's own existing conventions — match them exactly; the important content is the two behaviours asserted, not the fixture syntax.)

- [ ] **Step 6: Run the unit spec**

Run: `cd backend && npx jest inventory.service.spec.ts`
Expected: every existing test still passes, plus the two new ones.

- [ ] **Step 7: Add an integration test**

In `backend/test/integration/inventory.integration.spec.ts`, add a new test inside `describe('a well-formed adjustment', ...)`:

```typescript
    it('queues stock.low exactly when the adjustment crosses the threshold, and only then', async () => {
      const variantId = await aVariant();
      const [{ lowStockThreshold }] = await integration.dataSource.query<
        { lowStockThreshold: number }[]
      >('SELECT "lowStockThreshold" FROM inventory WHERE variant_id = $1', [variantId]);
      await integration.dataSource.query('UPDATE inventory SET "onHand" = $1 WHERE variant_id = $2', [
        lowStockThreshold + 3,
        variantId,
      ]);
      const { client, csrf } = await asAdmin();

      // First adjustment: stays above the threshold. No notification.
      await client
        .patch(`${BASE}/${variantId}`)
        .set(CSRF_HEADER, csrf)
        .send({ delta: -1, reason: 'small correction' })
        .expect(200);

      // Second adjustment: crosses it.
      await client
        .patch(`${BASE}/${variantId}`)
        .set(CSRF_HEADER, csrf)
        .send({ delta: -3, reason: 'bigger correction' })
        .expect(200);

      const rows = await integration.dataSource.query<{ payload: Record<string, unknown> }[]>(
        `SELECT payload FROM notifications WHERE template = 'stock.low' AND payload->>'variantId' = $1`,
        [variantId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toMatchObject({ variantId, onHand: lowStockThreshold - 1 });
    });
```

- [ ] **Step 8: Run the integration suite twice**

Run: `npm run test:integration -w backend` (twice, back to back)
Expected: all suites pass both times.

- [ ] **Step 9: Typecheck, lint, format**

Run: `npm run typecheck -w backend && npm run lint -w backend && npm run format:check -w backend`
Expected: all clean.

- [ ] **Step 10: Commit**

```bash
git add backend/src/modules/inventory backend/test/integration/inventory.integration.spec.ts
git commit -m "feat(inventory): stock.low on an admin adjustment that crosses the threshold"
```

---

### Task 8: Backend — RfqsService: the RFQ-received hook

**Files:**
- Modify: `backend/src/modules/rfqs/rfqs.service.ts`
- Modify: `backend/src/modules/rfqs/rfqs.service.spec.ts`
- Modify: `backend/test/integration/rfqs.integration.spec.ts`

`RfqsModule` already imports `NotificationsModule` (Task 3), so no module-wiring change is needed here — only the service's own constructor and body.

- [ ] **Step 1: Inject `NotificationsService` into `RfqsService`**

`RfqKind` is already imported from `'../../entities/enums'` — add `NotificationChannel` to that same line rather than a new import statement:

```typescript
import { NotificationChannel, RfqKind } from '../../entities/enums';
```

Add a new import:

```typescript
import { NotificationsService } from '../notifications/notifications.service';
```

Change the constructor:

```typescript
  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}
```

- [ ] **Step 2: Queue `rfq.received` right after the save**

Immediately after `const saved = await manager.getRepository(Rfq).save(draft);` and before the `const reloaded = ...` line, add:

```typescript
      await this.notifications.queue(manager, {
        userId,
        channel: NotificationChannel.EMAIL,
        template: 'rfq.received',
        payload: {
          rfqNumber: saved.rfqNumber,
          businessName: saved.businessName,
          email: saved.email,
          kind: saved.kind,
        },
      });
```

- [ ] **Step 3: Update `rfqs.service.spec.ts`'s two harnesses**

In the `harness()` function used by `describe('RfqsService.create', ...)`, add a `queued` array and a `notifications` fake, and pass it as the second constructor argument:

```typescript
  const recorded = {
    saved: [] as Record<string, unknown>[],
    findOneArgs: [] as unknown[],
    productFindWhere: [] as unknown[],
    queued: [] as unknown[],
  };
```

```typescript
  const dataSource = {
    transaction: <T>(run: (manager: unknown) => Promise<T>) => run(manager),
  } as unknown as DataSource;

  const notifications = {
    queue: (_manager: unknown, input: unknown) => {
      recorded.queued.push(input);
      return Promise.resolve();
    },
  };

  return { service: new RfqsService(dataSource, notifications as never), recorded, rfqRepository };
```

In `readHarness()` (used by `describe('RfqsService.list', ...)` and `findOne`), pass a throwaway fake too, since `list`/`findOne` never call it but the constructor now requires a second argument:

```typescript
  return { service: new RfqsService(dataSource, { queue: () => Promise.resolve() } as never), recorded };
```

- [ ] **Step 4: Add a unit test proving the queue call**

In `describe('RfqsService.create', ...)`, add:

```typescript
  it('queues rfq.received with the business name, email and kind', async () => {
    const { service, recorded } = harness();

    await service.create(BULK_INPUT, 'user-1');

    expect(recorded.queued).toEqual([
      expect.objectContaining({
        userId: 'user-1',
        channel: 'EMAIL',
        template: 'rfq.received',
        payload: {
          rfqNumber: recorded.saved[0]?.rfqNumber,
          businessName: 'Crumb & Co Bakery',
          email: 'priya@crumbandco.example',
          kind: RfqKind.BULK,
        },
      }),
    ]);
  });

  it('attributes the notification to nobody for an anonymous prospect', async () => {
    const { service, recorded } = harness();

    await service.create(GIFTING_INPUT, null);

    expect(recorded.queued).toEqual([expect.objectContaining({ userId: null })]);
  });
```

- [ ] **Step 5: Run the unit spec**

Run: `cd backend && npx jest rfqs.service.spec.ts`
Expected: every existing test still passes, plus the two new ones.

- [ ] **Step 6: Add an integration test**

In `backend/test/integration/rfqs.integration.spec.ts`, add a new test inside `describe('POST /rfqs and POST /rfqs/gifting', ...)`:

```typescript
    it('queues rfq.received for a bulk enquiry', async () => {
      const { client, csrf } = await guest();
      const rfq = expectSuccess<RfqDetail>(
        await client.post(RFQS).set(CSRF_HEADER, csrf).send(BULK_BODY).expect(201),
      );

      const rows = await integration.dataSource.query<{ payload: Record<string, unknown> }[]>(
        `SELECT payload FROM notifications WHERE template = 'rfq.received' AND payload->>'rfqNumber' = $1`,
        [rfq.id],
      );
      expect(rows).toEqual([
        {
          payload: {
            rfqNumber: rfq.id,
            businessName: BULK_BODY.businessName,
            email: BULK_BODY.email,
            kind: 'BULK',
          },
        },
      ]);
    });
```

- [ ] **Step 7: Run the integration suite twice**

Run: `npm run test:integration -w backend` (twice, back to back)
Expected: all suites pass both times.

- [ ] **Step 8: Typecheck, lint, format**

Run: `npm run typecheck -w backend && npm run lint -w backend && npm run format:check -w backend`
Expected: all clean.

- [ ] **Step 9: Commit**

```bash
git add backend/src/modules/rfqs backend/test/integration/rfqs.integration.spec.ts
git commit -m "feat(rfqs): queue rfq.received the moment an enquiry is saved"
```

---

### Task 9: Backend — SupportTicketsModule (the contact form's real backend)

**Files:**
- Create: `backend/src/database/migrations/20260826100000-TicketNumberSequence.ts`
- Create: `backend/src/modules/support-tickets/ticket-number.ts`
- Create: `backend/src/modules/support-tickets/ticket-number.spec.ts`
- Create: `backend/src/modules/support-tickets/dto/create-contact-message.dto.ts`
- Create: `backend/src/modules/support-tickets/support-tickets.service.ts`
- Create: `backend/src/modules/support-tickets/support-tickets.service.spec.ts`
- Create: `backend/src/modules/support-tickets/support-tickets.controller.ts`
- Create: `backend/src/modules/support-tickets/support-tickets.controller.spec.ts`
- Create: `backend/src/modules/support-tickets/support-tickets.module.ts`
- Create: `backend/test/integration/support-tickets.integration.spec.ts`
- Modify: `backend/src/app.module.ts`

- [ ] **Step 1: Write the migration**

```typescript
// backend/src/database/migrations/20260826100000-TicketNumberSequence.ts
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The sequence support-ticket numbers are drawn from — `order_number_seq` and `rfq_number_seq`'s
 * sibling, for the identical reason: `nextval` is atomic where `max(ticketNumber) + 1` is a
 * read-then-write gap, and it is deliberately **not** rolled back by a failed transaction, so a
 * request that fails after allocating a number burns it rather than handing it to the next one.
 *
 * `START 100000`, matching both siblings: headroom above whatever a seeder writes with a fixed
 * reference, so the sequence's first live issue cannot collide with a fixture. `support_tickets`
 * has no seeder today, so this is precautionary rather than closing a known gap.
 *
 * Not `CYCLE`: wrapping would re-issue a reference a customer has already been given.
 */
export class TicketNumberSequence20260826100000 implements MigrationInterface {
  name = 'TicketNumberSequence20260826100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE SEQUENCE "ticket_number_seq" START 100000 INCREMENT 1 NO CYCLE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SEQUENCE "ticket_number_seq"`);
  }
}
```

- [ ] **Step 2: Write `ticket-number.ts`**

```typescript
// backend/src/modules/support-tickets/ticket-number.ts
import { TICKET_NUMBER_PATTERN } from '@nutwala/shared';
import type { EntityManager } from 'typeorm';

/** Re-exported, not re-declared — `rfq-number.ts` and `order-number.ts`'s identical arrangement,
 * for the identical reason: one definition, so the frontend and this module import the same one. */
export { TICKET_NUMBER_PATTERN };

/** The sequence added by `20260826100000-TicketNumberSequence`. */
export const TICKET_NUMBER_SEQUENCE = 'ticket_number_seq';

export function formatTicketNumber(year: number, sequence: number): string {
  return `ST-${year}-${String(sequence).padStart(6, '0')}`;
}

/**
 * Allocates the next support-ticket number from Postgres. `nextRfqNumber`'s shape, unchanged,
 * because it is the same problem: `nextval` closes the read-then-write gap two submissions racing
 * would otherwise hit, and takes the transaction's own `EntityManager` so the allocation joins
 * whichever transaction is creating the ticket, rather than opening a second connection.
 */
export async function nextTicketNumber(manager: EntityManager, now = new Date()): Promise<string> {
  const rows = await manager.query<{ nextval: string }[]>(`SELECT nextval($1) AS nextval`, [
    TICKET_NUMBER_SEQUENCE,
  ]);
  const value = Number(rows[0]?.nextval);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${TICKET_NUMBER_SEQUENCE} returned ${String(rows[0]?.nextval)}`);
  }
  return formatTicketNumber(now.getFullYear(), value);
}
```

- [ ] **Step 3: Write `ticket-number.spec.ts`**

```typescript
// backend/src/modules/support-tickets/ticket-number.spec.ts
import type { EntityManager } from 'typeorm';
import {
  formatTicketNumber,
  nextTicketNumber,
  TICKET_NUMBER_PATTERN,
  TICKET_NUMBER_SEQUENCE,
} from './ticket-number';

describe('formatTicketNumber', () => {
  it('pads to six digits behind the year', () => {
    expect(formatTicketNumber(2026, 100000)).toBe('ST-2026-100000');
    expect(formatTicketNumber(2026, 1)).toBe('ST-2026-000001');
  });

  it('grows past six digits rather than truncating', () => {
    expect(formatTicketNumber(2026, 1_000_000)).toBe('ST-2026-1000000');
    expect(formatTicketNumber(2026, 1_000_000).length).toBeLessThanOrEqual(20);
    expect(formatTicketNumber(2026, 1_000_000)).toMatch(TICKET_NUMBER_PATTERN);
  });

  it('matches the pattern the frontend keys on', () => {
    expect(formatTicketNumber(2026, 100000)).toMatch(TICKET_NUMBER_PATTERN);
  });

  it('rejects the shapes that are not ticket numbers', () => {
    for (const wrong of [
      'ST-2026-12345',
      'st-2026-100000',
      'ST-26-100000',
      'RFQ-2026-100000',
      'NN-2026-100000',
      '100000',
      'XST-2026-100000',
      'ST-2026-100000X',
    ]) {
      expect(wrong).not.toMatch(TICKET_NUMBER_PATTERN);
    }
  });
});

describe('nextTicketNumber', () => {
  const managerReturning = (rows: unknown) => {
    const query = jest.fn().mockResolvedValue(rows);
    return { manager: { query } as unknown as EntityManager, query };
  };

  it('draws from the ticket number sequence and stamps the year of the clock it is given', async () => {
    const { manager, query } = managerReturning([{ nextval: '100000' }]);

    await expect(nextTicketNumber(manager, new Date('2027-03-04T05:06:07Z'))).resolves.toBe(
      'ST-2027-100000',
    );
    expect(query).toHaveBeenCalledWith(expect.stringContaining('nextval'), [
      TICKET_NUMBER_SEQUENCE,
    ]);
  });

  it('refuses a value that cannot survive the trip through a JS number', async () => {
    const { manager } = managerReturning([{ nextval: '9007199254740993' }]);
    await expect(nextTicketNumber(manager)).rejects.toThrow(
      'ticket_number_seq returned 9007199254740993',
    );
  });

  it('refuses an empty result rather than formatting NaN into a reference', async () => {
    const { manager } = managerReturning([]);
    await expect(nextTicketNumber(manager)).rejects.toThrow('ticket_number_seq returned undefined');
  });
});
```

- [ ] **Step 4: Run the spec**

Run: `cd backend && npx jest ticket-number.spec.ts`
Expected: 6 passed.

- [ ] **Step 5: Write `create-contact-message.dto.ts`**

```typescript
// backend/src/modules/support-tickets/dto/create-contact-message.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CONTACT_TOPICS, PHONE_REGEX } from '@nutwala/shared';
import { IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * `POST /contact` — the contact form's real backend. Every field mirrors
 * `frontend/src/features/contact/schema.ts`'s `contactSchema`, `CreateRfqDto`'s own "the server
 * does not trust the client's copy of a rule it can check itself" reasoning.
 *
 * `orderNumber` is deliberately **not** `@Matches(ORDER_NUMBER_PATTERN)`. `SupportTicket`'s own
 * docblock: *"a customer may type an order number that does not exist... and the ticket must
 * still be created so support can answer."* It is a lead for a human to chase, not a reference
 * the server can verify, so it is bounded to the column's width and left otherwise unvalidated —
 * a customer who types "the one from last Tuesday" still raises a ticket.
 */
export class CreateContactMessageDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) name: string;

  @ApiProperty() @IsEmail() @MaxLength(255) email: string;

  @ApiPropertyOptional({ pattern: PHONE_REGEX.source })
  @IsOptional()
  @Matches(PHONE_REGEX, { message: 'Enter a valid 10-digit Indian mobile number' })
  phone?: string;

  @ApiProperty({ enum: CONTACT_TOPICS }) @IsIn(CONTACT_TOPICS) topic: string;

  /** `support_tickets."orderNumber"` is `varchar(20)`. */
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) orderNumber?: string;

  @ApiProperty() @IsString() @MinLength(10) @MaxLength(2000) message: string;
}
```

- [ ] **Step 6: Write `support-tickets.service.ts`**

```typescript
// backend/src/modules/support-tickets/support-tickets.service.ts
import { Injectable } from '@nestjs/common';
import { DataSource, type DeepPartial } from 'typeorm';
import { NotificationChannel } from '../../entities/enums';
import { SupportTicket } from '../../entities/ops/support-ticket.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { nextTicketNumber } from './ticket-number';

export interface CreateSupportTicketInput {
  name: string;
  email: string;
  phone?: string;
  topic: string;
  orderNumber?: string;
  message: string;
}

/**
 * The contact form's real backend. `create` is the only write this milestone needs — no route
 * reads a ticket back yet, matching how a prospect's RFQ has no read path until they sign in.
 *
 * No `TypeOrmModule.forFeature`: like `RfqsService`, this takes the `DataSource` and does
 * everything through one transaction's `EntityManager`. Unlike `RfqsService.create`, there is no
 * cascaded relation to reload afterwards — a ticket has no lines and no gifting detail this
 * milestone — so `save()`'s own return value is already the complete row.
 */
@Injectable()
export class SupportTicketsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  async create(input: CreateSupportTicketInput, userId: string | null): Promise<SupportTicket> {
    return this.dataSource.transaction(async (manager) => {
      const ticketNumber = await nextTicketNumber(manager);

      const draft: DeepPartial<SupportTicket> = {
        ticketNumber,
        userId,
        name: input.name,
        email: input.email,
        phone: input.phone ?? null,
        topic: input.topic,
        orderNumber: input.orderNumber ?? null,
        message: input.message,
        status: 'new',
        priority: 2,
        assignedToUserId: null,
        resolvedAt: null,
      };

      const saved = await manager.getRepository(SupportTicket).save(draft);

      await this.notifications.queue(manager, {
        userId,
        channel: NotificationChannel.EMAIL,
        template: 'support.received',
        payload: { ticketNumber: saved.ticketNumber, email: saved.email, topic: saved.topic },
      });

      return saved;
    });
  }
}
```

- [ ] **Step 7: Write `support-tickets.service.spec.ts`**

```typescript
// backend/src/modules/support-tickets/support-tickets.service.spec.ts
import { SupportTicketsService } from './support-tickets.service';

function harness(options: { nextval?: string } = {}) {
  const recorded = { saved: [] as Record<string, unknown>[], queued: [] as unknown[] };

  const manager = {
    getRepository: () => ({
      save: (draft: Record<string, unknown>) => {
        const saved = { ...draft, id: 'ticket-uuid-1' };
        recorded.saved.push(saved);
        return Promise.resolve(saved);
      },
    }),
    query: () => Promise.resolve([{ nextval: options.nextval ?? '100000' }]),
  };

  const dataSource = { transaction: <T>(run: (m: unknown) => Promise<T>) => run(manager) };
  const notifications = {
    queue: (_manager: unknown, input: unknown) => {
      recorded.queued.push(input);
      return Promise.resolve();
    },
  };

  return {
    service: new SupportTicketsService(dataSource as never, notifications as never),
    recorded,
  };
}

const INPUT = {
  name: 'Asha Menon',
  email: 'asha@demo.in',
  topic: 'An order I have placed',
  message: 'My order NN-2026-100000 has not arrived after 6 days.',
};

describe('SupportTicketsService.create', () => {
  it('saves the ticket with a minted number and queues support.received', async () => {
    const { service, recorded } = harness();

    const ticket = await service.create(INPUT, 'user-1');

    expect(ticket.ticketNumber).toMatch(/^ST-\d{4}-100000$/);
    expect(recorded.saved).toEqual([
      {
        ticketNumber: ticket.ticketNumber,
        userId: 'user-1',
        name: 'Asha Menon',
        email: 'asha@demo.in',
        phone: null,
        topic: 'An order I have placed',
        orderNumber: null,
        message: 'My order NN-2026-100000 has not arrived after 6 days.',
        status: 'new',
        priority: 2,
        assignedToUserId: null,
        resolvedAt: null,
        id: 'ticket-uuid-1',
      },
    ]);
    expect(recorded.queued).toEqual([
      {
        userId: 'user-1',
        channel: 'EMAIL',
        template: 'support.received',
        payload: {
          ticketNumber: ticket.ticketNumber,
          email: 'asha@demo.in',
          topic: 'An order I have placed',
        },
      },
    ]);
  });

  it('stores null for a prospect with no account, and for the optional fields left blank', async () => {
    const { service, recorded } = harness();

    await service.create(INPUT, null);

    expect(recorded.saved[0]).toMatchObject({ userId: null, phone: null, orderNumber: null });
  });

  it('records the phone and the order number when the caller sent them', async () => {
    const { service, recorded } = harness();

    await service.create({ ...INPUT, phone: '9876543210', orderNumber: 'NN-2026-100000' }, null);

    expect(recorded.saved[0]).toMatchObject({
      phone: '9876543210',
      orderNumber: 'NN-2026-100000',
    });
  });
});
```

- [ ] **Step 8: Run the spec**

Run: `cd backend && npx jest support-tickets.service.spec.ts`
Expected: 3 passed.

- [ ] **Step 9: Write `support-tickets.controller.ts`**

```typescript
// backend/src/modules/support-tickets/support-tickets.controller.ts
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { SupportTicketSummary } from '@nutwala/shared';
import { OptionalUser } from '../../common/auth/decorators/current-user.decorator';
import { Public } from '../../common/auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { CreateContactMessageDto } from './dto/create-contact-message.dto';
import { SupportTicketsService } from './support-tickets.service';

/**
 * `POST /contact` — the contact form's real backend. `@Public()` with `@OptionalUser()`,
 * `RfqsController`'s own reasoning: a visitor needs no account to ask a question, and a
 * signed-in customer's message should still be attributed to them.
 */
@ApiTags('contact')
@Controller('contact')
export class SupportTicketsController {
  constructor(private readonly tickets: SupportTicketsService) {}

  /** Five per hour per IP — `RfqsController`'s own limit, for the identical shape: unauthenticated,
   * writes a row, no account to scope by. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Send a message from the contact form' })
  async create(
    @Body() dto: CreateContactMessageDto,
    @OptionalUser() user: AuthenticatedUser | undefined,
  ): Promise<SupportTicketSummary> {
    const ticket = await this.tickets.create(
      {
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        topic: dto.topic,
        orderNumber: dto.orderNumber,
        message: dto.message,
      },
      user?.id ?? null,
    );
    return { ticketNumber: ticket.ticketNumber };
  }
}
```

- [ ] **Step 10: Write `support-tickets.controller.spec.ts`**

```typescript
// backend/src/modules/support-tickets/support-tickets.controller.spec.ts
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import type { CreateContactMessageDto } from './dto/create-contact-message.dto';
import { SupportTicketsController } from './support-tickets.controller';
import type { SupportTicketsService } from './support-tickets.service';

const DTO: CreateContactMessageDto = {
  name: 'Asha Menon',
  email: 'asha@demo.in',
  topic: 'An order I have placed',
  message: 'My order has not arrived after 6 days.',
};

function harness() {
  const calls: { input: unknown; userId: string | null }[] = [];
  const tickets = {
    create: (input: unknown, userId: string | null) => {
      calls.push({ input, userId });
      return Promise.resolve({ ticketNumber: 'ST-2026-100000' });
    },
  };
  return {
    controller: new SupportTicketsController(tickets as unknown as SupportTicketsService),
    calls,
  };
}

describe('SupportTicketsController.create', () => {
  it('forwards the DTO fields and the caller’s id, and answers only the ticket number', async () => {
    const { controller, calls } = harness();
    const user = { id: 'user-1' } as AuthenticatedUser;

    const result = await controller.create(DTO, user);

    expect(result).toEqual({ ticketNumber: 'ST-2026-100000' });
    expect(calls).toEqual([
      {
        input: {
          name: 'Asha Menon',
          email: 'asha@demo.in',
          phone: undefined,
          topic: 'An order I have placed',
          orderNumber: undefined,
          message: 'My order has not arrived after 6 days.',
        },
        userId: 'user-1',
      },
    ]);
  });

  it('attributes the ticket to nobody when the caller has no session', async () => {
    const { controller, calls } = harness();

    await controller.create(DTO, undefined);

    expect(calls[0]?.userId).toBeNull();
  });
});
```

- [ ] **Step 11: Run the spec**

Run: `cd backend && npx jest support-tickets.controller.spec.ts`
Expected: 2 passed.

- [ ] **Step 12: Write `support-tickets.module.ts`**

```typescript
// backend/src/modules/support-tickets/support-tickets.module.ts
import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { SupportTicketsController } from './support-tickets.controller';
import { SupportTicketsService } from './support-tickets.service';

/** No `TypeOrmModule.forFeature`: `SupportTicketsService` takes the `DataSource` and does
 * everything through one transaction's `EntityManager`, `RfqsModule`'s own pattern. */
@Module({
  imports: [NotificationsModule],
  controllers: [SupportTicketsController],
  providers: [SupportTicketsService],
})
export class SupportTicketsModule {}
```

- [ ] **Step 13: Register `SupportTicketsModule` in `AppModule`**

Add the import, alphabetically between `RfqsModule` and `WishlistModule`:

```typescript
import { SupportTicketsModule } from './modules/support-tickets/support-tickets.module';
```

Add it to the `imports` array in the same position:

```typescript
    RfqsModule,
    SupportTicketsModule,
    WishlistModule,
```

- [ ] **Step 14: Run the migration against the test database and the full unit suite**

Run: `npm run test:integration -w backend` (this runs migrations against the container itself before the suite; there is no separate manual migration step for the test database).
Expected: passes — this is also step 15's job, but running it now first confirms the new migration itself is well-formed before writing more tests against it.

- [ ] **Step 15: Write `support-tickets.integration.spec.ts`**

```typescript
// backend/test/integration/support-tickets.integration.spec.ts
import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import { TICKET_NUMBER_PATTERN, type SupportTicketSummary } from '@nutwala/shared';
import { seedUsers } from '../../src/database/seeds/users.seed';
import { TEST_PASSWORD } from '../factories/user.factory';
import { agent, cookieValue, expectError, expectSuccess, request, useIntegrationApp } from './helpers';

const CSRF_COOKIE = 'nn_csrf';
const CSRF_HEADER = 'X-CSRF-Token';
const CONTACT = '/api/v1/contact';
const HEALTH = '/api/v1/health';
const LOGIN = '/api/v1/auth/login';

const BODY = {
  name: 'Asha Menon',
  email: 'asha@demo.in',
  topic: 'An order I have placed',
  message: 'My order has not arrived after 6 days, and the tracking page shows nothing at all.',
};

describe('contact', () => {
  const integration = useIntegrationApp();

  beforeEach(() => {
    const throttler = integration.app.get<ThrottlerStorageService>(ThrottlerStorage);
    throttler.onApplicationShutdown();
    throttler.storage.clear();
  });

  beforeEach(async () => {
    await seedUsers(integration.dataSource);
  });

  async function guest() {
    const client = agent(integration.app);
    const primer = await client.get(HEALTH).expect(200);
    return { client, csrf: cookieValue(primer, CSRF_COOKIE) };
  }

  async function signedIn(email: string) {
    const client = agent(integration.app);
    const login = await client.post(LOGIN).send({ email, password: TEST_PASSWORD }).expect(200);
    return { client, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  }

  it('lets an anonymous visitor raise a ticket, and mints a real reference', async () => {
    const { client, csrf } = await guest();

    const ticket = expectSuccess<SupportTicketSummary>(
      await client.post(CONTACT).set(CSRF_HEADER, csrf).send(BODY).expect(201),
    );

    expect(ticket.ticketNumber).toMatch(TICKET_NUMBER_PATTERN);
    const [row] = await integration.dataSource.query<{ user_id: string | null; status: string }[]>(
      'SELECT user_id, status FROM support_tickets WHERE "ticketNumber" = $1',
      [ticket.ticketNumber],
    );
    expect(row).toMatchObject({ user_id: null, status: 'new' });
  });

  it('attributes the ticket to a signed-in caller', async () => {
    const { client, csrf } = await signedIn('b2c@demo.in');

    const ticket = expectSuccess<SupportTicketSummary>(
      await client.post(CONTACT).set(CSRF_HEADER, csrf).send(BODY).expect(201),
    );

    const [row] = await integration.dataSource.query<{ user_id: string | null }[]>(
      'SELECT user_id FROM support_tickets WHERE "ticketNumber" = $1',
      [ticket.ticketNumber],
    );
    expect(row?.user_id).not.toBeNull();
  });

  it('queues support.received', async () => {
    const { client, csrf } = await guest();

    const ticket = expectSuccess<SupportTicketSummary>(
      await client.post(CONTACT).set(CSRF_HEADER, csrf).send(BODY).expect(201),
    );

    const rows = await integration.dataSource.query<{ template: string; user_id: string | null }[]>(
      `SELECT template, user_id FROM notifications WHERE payload->>'ticketNumber' = $1`,
      [ticket.ticketNumber],
    );
    expect(rows).toEqual([{ template: 'support.received', user_id: null }]);
  });

  it('creates a ticket even for an order number that does not exist', async () => {
    const { client, csrf } = await guest();

    const ticket = expectSuccess<SupportTicketSummary>(
      await client
        .post(CONTACT)
        .set(CSRF_HEADER, csrf)
        .send({ ...BODY, orderNumber: 'NN-2026-999999' })
        .expect(201),
    );

    const [row] = await integration.dataSource.query<{ orderNumber: string | null }[]>(
      'SELECT "orderNumber" FROM support_tickets WHERE "ticketNumber" = $1',
      [ticket.ticketNumber],
    );
    expect(row?.orderNumber).toBe('NN-2026-999999');
  });

  it('refuses a message shorter than 10 characters, with the field named', async () => {
    const { client, csrf } = await guest();

    const error = expectError(
      await client
        .post(CONTACT)
        .set(CSRF_HEADER, csrf)
        .send({ ...BODY, message: 'too short' })
        .expect(400),
    );
    expect(error.details).toHaveProperty('message');
  });

  it('refuses a topic outside CONTACT_TOPICS', async () => {
    const { client, csrf } = await guest();

    await client
      .post(CONTACT)
      .set(CSRF_HEADER, csrf)
      .send({ ...BODY, topic: 'Something not on the list' })
      .expect(400);
  });

  it('names an unexpected property rather than ignoring it', async () => {
    const { client, csrf } = await guest();

    const error = expectError(
      await client
        .post(CONTACT)
        .set(CSRF_HEADER, csrf)
        .send({ ...BODY, isVip: true })
        .expect(400),
    );
    expect(error.details).toHaveProperty('isVip');
  });

  it('refuses a request with no CSRF header', async () => {
    const client = request(integration.app);
    await client.post(CONTACT).send(BODY).expect(403);
  });

  it('throttles at 5 per hour per IP', async () => {
    const { client, csrf } = await guest();
    for (let i = 0; i < 5; i += 1) {
      await client.post(CONTACT).set(CSRF_HEADER, csrf).send(BODY).expect(201);
    }
    await client.post(CONTACT).set(CSRF_HEADER, csrf).send(BODY).expect(429);
  });
});
```

- [ ] **Step 16: Run the integration suite twice**

Run: `npm run test:integration -w backend` (twice, back to back)
Expected: all suites pass both times, including all nine new tests in `support-tickets.integration.spec.ts`.

- [ ] **Step 17: Typecheck, lint, format**

Run: `npm run typecheck -w backend && npm run lint -w backend && npm run format:check -w backend`
Expected: all clean.

- [ ] **Step 18: Commit**

```bash
git add backend/src/database/migrations/20260826100000-TicketNumberSequence.ts \
  backend/src/modules/support-tickets backend/src/app.module.ts \
  backend/test/integration/support-tickets.integration.spec.ts
git commit -m "feat(support-tickets): the contact form's real backend, POST /contact"
```

---

### Task 10: Frontend — the contact form seam

**Files:**
- Create: `frontend/src/features/contact/schema.ts`
- Create: `frontend/src/features/contact/api/index.ts`
- Create: `frontend/src/features/contact/hooks/useContact.ts`
- Delete: `frontend/src/features/content/schema.ts`
- Modify: `frontend/src/features/content/types.ts`
- Modify: `frontend/src/features/content/api/index.ts`
- Modify: `frontend/src/features/content/hooks/useContent.ts`
- Modify: `frontend/src/routes/contact.tsx`
- Create: `frontend/src/test/contact-api.stub.ts`
- Modify: `frontend/src/test/auth-api.stub.ts`
- Modify: `frontend/src/test/routes.smoke.test.tsx`

- [ ] **Step 1: Write `features/contact/schema.ts`**

Moved from `features/content/schema.ts`, with `orderId` renamed to `orderNumber` (it holds an order *number* like `NN-2026-000123`, never a uuid — "orderId" was a misnomer inherited from the Phase 1 mock):

```typescript
// frontend/src/features/contact/schema.ts
import { z } from "zod";
import { PHONE_REGEX } from "@/features/checkout/schema";

/** The contact form's topic list lives in `@nutwala/shared`, so the backend's
 * `CreateContactMessageDto` validates against the same strings the select submits. */
export { CONTACT_TOPICS } from "@nutwala/shared";

export const contactSchema = z.object({
  name: z.string().min(2, "Enter your name"),
  email: z.string().email("Enter a valid email address"),
  phone: z
    .string()
    .refine((v) => v === "" || PHONE_REGEX.test(v), "Enter a valid 10-digit Indian mobile number")
    .optional(),
  topic: z.string().min(1, "Choose what this is about"),
  orderNumber: z.string().optional(),
  message: z.string().min(10, "Tell us a little more so we can help"),
});

export type ContactFormValues = z.infer<typeof contactSchema>;
```

- [ ] **Step 2: Write `features/contact/api/index.ts`**

```typescript
// frontend/src/features/contact/api/index.ts
import type { CreateContactMessageRequest, SupportTicketSummary } from "@nutwala/shared";
import { http } from "@/lib/http";
import type { ContactFormValues } from "../schema";

/**
 * The contact form's real backend. `toCreateContactMessageRequest` strips the optionals a
 * `defaultValues` object initialises to `""` — `rfqApi`'s `toCreateRfqRequest` states the
 * identical reason: `@IsOptional()` in class-validator skips its sibling validators only for
 * `undefined`/`null`, so an empty string is a *present* value that would 400 on `phone` for
 * every message that left it untouched.
 */
const omitEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

function toCreateContactMessageRequest(values: ContactFormValues): CreateContactMessageRequest {
  const phone = omitEmpty(values.phone);
  const orderNumber = omitEmpty(values.orderNumber);
  return {
    name: values.name,
    email: values.email,
    ...(phone === undefined ? {} : { phone }),
    topic: values.topic,
    ...(orderNumber === undefined ? {} : { orderNumber }),
    message: values.message,
  };
}

export const contactApi = {
  /** `POST /contact` — public: a visitor needs no account to ask a question. */
  submit: (values: ContactFormValues): Promise<SupportTicketSummary> =>
    http.post<SupportTicketSummary>("/contact", toCreateContactMessageRequest(values)),
};
```

- [ ] **Step 3: Write `features/contact/hooks/useContact.ts`**

```typescript
// frontend/src/features/contact/hooks/useContact.ts
import { useMutation } from "@tanstack/react-query";
import { contactApi } from "../api";
import type { ContactFormValues } from "../schema";

export const useSubmitContactMessage = () =>
  useMutation({
    mutationFn: (values: ContactFormValues) => contactApi.submit(values),
  });
```

- [ ] **Step 4: Delete `features/content/schema.ts`**

```bash
git rm frontend/src/features/content/schema.ts
```

- [ ] **Step 5: Remove the contact-only exports from `features/content/types.ts`**

Delete the `ContactMessageDraft` and `ContactMessage` interfaces from `frontend/src/features/content/types.ts` — every other export in that file (`BLOG_CATEGORIES`, `BlogCategory`, `BlogPost`) is unrelated to contact and stays untouched.

- [ ] **Step 6: Remove `submitContactMessage` from `features/content/api/index.ts`**

Delete the `submitContactMessage` method from the `contentApi` object literal, and drop `ContactMessage`/`ContactMessageDraft` from that file's type-only import (it should now import only `BlogCategory`, `BlogPost` from `../types`).

- [ ] **Step 7: Remove `useSubmitContactMessage` from `features/content/hooks/useContent.ts`**

Delete the `useSubmitContactMessage` export and drop `ContactMessageDraft` from that file's import.

- [ ] **Step 8: Rewrite `routes/contact.tsx`**

```tsx
// frontend/src/routes/contact.tsx
import { zodResolver } from "@hookform/resolvers/zod";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { ContactDetails } from "@/components/common/ContactDetails";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { settings } from "@/config/settings";
import { CONTACT_TOPICS, contactSchema, type ContactFormValues } from "@/features/contact/schema";
import { useSubmitContactMessage } from "@/features/contact/hooks/useContact";
import { useSeo } from "@/hooks/useSeo";
import type { SupportTicketSummary } from "@nutwala/shared";

export const Route = createFileRoute("/contact")({ component: Contact });

const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

function Contact() {
  const submitMessage = useSubmitContactMessage();
  const [created, setCreated] = useState<SupportTicketSummary | null>(null);

  useSeo({
    title: `Contact Us | ${settings.brandName}`,
    description:
      "Questions about an order, shipping, a return, bulk pricing or corporate gifting — send us a message and we reply within one working day.",
  });

  const form = useForm<ContactFormValues, unknown, ContactFormValues>({
    resolver: zodResolver<ContactFormValues, unknown, ContactFormValues>(contactSchema),
    defaultValues: {
      name: "",
      email: "",
      phone: "",
      topic: CONTACT_TOPICS[0],
      orderNumber: "",
      message: "",
    },
  });

  const submitting = form.formState.isSubmitting;

  const onSubmit = async (values: ContactFormValues) => {
    const ticket = await submitMessage.mutateAsync(values);
    form.reset();
    setCreated(ticket);
  };

  return (
    <div className="container-page py-14">
      <div className="max-w-2xl">
        <h1 className="font-display text-5xl leading-[1.05]">Talk to us</h1>
        <p className="text-muted-foreground mt-4">
          Order questions, delivery chasers, wholesale enquiries and gifting briefs all land in the
          same place. We reply within one working day.
        </p>
      </div>

      <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div>
          {created ? (
            <div role="status" className="border-border bg-card shadow-soft rounded-2xl border p-8">
              <CheckCircle2 className="text-leaf size-10" aria-hidden="true" />
              <h2 className="font-display mt-4 text-3xl">Message received</h2>
              <p className="text-muted-foreground mt-3 text-sm">
                Thanks — we have it. We reply to every message within one working day, to the email
                address you gave us.
              </p>
              <p className="text-muted-foreground mt-2 text-sm">
                Quote it if you follow up: <span className="font-semibold">{created.ticketNumber}</span>
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Button variant="outline" onClick={() => setCreated(null)}>
                  Send another message
                </Button>
                <Button asChild variant="ghost">
                  <Link to="/faq">Browse the FAQs</Link>
                </Button>
              </div>
            </div>
          ) : (
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                aria-label="Contact form"
                className="border-border bg-card shadow-soft rounded-2xl border p-6 sm:p-8"
              >
                <h2 className="font-display text-3xl">Send a message</h2>
                <div className="mt-6 grid gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Your name</FormLabel>
                        <FormControl>
                          <Input autoComplete="name" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input type="email" autoComplete="email" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Mobile number (optional)</FormLabel>
                        <FormControl>
                          <Input
                            inputMode="numeric"
                            maxLength={10}
                            autoComplete="tel-national"
                            {...field}
                            value={field.value ?? ""}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="topic"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>What is this about?</FormLabel>
                        <FormControl>
                          <select className={SELECT_CLASS} {...field}>
                            {CONTACT_TOPICS.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="orderNumber"
                    render={({ field }) => (
                      <FormItem className="sm:col-span-2">
                        <FormLabel>Order number (optional)</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="NN-2026-000000"
                            {...field}
                            value={field.value ?? ""}
                          />
                        </FormControl>
                        <FormDescription>
                          Including it saves a round trip if this is about an order.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="message"
                    render={({ field }) => (
                      <FormItem className="sm:col-span-2">
                        <FormLabel>Message</FormLabel>
                        <FormControl>
                          <Textarea rows={5} {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <Button type="submit" size="lg" className="mt-6" disabled={submitting}>
                  {submitting ? (
                    <>
                      <Loader2 className="mr-2 size-4 animate-spin" /> Sending…
                    </>
                  ) : (
                    "Send Message"
                  )}
                </Button>
              </form>
            </Form>
          )}
        </div>

        <aside className="space-y-5">
          <ContactDetails />

          <div className="border-border bg-sand rounded-2xl border p-6">
            <p className="font-display text-xl">Faster routes</p>
            <ul className="mt-3 space-y-2 text-sm">
              <li>
                <Link to="/account/orders" className="underline underline-offset-4">
                  Track an order
                </Link>{" "}
                <span className="text-muted-foreground">— status without asking us</span>
              </li>
              <li>
                <Link to="/business/rfqs/new" className="underline underline-offset-4">
                  Request bulk pricing
                </Link>{" "}
                <span className="text-muted-foreground">— numbered and trackable</span>
              </li>
              <li>
                <Link to="/gifting" className="underline underline-offset-4">
                  Corporate gifting brief
                </Link>{" "}
                <span className="text-muted-foreground">— boxes, branding, dates</span>
              </li>
              <li>
                <Link to="/faq" className="underline underline-offset-4">
                  FAQs
                </Link>{" "}
                <span className="text-muted-foreground">— ordering, shipping, returns</span>
              </li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Write `test/contact-api.stub.ts`**

```typescript
// frontend/src/test/contact-api.stub.ts
import {
  PHONE_REGEX,
  type CreateContactMessageRequest,
  type SupportTicketSummary,
} from "@nutwala/shared";

/**
 * `POST /contact`, for the route tests — the eighth handler `installAuthStub` delegates to.
 * No CSRF modelled, matching the RFQ stub's own note: `installAuthStub` holds no cookie for a
 * visitor with no session, and this route is reachable by exactly that visitor. The real proof
 * this route carries the header lives in `support-tickets.integration.spec.ts`.
 */
const PREFIX = "/contact";

let sequence = 0;
let submittedBodies: CreateContactMessageRequest[] = [];
let failNext: { status: number; message: string } | null = null;

export function resetContactStub(): void {
  sequence = 0;
  submittedBodies = [];
  failNext = null;
}

/** Every `POST /contact` body the client has sent, in order. */
export function contactSubmissions(): CreateContactMessageRequest[] {
  return submittedBodies;
}

/** Arranges the next submission to answer with a server failure instead of succeeding. */
export function failNextContactSubmission(status: number, message: string): void {
  failNext = { status, message };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mintTicketNumber(now: Date): string {
  sequence += 1;
  return `ST-${String(now.getFullYear())}-${String(100_000 + sequence)}`;
}

const CONTACT_FIELDS = new Set(["name", "email", "phone", "topic", "orderNumber", "message"]);

/** `CreateContactMessageDto`, decorator for decorator — `rfq-api.stub.ts`'s own convention. */
function contactErrors(raw: unknown): Record<string, string[]> {
  if (typeof raw !== "object" || raw === null) return { body: ["body must be an object"] };
  const dto = raw as Record<string, unknown>;
  const details: Record<string, string[]> = {};

  for (const key of Object.keys(dto)) {
    if (!CONTACT_FIELDS.has(key)) details[key] = [`property ${key} should not exist`];
  }

  if (typeof dto.name !== "string" || dto.name.length < 2 || dto.name.length > 120) {
    details.name = ["name must be longer than or equal to 2 characters"];
  }
  if (typeof dto.email !== "string" || !dto.email.includes("@")) {
    details.email = ["email must be an email"];
  }
  if (dto.phone !== undefined && (typeof dto.phone !== "string" || !PHONE_REGEX.test(dto.phone))) {
    details.phone = ["Enter a valid 10-digit Indian mobile number"];
  }
  if (typeof dto.topic !== "string") {
    details.topic = ["topic must be a string"];
  }
  if (
    dto.orderNumber !== undefined &&
    (typeof dto.orderNumber !== "string" || dto.orderNumber.length > 20)
  ) {
    details.orderNumber = ["orderNumber must be shorter than or equal to 20 characters"];
  }
  if (typeof dto.message !== "string" || dto.message.length < 10 || dto.message.length > 2000) {
    details.message = ["message must be longer than or equal to 10 characters"];
  }

  return details;
}

/** Answers a `POST /contact` request, or `undefined` when the URL is not it, so the caller can
 * offer it to the next handler. */
export function handleContactRequest(
  url: string,
  method: string,
  init: RequestInit | undefined,
): Response | undefined {
  const rest = url.startsWith("/api/v1") ? url.slice("/api/v1".length) : url;
  const [path] = rest.split("?");
  if (path !== PREFIX || method !== "POST") return undefined;

  const where = { path: url, method };

  if (failNext) {
    const { status, message } = failNext;
    failNext = null;
    return json(status, {
      success: false,
      statusCode: status,
      timestamp: "2026-08-26T00:00:00.000Z",
      path: where.path,
      method: where.method,
      message,
    });
  }

  const raw: unknown = JSON.parse(String(init?.body ?? "{}"));
  const details = contactErrors(raw);
  if (Object.keys(details).length > 0) {
    return json(400, {
      success: false,
      statusCode: 400,
      timestamp: "2026-08-26T00:00:00.000Z",
      path: where.path,
      method: where.method,
      message: "Validation failed",
      code: "VALIDATION_FAILED",
      details,
      errorId: "stub-error-id",
      requestId: "stub-request-id",
    });
  }

  const dto = raw as CreateContactMessageRequest;
  submittedBodies.push(dto);
  const summary: SupportTicketSummary = { ticketNumber: mintTicketNumber(new Date()) };
  return json(201, { success: true, data: summary });
}
```

- [ ] **Step 10: Register the stub in `test/auth-api.stub.ts`**

Add the import:

```typescript
import { handleContactRequest, resetContactStub } from "./contact-api.stub";
```

Add `resetContactStub();` alongside the other `reset*Stub()` calls near the top of `installAuthStub`.

Add the dispatch, as the eighth handler, right before the final "Everything else..." fallback comment:

```typescript
      // The eighth handler. Public, unauthenticated, no session to scope by — the same shape
      // `RfqsController`'s two create routes have.
      const contact = handleContactRequest(url, method, init);
      if (contact) return Promise.resolve(contact);

```

(Insert it after the `business` block and before the `// Everything else in the frontend still goes through src/mocks...` comment.)

- [ ] **Step 11: Add a route test**

In `frontend/src/test/routes.smoke.test.tsx`, add the import:

```typescript
import { contactSubmissions } from "./contact-api.stub";
```

Add a new test near the existing `"offers a contact form and says so plainly when no contact details are configured"` test:

```typescript
  it("submits the contact form to the real endpoint and shows the ticket number back", async () => {
    await renderAt("/contact");
    await screen.findByRole("heading", { name: "Talk to us", level: 1 }, { timeout: 5000 });

    await userEvent.type(screen.getByLabelText("Your name"), "Asha Menon");
    await userEvent.type(screen.getByLabelText("Email"), "asha@demo.in");
    await userEvent.selectOptions(
      screen.getByLabelText("What is this about?"),
      "Bulk and wholesale pricing",
    );
    await userEvent.type(
      screen.getByLabelText("Message"),
      "We would like a bulk quote for 200kg of almonds a month.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send Message" }));

    await screen.findByRole("status", {}, { timeout: 5000 });
    expect(screen.getByText(/Quote it if you follow up/)).toBeTruthy();
    expect(contactSubmissions()).toEqual([
      {
        name: "Asha Menon",
        email: "asha@demo.in",
        topic: "Bulk and wholesale pricing",
        message: "We would like a bulk quote for 200kg of almonds a month.",
      },
    ]);
  }, 20000);
```

(Match this file's own existing import of `userEvent` — it is already imported for other form-submission tests elsewhere in the file; do not add a second import.)

- [ ] **Step 12: Run the frontend test suite**

Run: `npm run test -w frontend`
Expected: all tests pass, including the new one and the unmodified existing contact-form test.

- [ ] **Step 13: Typecheck, lint, format**

Run: `npm run typecheck -w frontend && npm run lint -w frontend && npm run format:check -w frontend`
Expected: all clean.

- [ ] **Step 14: Commit**

```bash
git add frontend/src/features/contact frontend/src/features/content \
  frontend/src/routes/contact.tsx frontend/src/test/contact-api.stub.ts \
  frontend/src/test/auth-api.stub.ts frontend/src/test/routes.smoke.test.tsx
git commit -m "feat(contact): the form posts to the real endpoint, and the mock dies"
```

---

### Task 11: Milestone 8 verification

**Files:**
- Modify: `docs/superpowers/plans/2026-08-26-nuts-nazaakat-notifications.md` (this file — append a completion record)

- [ ] **Step 1: Run the whole backend unit suite**

Run: `npm run test -w backend`
Expected: every suite passes. Record the exact `Test Suites: N passed, N total` / `Tests: M passed, M total` line.

- [ ] **Step 2: Run the whole backend integration suite, twice**

Run: `npm run test:integration -w backend` (twice, back to back)
Expected: both runs pass with identical counts. If either run shows a suite failing that the other does not, treat it the same way this project's own precedent does — a one-off timing flake is tolerated only if a clean back-to-back rerun confirms it, and must be named explicitly in Step 6's write-up rather than silently ignored.

- [ ] **Step 3: Run the shared and frontend suites**

Run: `npm run test -w @nutwala/shared && npm run test -w frontend`
Expected: both pass.

- [ ] **Step 4: Typecheck, lint and format-check every workspace**

Run: `npm run typecheck -w backend && npm run typecheck -w frontend && npm run lint -w backend && npm run lint -w frontend && npm run format:check -w backend && npm run format:check -w frontend`
Expected: all clean.

- [ ] **Step 5: Mutation-test the pieces this milestone's own correctness rests on**

Follow the mutation-testing discipline this project has used since Milestone 7: apply one mutation at a time by editing the file, confirm the relevant test(s) fail, then revert by re-editing back to the exact original text — **never** by `git checkout`/`git stash` on a file with other uncommitted changes in flight, and if scripting the edit, always assert the search pattern matches exactly once before writing, to avoid the exact silent-wrong-location corruption this project hit twice in Milestone 7.

At minimum, mutate and confirm a failing test for each of:

1. **`checkLowStock`'s crossing formula** (`backend/src/modules/inventory/check-low-stock.ts`) — flip `previous >= input.lowStockThreshold` to `previous > input.lowStockThreshold`. Expected: the "does not treat landing exactly on the threshold as low" test in `check-low-stock.spec.ts` starts failing (a drop from exactly-at-threshold to one below would now also fire). Revert; confirm it passes again.
2. **`checkLowStock`'s strict inequality on the low side** — flip `input.onHand < input.lowStockThreshold` to `input.onHand <= input.lowStockThreshold`. Expected: the same test fails for the opposite reason (landing exactly on the threshold now counts as low). Revert.
3. **`NotificationsService.queue`'s error-swallow path** (`backend/src/modules/notifications/notifications.service.ts`) — remove the `try`/`catch` around `this.driver.send(notification)`. Expected: "treats a driver that throws the same as a reported error" in `notifications.service.spec.ts` fails (the promise now rejects instead of resolving). Revert.
4. **`OrderStatusService`'s shipped/delivered gate** (`backend/src/modules/orders/order-status.service.ts`) — change `to === 'shipped' || to === 'delivered'` to just `to === 'shipped'`. Expected: "queues order.delivered when an out-for-delivery order is delivered" in `order-status.service.spec.ts` fails. Revert.
5. **The `lowStockThreshold` addition to `sell`'s `RETURNING` clause** (`backend/src/modules/checkout/checkout.service.ts`) — remove `, "lowStockThreshold"` from both the `RETURNING` and outer `SELECT`. Expected: this cannot fail any *unit* test (the double answers whatever row shape the test gives it regardless), which is worth recording plainly rather than papering over — it is exactly the shape of gap `sell`'s own docblock already documents for the `onHand` field once before (unit doubles cannot see a driver-shape mismatch). Confirm instead that the **integration** test added in Task 5 ("queues stock.low when a placement takes a variant across its threshold") fails with this mutation in place, then revert.

For each, note in Step 6's write-up: which test caught it, and for mutation 5, the explicit statement that only the integration suite — not the unit suite — proves this one, matching the honesty this project's Milestone 7 commits already modelled for the mutations that could not be unit-killed.

- [ ] **Step 6: Append a "Milestone 8 complete" section to this plan document**

Add a section at the end of this file recording: the exact test counts from Steps 1–3, the mutation-testing results from Step 5 (including which mutations were unit-caught vs. integration-only), any flake observed in Step 2 and how it was confirmed benign, and a short list of anywhere this plan's own text turned out to be wrong or needed a judgment call during implementation (e.g. the `RfqStatusService` options-parameter deviation from Task 3, the `order.shipped`/`order.delivered` template names invented in Task 6, the `rfq.status-changed` unconditional-queue choice in Task 3) — matching the honesty precedent `2026-08-22-nuts-nazaakat-b2b.md`'s own "Milestone 7 complete" section set.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/plans/2026-08-26-nuts-nazaakat-notifications.md
git commit -m "docs(notifications): Milestone 8 complete — verification record for Task 11"
```

---

## Milestone 8 complete

Executed 2026-08-26, Tasks 1–10 in order, one commit per task (`da7bfce` … `3c22b06`), plus this
record. Every count below is from Task 11's own runs on a clean tree, not carried forward from the
task that produced it.

| Suite | Entering this milestone | Leaving it |
| --- | --- | --- |
| shared | 62 / 5 | **71 passed / 6 files** |
| backend unit | 901 / 67 | **943 passed / 74 suites** |
| backend integration | 377 / 18 | **398 passed / 21 suites** |
| frontend | 263 / 14 | **266 passed / 14 files** |

1,678 tests in total. The "entering" column is quoted from `2026-08-22-nuts-nazaakat-b2b.md`'s own
"Milestone 7 complete" table rather than re-measured — there is no commit left on this branch at
which to measure it without checking one out.

### Steps 1–3, verbatim

- **Step 1** — `npm run test -w backend`: `Test Suites: 74 passed, 74 total` /
  `Tests: 943 passed, 943 total`, 21.7 s.
- **Step 2** — `npm run test:integration -w backend`, twice back to back. Run 1:
  `Test Suites: 21 passed, 21 total` / `Tests: 398 passed, 398 total`, 184.4 s. Run 2: identical
  counts, 197.7 s. Both runs also wrote a `--json --outputFile` report, and both report
  `numFailedTests: 0`.
- **Step 3** — `npm run test -w @nutwala/shared`: `Test Files 6 passed (6)` /
  `Tests 71 passed (71)`. `npm run test -w frontend`: `Test Files 14 passed (14)` /
  `Tests 266 passed (266)`.

### Step 4

All six commands exit 0: `typecheck -w backend`, `typecheck -w frontend`, `lint -w backend`,
`lint -w frontend`, `format:check -w backend`, `format:check -w frontend`. Both Prettier checks
answer "All matched files use Prettier code style!".

Two pre-existing warnings remain, unchanged and deliberately not fixed here (`docs/known-issues.md`
item 2): `backend/test/integration/rfq-status.integration.spec.ts:154` unsafe `any` assignment and
`:156` unsafe member access, both from Task 3's `af14187`. ESLint still exits 0 — they are
warnings, not errors. The frontend's oxlint run emits 59 `react(only-export-components)` warnings;
that rule fires on essentially every route file and 59 is the stable whole-repo count, none of it
new this milestone.

Root `npm run lint` is exactly the composition of the two lint commands above, so it is covered by
them. Root `npm run build` was deliberately not part of Step 4 — the step does not ask for it, and
Milestone 7's own record explains the hazard: it chains into `nest build`, and `nest-cli.json` sets
`deleteOutDir: true`, which is destructive while a `nest start --watch` may be holding
`backend/dist`.

### The flake in Step 2: not seen

`docs/known-issues.md` item 1 records an intermittent integration failure at roughly two runs in
fifteen. **Neither of Step 2's two runs failed anything** — 398/398 both times, with the JSON
reports agreeing — so there was no flake in Step 2 to confirm benign. Two things worth recording
regardless:

- The one red full-suite run captured during this session's earlier baseline sweep (seven runs, one
  at 388/389) was **the same test at the same line** as the failure already written into
  `known-issues.md`: `cart › POST /cart/validate › validates the stored cart when sent an empty
  array`, `expected 200 "OK", got 400 "Bad Request"` at `cart.integration.spec.ts:785` — the
  arrange step's `PUT /cart`, not the assertion the test exists to make. It adds nothing new to
  that entry, and in particular the **response body still was not captured**: supertest's
  `_assertStatus` message carries the status and nothing else. That entry's closing step 2 (log the
  `PUT /cart` response body on a captured failure) is therefore still the open one, and it needs a
  deliberate `.expect(200)` → response-body-logging change in the spec, not just more runs.
- Adding `--json --outputFile=…` to the integration command, as that entry's closing step 1 asks,
  costs nothing and makes the pass/fail record durable instead of scrollback. Recommended as the
  default for any future full-suite verification run in this repository.

### Step 5: mutation testing

Five mutations, applied strictly one at a time. Each was reverted by re-editing the exact original
text — never `git checkout`, `git stash` or `git restore` — and every revert was verified
byte-identical to `HEAD` with `git hash-object` against the blob hash recorded before the mutation,
not merely by eye. Every edit went through a helper that refuses to write unless the search pattern
matches **exactly once**, which is what the silent wrong-location corruption in Milestone 7 cost.

| # | Mutation | Test that caught it | Level |
| --- | --- | --- | --- |
| 1 | `check-low-stock.ts`: `previous >= input.lowStockThreshold` → `previous >` | `checkLowStock › notifies on the exact step that drops one unit below the threshold` | unit |
| 2 | `check-low-stock.ts`: `input.onHand < input.lowStockThreshold` → `<=` | `checkLowStock › does not treat landing exactly on the threshold as low` | unit |
| 3 | `notifications.service.ts`: the `try`/`catch` around `driver.send` removed | `NotificationsService.queue › treats a driver that throws the same as a reported error, rather than rejecting` **and** `… › handles a driver that throws something other than an Error` | unit |
| 4 | `order-status.service.ts`: `to === 'shipped' \|\| to === 'delivered'` → `to === 'shipped'` | `OrderStatusService.transition — notifications › queues order.delivered when an out-for-delivery order is delivered` | unit |
| 5 | `checkout.service.ts`: `, "lowStockThreshold"` removed from the `RETURNING` **and** the outer `SELECT` | `checkout › placement, happy path › queues stock.low when a placement takes a variant across its threshold` | **integration only** |

**Mutation 5 is the honest one, and it behaved exactly as Step 5 predicted.** With the column
dropped from both clauses the *entire* backend unit suite stays green — measured, not assumed:
`Test Suites: 74 passed, 74 total` / `Tests: 943 passed, 943 total` with the mutation in place.
**Only the integration suite proves this one; no unit test can.** The doubles answer whatever row
shape the test hands them regardless of what the SQL asked for, so `rows[0]?.lowStockThreshold` is
`undefined` only against a real driver — and then `Number(undefined)` is `NaN`, `previous >= NaN` is
false, and `checkLowStock` silently stops firing forever. This is the same class of gap `sell`'s own
docblock already records for `onHand`: the bare-`UPDATE … RETURNING` tuple quirk that made every
successful decrement throw `OUT_OF_STOCK` while every unit test stayed green. Task 5's integration
test kills it on the first run — `expect(rows).toHaveLength(1)` receives `[]`. Recorded plainly
rather than papered over, matching what Milestone 7's record did for its own unkillable mutations.

**Mutation 1's expected outcome, as this plan wrote it, is wrong twice over.** Step 5 predicts that
`>=` → `>` makes *"does not treat landing exactly on the threshold as low"* fail, "because a drop
from exactly-at-threshold to one below would now also fire". Both halves are backwards. Tightening
`>=` to `>` makes the gate *stricter*, so it fires *less*, never more; and the named test (delta
`-1`, `onHand` 10, threshold 10, so `previous` is 11) is unaffected either way, because its
`onHand < threshold` half is already false. Measured: that test stays green, and the one that
actually dies is *"notifies on the exact step that drops one unit below the threshold"* (delta `-1`,
`onHand` 9, threshold 10, so `previous` is exactly 10 — `10 > 10` is false and the notification is
lost). The mutation is caught; the plan named the wrong witness for the wrong reason. Step 5's
prediction for mutation 2 is correct as written.

Two incidental findings from the same runs. Mutation 3 kills **two** tests, not the one Step 5
names — the second, *"handles a driver that throws something other than an Error"*, exercises the
same `catch` down its non-`Error` branch. And mutations 1 and 2 are both observable at the
integration level too, through `inventory › queues stock.low exactly when the adjustment crosses
the threshold, and only then`, which drives three real adjustments through `PATCH` and asserts
`toHaveLength(1)` across all three; the unit tests are simply the cheaper witness for the same
property.

### Where this plan's own text was wrong, or needed a judgment call

- **Task 6 broke two module specs the plan never mentions.** Its file list names only
  `order-status.service.ts`, that spec, `orders.module.ts` and the orders integration spec. Adding
  `NotificationsModule` to `OrdersModule` pulled `LoggingModule` into those graphs, and
  `LoggingModule` provides `WINSTON_LOGGER` through a `useFactory` with `inject: [ConfigService]` —
  which neither `orders.module.spec.ts` nor `business/businesses.module.spec.ts` provides, so both
  failed to compile their testing module. Fixed with the same `.overrideProvider(WINSTON_LOGGER)`
  stub Task 3 had already been forced to add to `rfqs.module.spec.ts`; all three specs now carry
  it, and `orders.module.spec.ts`'s own docblock records the error message verbatim. Note the path
  for anyone grepping: the businesses spec lives under `modules/business/`, singular.
- **Task 8's new test would have asserted against `undefined`.** The `rfqs.service.spec.ts`
  harness's `save` fake answered only `{ id, rfqNumber }`, but `create` now reads `businessName`,
  `email` and `kind` off the saved row to build the `rfq.received` payload. Left as the plan wrote
  it, *"queues rfq.received with the business name, email and kind"* would have passed while
  asserting three `undefined`s against three `undefined`s. The fake was widened to echo the row it
  is given; the spec's comment at its `save` fake records why.
- **Two integration fixtures had to be rewritten, because the plan's own text breaks the ledger
  invariant.** Task 5 and Task 7 both drive stock with a raw
  `UPDATE inventory SET "onHand" = $1 WHERE variant_id = $2`. That directly contradicts the
  `setStock` docblock already in `checkout-concurrency.integration.spec.ts`: a column write with no
  matching ledger row leaves `SUM(inventory_transactions.delta) ≠ inventory.onHand`, which is the
  invariant `inventory.integration.spec.ts` (its `drift()` helper) and
  `schema-invariants.integration.spec.ts` both exist to protect — so the fixture would have made
  the assertion measure its own breakage. Both were rewritten to go through
  `InventoryService.adjust`: `checkout.integration.spec.ts` gained its own `setStock` copy, and the
  inventory test drives all three of its steps through `PATCH`, closing with
  `expect(await drift()).toEqual([])`.
- **Task 7 made `lowStockThreshold` required on `StockRow`** — the local fixture interface in
  `inventory.service.spec.ts` — which broke three pre-existing fixture call sites: the `harness`
  default, the two-row multi-variant fixture and the reserved-floor fixture. All three now say
  `10`, chosen so that no pre-existing test's quantities cross it; those tests are about the
  column, the ledger and the SQL, and must not start asserting on notifications by accident. The
  plan's file list does not anticipate the churn.
- **Task 9 Step 15 shipped a test that could not pass.** The integration spec it supplies imports
  `TEST_PASSWORD` from `test/factories/user.factory`, but the account it signs in (`b2c@demo.in`)
  is created by `seedUsers`, which hashes an unexported `DEV_PASSWORD` (`'Password123!'`);
  `TEST_PASSWORD` is `'Kaju1kgPlease'`. First run answered 401. Fixed the way every other
  integration spec that signs in a *seeded* account already does — a local `SEEDED_PASSWORD`
  constant with a comment saying why it is spelled out as a literal.
- **Task 9 Step 4's expected count is off by one.** It says "Expected: 6 passed"; the
  `ticket-number.spec.ts` that the preceding steps supply has 7 `it` blocks. A worker trusting the
  number over the file would have gone hunting for a test that was never missing.
- **The older backend design spec §11 contradicts this milestone's spec in three ways,** and the
  newer spec was followed each time: the endpoint (`POST /support/tickets` vs `POST /contact`), the
  reference prefix (`SUP-2026-NNNNNN` vs `ST-{year}-{6 digits}`), and a customer read path
  (`GET /support/tickets`, "signed-in customers see their tickets") that the notifications spec
  explicitly defers ("No read routes this milestone"). The prefix was not genuinely open by the
  time Task 9 ran: `TICKET_NUMBER_PATTERN = /^ST-\d{4}-\d{6,}$/` had already shipped in
  `shared/src/constants/identifiers.ts` in Task 1 (`da7bfce`) with its own tests, so `SUP-` would
  have meant reopening a committed, tested contract. Recorded because §11 is still on disk saying
  otherwise, and the next reader will find it before they find this.
- **`support.received` is not in the client brief's own notification list.** Brief §38 names eight
  triggers — order confirmation, payment confirmation, order shipped, order delivered, RFQ
  received, quote sent, abandoned cart, low stock — and support-ticket received is not among them.
  It reads as a floor ("Architecture supports: …"), not a whitelist, so it was treated as an
  addition rather than a contradiction; but the addition comes from the design spec, not from the
  client. The same standing, less visibly, applies to `rfq.status-changed`.
- **Three template names were invented rather than specified.** The design spec's trigger table
  names only four: `order.confirmed`, `rfq.received`, `support.received`, `stock.low`.
  `order.shipped` and `order.delivered` (Task 6) and `rfq.status-changed` (Task 3) exist because
  the brief names those *events* in prose and the plan needed identifiers. They are now a de facto
  contract that a real driver's template lookup will key on, and nothing outside the code records
  them.
- **`RfqStatusService.transition` deliberately does not match its sibling's signature.**
  `OrderStatusService.transition(orderNumber, to, options)` carries `note` and `restock`; the RFQ
  version takes `(rfqNumber, to)` with no options bag, because there is no `RfqEvent` timeline for
  a note to land on and no stock to make a judgement about. The plan wrote that justification into
  the docblock in advance, so this is a documented deviation rather than a discovery — but it is
  exactly the kind of asymmetry between two sibling services that reads as an oversight later,
  which is why it is repeated here.
- **`rfq.status-changed` is queued on every legal transition, unconditionally** — unlike orders,
  where only `shipped` and `delivered` notify. The reason, stated in both services' docblocks: an
  RFQ's every step *is* the pipeline the customer is waiting on, whereas an order's intermediate
  steps are operational. That is a judgement, not a spec requirement, and its cost is that an admin
  working an RFQ back and forth generates one notification per click.
- **The contact form had no error UI at all, and the plan did not notice.** `onSubmit` awaited
  `mutateAsync` with nothing catching it, and react-hook-form's `handleSubmit` swallows whatever
  `onSubmit` throws — so a failed send left the form sitting there silently. That became the
  *likely* outcome rather than an edge case the moment the route sat behind an endpoint throttled
  at 5/hour/IP. Fixed after Task 10 in `3c22b06`: the 429 is branched on `error.status` rather than
  a `code`, because a `ThrottlerException` is not a `DomainError` and carries nothing
  machine-readable (`ApiRequestError`'s own docblock in `lib/http.ts` says so); a 500 gets
  different copy; and the typed message survives the failure so it can be retried. That commit
  also gave `failNextContactSubmission` its first two callers — Task 10 added the helper to the
  stub and then nothing ever used it. Both new tests were confirmed non-vacuous by removing the
  `catch` and watching exactly those two fail and nothing else.
- **Mutation 1's predicted failing test in Step 5 is wrong**, in both the test it names and the
  reason it gives — see the Step 5 section above.
- **Four of this milestone's commits belong to no task's file list**: `a3a2252` (fixing
  contradictory barrel-order wording in the plan itself), `af14187` (a concurrency test for
  `RfqStatusService` beyond Task 3's steps), `a608694` (`docs/known-issues.md`, created to hold the
  integration flake and two other open issues) and `3c22b06` (the contact-form error UI above).
  Worth noting only because a reader reconciling the plan against `git log` will otherwise wonder
  where they came from.
