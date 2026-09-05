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
      await manager
        .getRepository(Notification)
        .update(
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
