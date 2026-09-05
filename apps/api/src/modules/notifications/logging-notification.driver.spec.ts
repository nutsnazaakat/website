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
    setContext: () => logger as unknown as WinstonLoggerService,
    log: (message: string, meta?: unknown) => void entries.push({ message, meta }),
    error: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
  };
  return logger as unknown as WinstonLoggerService & { entries: RecordedLog[] };
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
