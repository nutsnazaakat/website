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
