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

  send(notification: Notification): Promise<{ sentAt: Date }> {
    this.logger.log('Notification (logging driver — no real delivery configured yet)', {
      event: 'notification.logged',
      notificationId: notification.id,
      userId: notification.userId,
      channel: notification.channel,
      template: notification.template,
      payload: notification.payload,
    });
    return Promise.resolve({ sentAt: new Date() });
  }
}
