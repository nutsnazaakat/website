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
