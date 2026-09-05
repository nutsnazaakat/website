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
