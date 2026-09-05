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

  const service = new NotificationsService(driver);
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

    expect(updates[0]?.patch.error).toHaveLength(300);
  });

  it('handles a driver that throws something other than an Error', async () => {
    const { service, manager, updates } = harness(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'a plain string, not an Error';
    });

    await service.queue(manager as never, INPUT);

    expect(updates[0]?.patch.error).toBe('a plain string, not an Error');
  });
});
