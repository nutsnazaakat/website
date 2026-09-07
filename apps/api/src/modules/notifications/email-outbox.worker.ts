import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Notification } from '../../entities/ops/notification.entity';
import { NotificationChannel, NotificationStatus } from '../../entities/enums';
import { Order } from '../../entities/commerce/order.entity';
import { User } from '../../entities/identity/user.entity';

const messages: Record<string, string> = {
  'order.confirmed': 'We have received your cash-on-delivery order.',
  'order.awaiting-payment':
    'Your order is reserved and awaiting payment. Complete payment in your checkout tab.',
  'order.paid': 'Your payment has been received. Thank you for shopping with us.',
  'order.shipped': 'Your order has been dispatched.',
  'order.delivered': 'Your order has been marked delivered. Please contact us if you need help.',
  'payment.review':
    'A payment was received after this order was cancelled. Please contact us to arrange a refund.',
  'support.received': 'We have received your enquiry. Our team will review it.',
  'rfq.received': 'We have received your quote request.',
  'rfq.status-changed': 'Your quote request has been updated. Sign in to view the latest details.',
};

/** Deliver only committed rows. Multiple API replicas coordinate with SKIP LOCKED. */
@Injectable()
export class EmailOutboxWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly logger = new Logger(EmailOutboxWorker.name);
  constructor(
    private readonly db: DataSource,
    private readonly config: ConfigService,
  ) {}
  onModuleInit() {
    if (!this.config.get<string>('app.email.apiKey')) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, 10000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async flush() {
    if (this.running) return;
    this.running = true;
    try {
      await this.db.transaction(async (manager) => {
        const repo = manager.getRepository(Notification);
        const rows = await repo
          .createQueryBuilder('n')
          .where('n.status = :status', { status: NotificationStatus.QUEUED })
          .orderBy('n.createdAt', 'ASC')
          .take(5)
          .setLock('pessimistic_write')
          .setOnLocked('skip_locked')
          .getMany();
        for (const row of rows) {
          try {
            if (row.channel !== NotificationChannel.EMAIL || !messages[row.template])
              throw new Error('No delivery adapter for this notification.');
            let email = typeof row.payload.email === 'string' ? row.payload.email : undefined;
            if (!email && typeof row.payload.orderNumber === 'string')
              email = (
                await manager
                  .getRepository(Order)
                  .findOneBy({ orderNumber: row.payload.orderNumber })
              )?.addressSnapshot.email;
            if (!email && row.userId)
              email = (await manager.getRepository(User).findOneBy({ id: row.userId }))?.email;
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
              throw new Error('No valid recipient address.');
            const reference =
              typeof row.payload.orderNumber === 'string' ? row.payload.orderNumber : '';
            const response = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${this.config.get<string>('app.email.apiKey')}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': `notification-${row.id}`,
              },
              body: JSON.stringify({
                from: this.config.get<string>('app.email.from'),
                to: [email],
                subject: `Nuts & Nazaakat${reference ? ` · ${reference}` : ''}`,
                text: `Nuts & Nazaakat\n\n${messages[row.template]}\n${reference ? `\nOrder: ${reference}\n` : ''}`,
              }),
              signal: AbortSignal.timeout(12000),
            });
            if (!response.ok) throw new Error(`Email provider returned ${response.status}.`);
            await repo.update(row.id, {
              status: NotificationStatus.SENT,
              sentAt: new Date(),
              error: null,
            });
          } catch (error) {
            await repo.update(row.id, {
              status: NotificationStatus.FAILED,
              error: (error instanceof Error ? error.message : 'Email failed').slice(0, 300),
            });
          }
        }
      });
    } catch {
      this.logger.error('Email outbox could not complete this batch.');
    } finally {
      this.running = false;
    }
  }
}
