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
