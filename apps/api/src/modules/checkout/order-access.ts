import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Order } from '../../entities/commerce/order.entity';

export function orderAccessToken(order: Order, secret: string): string {
  return createHmac('sha256', secret)
    .update(`checkout-receipt:${order.id}:${order.orderNumber}:${order.placedAt.toISOString()}`)
    .digest('hex');
}
export function equalSignature(actual: string | undefined, expected: string): boolean {
  if (!actual || !/^[a-f0-9]{64}$/i.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual.toLowerCase(), 'hex'), Buffer.from(expected, 'hex'));
}
export function canReadReceipt(order: Order, token: string | undefined, secret: string): boolean {
  return (
    Date.now() - order.placedAt.getTime() <= 30 * 86400000 &&
    equalSignature(token, orderAccessToken(order, secret))
  );
}
