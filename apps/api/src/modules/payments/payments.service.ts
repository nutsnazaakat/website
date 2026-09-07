import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, type EntityManager } from 'typeorm';
import { Order } from '../../entities/commerce/order.entity';
import { Payment } from '../../entities/commerce/payment.entity';
import { OrderEvent } from '../../entities/commerce/order-event.entity';
import { NotificationChannel, PaymentMethodEnum, PaymentStatusEnum } from '../../entities/enums';
import { canReadReceipt } from '../checkout/order-access';
import { toAccountOrder } from '../orders/mappers/order.mapper';
import { NotificationsService } from '../notifications/notifications.service';
import { RazorpayService, type GatewayPayment } from './razorpay.service';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: DataSource,
    private readonly config: ConfigService,
    private readonly gateway: RazorpayService,
    private readonly notifications: NotificationsService,
  ) {}
  private async owned(manager: EntityManager, number: string, token?: string) {
    const order = await manager.getRepository(Order).findOne({ where: { orderNumber: number } });
    if (
      !order ||
      !canReadReceipt(order, token, this.config.getOrThrow<string>('app.auth.jwtSecret'))
    )
      throw new ForbiddenException('This order link is not available in this browser.');
    return order;
  }
  async receipt(number: string, token?: string) {
    const order = await this.owned(this.db.manager, number, token);
    const full = await this.db
      .getRepository(Order)
      .findOneOrFail({
        where: { id: order.id },
        relations: { items: true, events: true },
        order: { items: { id: 'ASC' } },
      });
    return toAccountOrder(full);
  }
  async start(number: string, token?: string) {
    return this.db.transaction(async (manager) => {
      const owned = await this.owned(manager, number, token);
      const order = await manager
        .getRepository(Order)
        .findOneOrFail({ where: { id: owned.id }, lock: { mode: 'pessimistic_write' } });
      if (
        order.paymentMethod !== PaymentMethodEnum.ONLINE ||
        order.status !== 'pending' ||
        order.paymentStatus !== PaymentStatusEnum.PENDING
      )
        throw new BadRequestException('This order does not require an online payment.');
      const payment = await manager
        .getRepository(Payment)
        .findOneOrFail({ where: { orderId: order.id }, order: { createdAt: 'DESC' } });
      const amount = Number(order.totalPaise);
      if (!payment.gatewayOrderId) {
        const remote = await this.gateway.createOrder(amount, order.orderNumber);
        if (
          !/^order_[a-zA-Z0-9]+$/.test(remote.id) ||
          remote.amount !== amount ||
          remote.currency !== 'INR'
        )
          throw new BadRequestException('Payment order did not match the checkout.');
        payment.gatewayOrderId = remote.id;
        await manager.getRepository(Payment).save(payment);
      }
      return {
        keyId: this.gateway.keyId,
        gatewayOrderId: payment.gatewayOrderId,
        amount,
        currency: 'INR' as const,
      };
    });
  }
  async verify(number: string, token: string | undefined, paymentId: string, signature: string) {
    const order = await this.owned(this.db.manager, number, token);
    const payment = await this.db
      .getRepository(Payment)
      .findOneOrFail({ where: { orderId: order.id }, order: { createdAt: 'DESC' } });
    if (!payment.gatewayOrderId)
      throw new BadRequestException('No payment was started for this order.');
    this.gateway.verifySignature(payment.gatewayOrderId, paymentId, signature);
    const remote = await this.gateway.payment(paymentId);
    if (remote.id !== paymentId || remote.order_id !== payment.gatewayOrderId)
      throw new BadRequestException('Payment belongs to a different order.');
    await this.settle(remote);
    return this.receipt(number, token);
  }
  async webhook(body: Buffer, signature?: string) {
    this.gateway.verifyWebhook(body, signature);
    const event = JSON.parse(body.toString('utf8')) as {
      event?: string;
      payload?: { payment?: { entity?: { id?: string } } };
    };
    if (event.event !== 'payment.captured') return { received: true };
    const id = event.payload?.payment?.entity?.id;
    if (!id) throw new BadRequestException('Missing payment.');
    // Fetch the authoritative record even for signed events; never trust browser money.
    await this.settle(await this.gateway.payment(id));
    return { received: true };
  }
  async settle(remote: GatewayPayment): Promise<void> {
    if (
      !/^order_[a-zA-Z0-9]+$/.test(remote.order_id ?? '') ||
      !/^pay_[a-zA-Z0-9]+$/.test(remote.id ?? '')
    )
      throw new BadRequestException('Invalid provider payment.');
    if (remote.status !== 'captured')
      throw new BadRequestException(
        'Payment is awaiting confirmation. Please refresh the order shortly.',
      );
    await this.db.transaction(async (manager) => {
      const payment = await manager
        .getRepository(Payment)
        .findOne({ where: { gatewayOrderId: remote.order_id } });
      if (!payment) throw new NotFoundException('Unknown payment order.');
      // Same lock order as start: order first, then payment update.
      const order = await manager
        .getRepository(Order)
        .findOneOrFail({ where: { id: payment.orderId }, lock: { mode: 'pessimistic_write' } });
      const current = await manager.getRepository(Payment).findOneByOrFail({ id: payment.id });
      if (
        current.method !== PaymentMethodEnum.ONLINE ||
        remote.currency !== 'INR' ||
        !Number.isSafeInteger(remote.amount) ||
        BigInt(remote.amount) !== order.totalPaise ||
        BigInt(remote.amount) !== current.amountPaise
      )
        throw new BadRequestException('Payment amount or currency mismatch.');
      if (current.status === PaymentStatusEnum.COLLECTED) {
        if (current.reference !== remote.id)
          throw new BadRequestException('A different payment is already recorded.');
        return;
      }
      if (current.status !== PaymentStatusEnum.PENDING)
        throw new BadRequestException('Payment needs manual reconciliation.');
      await manager
        .getRepository(Payment)
        .update(current.id, {
          status: PaymentStatusEnum.COLLECTED,
          collectedAt: new Date(),
          reference: remote.id,
        });
      await manager
        .getRepository(Order)
        .update(order.id, { paymentStatus: PaymentStatusEnum.COLLECTED });
      // A late payment must never resurrect a cancelled order or ship restocked inventory.
      await manager
        .getRepository(OrderEvent)
        .insert({
          orderId: order.id,
          status: order.status,
          note:
            order.status === 'cancelled'
              ? 'Payment received after cancellation. Refund review required.'
              : 'Online payment received.',
          actorUserId: null,
        });
      await this.notifications.queue(manager, {
        userId: order.userId,
        channel: NotificationChannel.EMAIL,
        template: order.status === 'cancelled' ? 'payment.review' : 'order.paid',
        payload: { orderNumber: order.orderNumber, email: order.addressSnapshot.email },
      });
    });
  }
}
