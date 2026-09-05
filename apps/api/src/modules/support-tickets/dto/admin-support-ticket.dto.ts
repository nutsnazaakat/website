import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  CONTACT_TOPICS,
  SUPPORT_TICKET_STATUSES,
  type ContactTopic,
  type SupportTicketStatus,
} from '@nutwala/shared';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * `GET /admin/support/tickets`' query string — the triage queue's filters.
 *
 * `SUPPORT_TICKET_STATUSES` and `CONTACT_TOPICS` are passed straight to `@IsIn` as the shared
 * readonly tuples, so both vocabularies are declared once and this DTO cannot drift from the
 * contact form that writes them.
 *
 * **There is no "unassigned" filter**, deliberately, and it is the one an operator would ask for
 * next: `assignedToUserId` is nullable, so "unassigned" is a third state a uuid parameter cannot
 * express, and a magic value (`?assignedToUserId=none`) would be a string outside the uuid format
 * that `@IsUUID` exists to enforce. The honest shape is a separate boolean parameter, and it is
 * left out rather than guessed — `forbidNonWhitelisted` means adding one later is a safe change.
 */
export class AdminSupportTicketQueryDto {
  /** Omitted means every status, including resolved and closed. */
  @ApiPropertyOptional({ enum: SUPPORT_TICKET_STATUSES, example: 'new' })
  @IsOptional()
  @IsIn(SUPPORT_TICKET_STATUSES)
  status?: SupportTicketStatus;

  @ApiPropertyOptional({ enum: CONTACT_TOPICS, example: 'Bulk and wholesale pricing' })
  @IsOptional()
  @IsIn(CONTACT_TOPICS)
  topic?: ContactTopic;

  /** One agent's queue. */
  @ApiPropertyOptional({ example: '5f9b2c1e-0000-4000-8000-000000000000' })
  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toQueryNumber(value))
  @IsInt()
  @Min(1)
  page?: number;

  /** Capped at 60, matching every other admin list. The service clamps as well. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toQueryNumber(value))
  @IsInt()
  @Min(1)
  @Max(60)
  limit?: number;
}

/**
 * `PATCH /admin/support/tickets/:ticketNumber` — status, priority and assignment.
 *
 * **No state machine, unlike an order.** `@nutwala/shared` validates order transitions through
 * per-channel maps because a shipped order cannot become unpaid; nothing of the sort exists for
 * `SUPPORT_TICKET_STATUSES`, and it should not be invented here. A support queue legitimately goes
 * backwards — a resolved ticket is reopened by a reply, a waiting one returns to open — and the
 * five values are a label on a conversation rather than a machine with a stock consequence behind
 * it. That is also why the audit action is the generic `support-ticket.update` rather than an
 * order-style `status-change`.
 *
 * Every field is optional, but a body with none of them is a write that changes nothing and writes
 * no audit row, per plan 9.1's rule.
 */
export class ChangeSupportTicketDto {
  @ApiPropertyOptional({ enum: SUPPORT_TICKET_STATUSES, example: 'open' })
  @IsOptional()
  @IsIn(SUPPORT_TICKET_STATUSES)
  status?: SupportTicketStatus;

  /**
   * 1 is most urgent, 5 least; the column defaults to 2.
   *
   * A plain `int` with a range rather than a vocabulary, because that is what the column is and
   * nothing in the brief or the spec names priority bands. Bounded at 5 so the field stays a
   * triage dial rather than an arbitrary integer nobody can sort meaningfully.
   */
  @ApiPropertyOptional({ example: 1, minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  priority?: number;

  /**
   * The admin who owns this ticket, or an explicit `null` to put it back in the pool.
   *
   * The service checks that the account exists **and is an admin**: `assigned_to_user_id` is a
   * plain FK to `users`, which would happily accept a customer's id, and a ticket assigned to a
   * shopper is a ticket nobody is working that still reads as assigned.
   */
  @ApiPropertyOptional({ example: '5f9b2c1e-0000-4000-8000-000000000000' })
  @IsOptional()
  @IsUUID()
  assignedToUserId?: string | null;
}

/** `POST /admin/support/tickets/:ticketNumber/notes` — brief §38's internal notes. */
export class CreateSupportTicketNoteDto {
  @ApiProperty({
    example: 'Called back; customer wants the 5kg pack instead. Awaiting confirmation.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body: string;

  /**
   * Defaults to **true**, matching the column: a note is staff-only unless someone says otherwise.
   *
   * Nothing in this milestone sends a note to a customer — there is no route and no notification
   * template for it. The flag is honoured on the way in anyway, so that the day something does, the
   * notes already written are not retrospectively published. `AdminSupportTicketNote` says the
   * same on the wire.
   */
  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;
}

/**
 * The global pipe runs with `transformOptions: { enableImplicitConversion: false }`, so nothing else
 * coerces a query string. Returns the original value when it is not numeric rather than `NaN`, so a
 * rejected input stays legible in a log — `product-query.dto.ts` has the full reasoning.
 */
function toQueryNumber(value: unknown): unknown {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? value : parsed;
}
