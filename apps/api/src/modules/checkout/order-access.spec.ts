import { canReadReceipt, orderAccessToken } from './order-access';
import type { Order } from '../../entities/commerce/order.entity';
const secret = 'test-receipt-secret';
const order = { id: 'id-1', orderNumber: 'NN-1', placedAt: new Date() } as Order;
it('binds receipt access to the exact order and secret', () => {
  const token = orderAccessToken(order, secret);
  expect(canReadReceipt(order, token, secret)).toBe(true);
  expect(canReadReceipt({ ...order, id: 'id-2' } as Order, token, secret)).toBe(false);
  expect(canReadReceipt(order, token, 'other')).toBe(false);
  expect(canReadReceipt(order, undefined, secret)).toBe(false);
  expect(canReadReceipt(order, '00', secret)).toBe(false);
});
it('expires even a valid receipt signature after thirty days', () => {
  const expired = { ...order, placedAt: new Date(Date.now() - 31 * 86400000) } as Order;
  expect(canReadReceipt(expired, orderAccessToken(expired, secret), secret)).toBe(false);
});
