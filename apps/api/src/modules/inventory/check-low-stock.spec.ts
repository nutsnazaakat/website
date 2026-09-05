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
