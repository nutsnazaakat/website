import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CONTACT_TOPICS, PHONE_REGEX } from '@nutwala/shared';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * `POST /contact` — the contact form's real backend. Every field mirrors
 * `frontend/src/features/contact/schema.ts`'s `contactSchema`, `CreateRfqDto`'s own "the server
 * does not trust the client's copy of a rule it can check itself" reasoning.
 *
 * `orderNumber` is deliberately **not** `@Matches(ORDER_NUMBER_PATTERN)`. `SupportTicket`'s own
 * docblock: *"a customer may type an order number that does not exist... and the ticket must
 * still be created so support can answer."* It is a lead for a human to chase, not a reference
 * the server can verify, so it is bounded to the column's width and left otherwise unvalidated —
 * a customer who types "the one from last Tuesday" still raises a ticket.
 */
export class CreateContactMessageDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) name: string;

  @ApiProperty() @IsEmail() @MaxLength(255) email: string;

  @ApiPropertyOptional({ pattern: PHONE_REGEX.source })
  @IsOptional()
  @Matches(PHONE_REGEX, { message: 'Enter a valid 10-digit Indian mobile number' })
  phone?: string;

  @ApiProperty({ enum: CONTACT_TOPICS }) @IsIn(CONTACT_TOPICS) topic: string;

  /** `support_tickets."orderNumber"` is `varchar(20)`. */
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) orderNumber?: string;

  @ApiProperty() @IsString() @MinLength(10) @MaxLength(2000) message: string;
}
