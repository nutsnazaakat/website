import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { SupportTicketSummary } from '@nutwala/shared';
import { OptionalUser } from '../../common/auth/decorators/current-user.decorator';
import { Public } from '../../common/auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { CreateContactMessageDto } from './dto/create-contact-message.dto';
import { SupportTicketsService } from './support-tickets.service';

/**
 * `POST /contact` — the contact form's real backend. `@Public()` with `@OptionalUser()`,
 * `RfqsController`'s own reasoning: a visitor needs no account to ask a question, and a
 * signed-in customer's message should still be attributed to them.
 */
@ApiTags('contact')
@Controller('contact')
export class SupportTicketsController {
  constructor(private readonly tickets: SupportTicketsService) {}

  /** Five per hour per IP — `RfqsController`'s own limit, for the identical shape: unauthenticated,
   * writes a row, no account to scope by. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Send a message from the contact form' })
  async create(
    @Body() dto: CreateContactMessageDto,
    @OptionalUser() user: AuthenticatedUser | undefined,
  ): Promise<SupportTicketSummary> {
    const ticket = await this.tickets.create(
      {
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        topic: dto.topic,
        orderNumber: dto.orderNumber,
        message: dto.message,
      },
      user?.id ?? null,
    );
    return { ticketNumber: ticket.ticketNumber };
  }
}
