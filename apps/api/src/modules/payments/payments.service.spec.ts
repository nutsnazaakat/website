import { ConfigService } from '@nestjs/config';
import type { DataSource, EntityManager } from 'typeorm';
import { Payment } from '../../entities/commerce/payment.entity';
import { Order } from '../../entities/commerce/order.entity';
import { OrderEvent } from '../../entities/commerce/order-event.entity';
import { PaymentMethodEnum, PaymentStatusEnum } from '../../entities/enums';
import type { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from './payments.service';
import type { RazorpayService } from './razorpay.service';

function harness(cancelled = false) {
  const order = {
    id: 'o1',
    orderNumber: 'NN-1',
    totalPaise: 12000n,
    paymentMethod: PaymentMethodEnum.ONLINE,
    paymentStatus: PaymentStatusEnum.PENDING,
    status: cancelled ? 'cancelled' : 'pending',
    addressSnapshot: { email: 'customer@example.test' },
    userId: null,
  };
  const payment = {
    id: 'p1',
    orderId: 'o1',
    gatewayOrderId: 'order_1',
    amountPaise: 12000n,
    method: PaymentMethodEnum.ONLINE,
    status: PaymentStatusEnum.PENDING,
    reference: null as string | null,
  };
  const updatePayment = jest.fn((_id, patch) => {
    Object.assign(payment, patch);
  });
  const updateOrder = jest.fn((_id, patch) => {
    Object.assign(order, patch);
  });
  const event = jest.fn();
  const queue = jest.fn();
  const manager = {
    getRepository: (entity: unknown) => {
      if (entity === Payment)
        return {
          findOne: jest.fn(async () => payment),
          findOneByOrFail: jest.fn(async () => payment),
          update: updatePayment,
        };
      if (entity === Order)
        return { findOneOrFail: jest.fn(async () => order), update: updateOrder };
      if (entity === OrderEvent) return { insert: event };
      throw new Error('Unexpected repository');
    },
  } as unknown as EntityManager;
  const db = {
    transaction: (run: (manager: EntityManager) => Promise<void>) => run(manager),
  } as unknown as DataSource;
  const service = new PaymentsService(
    db,
    new ConfigService(),
    {} as RazorpayService,
    { queue } as unknown as NotificationsService,
  );
  return { service, order, payment, updatePayment, updateOrder, event, queue };
}
const captured = {
  id: 'pay_1',
  order_id: 'order_1',
  amount: 12000,
  currency: 'INR',
  status: 'captured',
};
it('records capture once across duplicate delivery', async () => {
  const h = harness();
  await h.service.settle(captured);
  await h.service.settle(captured);
  expect(h.payment.status).toBe(PaymentStatusEnum.COLLECTED);
  expect(h.updatePayment).toHaveBeenCalledTimes(1);
  expect(h.queue).toHaveBeenCalledTimes(1);
});
it.each([{ amount: 1 }, { currency: 'USD' }, { status: 'authorized' }, { amount: 12000.5 }])(
  'rejects mismatched or uncollected money: %j',
  async (patch) => {
    const h = harness();
    await expect(h.service.settle({ ...captured, ...patch })).rejects.toThrow();
    expect(h.updatePayment).not.toHaveBeenCalled();
    expect(h.updateOrder).not.toHaveBeenCalled();
  },
);
it('records a late capture for refund review without resurrecting a cancelled order', async () => {
  const h = harness(true);
  await h.service.settle(captured);
  expect(h.order.status).toBe('cancelled');
  expect(h.event).toHaveBeenCalledWith(
    expect.objectContaining({
      status: 'cancelled',
      note: expect.stringContaining('Refund review'),
    }),
  );
  expect(h.queue).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ template: 'payment.review' }),
  );
});
it('refuses a second payment reference against an already paid order', async () => {
  const h = harness();
  await h.service.settle(captured);
  await expect(h.service.settle({ ...captured, id: 'pay_2' })).rejects.toThrow();
  expect(h.updatePayment).toHaveBeenCalledTimes(1);
});
