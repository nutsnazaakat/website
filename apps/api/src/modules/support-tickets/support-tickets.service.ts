import { Injectable } from '@nestjs/common';
import { DataSource, type DeepPartial } from 'typeorm';
import { NotificationChannel } from '../../entities/enums';
import { SupportTicket } from '../../entities/ops/support-ticket.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { nextTicketNumber } from './ticket-number';

export interface CreateSupportTicketInput {
  name: string;
  email: string;
  phone?: string;
  topic: string;
  orderNumber?: string;
  message: string;
}

/**
 * The contact form's real backend. `create` is the only write this milestone needs — no route
 * reads a ticket back yet, matching how a prospect's RFQ has no read path until they sign in.
 *
 * No `TypeOrmModule.forFeature`: like `RfqsService`, this takes the `DataSource` and does
 * everything through one transaction's `EntityManager`. Unlike `RfqsService.create`, there is no
 * cascaded relation to reload afterwards — a ticket has no lines and no gifting detail this
 * milestone — so `save()`'s own return value is already the complete row.
 */
@Injectable()
export class SupportTicketsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  async create(input: CreateSupportTicketInput, userId: string | null): Promise<SupportTicket> {
    return this.dataSource.transaction(async (manager) => {
      const ticketNumber = await nextTicketNumber(manager);

      const draft: DeepPartial<SupportTicket> = {
        ticketNumber,
        userId,
        name: input.name,
        email: input.email,
        phone: input.phone ?? null,
        topic: input.topic,
        orderNumber: input.orderNumber ?? null,
        message: input.message,
        status: 'new',
        priority: 2,
        assignedToUserId: null,
        resolvedAt: null,
      };

      const saved = await manager.getRepository(SupportTicket).save(draft);

      await this.notifications.queue(manager, {
        userId,
        channel: NotificationChannel.EMAIL,
        template: 'support.received',
        payload: { ticketNumber: saved.ticketNumber, email: saved.email, topic: saved.topic },
      });

      return saved;
    });
  }
}
