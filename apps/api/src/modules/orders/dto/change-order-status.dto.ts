import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { B2B_ORDER_STATUSES, B2C_ORDER_STATUSES, type OrderStatus } from '@nutwala/shared';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * Every status either channel can hold, from `@nutwala/shared`'s own two tuples — brief §33's nine
 * and eight, spread rather than re-listed.
 *
 * **This DTO validates membership of the *union*, and deliberately not of the order's channel.**
 * The channel comes from the row, and `OrderStatusService.transition` is the one place that knows
 * it: a retail order asked to become `quote-sent` is refused there with
 * `422 ILLEGAL_STATUS_TRANSITION` carrying `allowed` — the real list of what it *can* become —
 * which is a better answer than a 400 saying the value is not a status, because it is. Checking the
 * channel here would need a second copy of the per-channel vocabularies at a layer that has not
 * read the order yet, and the third copy of brief §33 is the one that drifts.
 *
 * `order.mapper.ts` builds the same union as a `Set` for the opposite direction. Neither can grow
 * without `shared/`.
 */
const ORDER_STATUSES: readonly OrderStatus[] = [...B2C_ORDER_STATUSES, ...B2B_ORDER_STATUSES];

/**
 * `POST /admin/orders/:orderNumber/status`' body.
 *
 * Three fields, and each one exists because the operation genuinely cannot be performed without the
 * caller saying something the server does not know.
 */
export class ChangeOrderStatusDto {
  /** Where the order is being moved to. The order it is moving *from* is the row's, never the caller's. */
  @ApiProperty({ enum: ORDER_STATUSES, example: 'packed' })
  @IsIn(ORDER_STATUSES)
  status: OrderStatus;

  /**
   * Free text for the timeline — `order_events.note`, `varchar(300)`, which is where the width
   * comes from. On the `cancelled` path it also becomes `orders.cancel_reason`, truncated to 200 by
   * `transition` because the two columns disagree; the full text survives on the event, which is the
   * row the customer's tracking page renders.
   */
  @ApiPropertyOptional({ example: 'Handed to Delhivery at the Bengaluru hub' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  /**
   * Whether refunded goods go back on sale — **required on the `refunded` path and meaningless
   * anywhere else.**
   *
   * `TransitionOptions.restock` is never inferred and never defaulted to `true`, because spec §10.3
   * makes it a judgement about the goods rather than a property of the status: returned food may
   * not be resellable. Its docblock records the cost of leaving it optional — *"'no flag' and 'the
   * admin decided not to restock' are different facts that arrive here looking identical"* — and
   * `@ValidateIf` is what stops those two arriving identically over HTTP. An admin refunding an
   * order must say which, and a refund request that omits it is a 400 naming the field rather than
   * a silent decision not to restock taken on their behalf.
   *
   * Not refused on the other statuses, merely unread: `transition` consults it on the `refunded`
   * path alone, and `cancelled` restores stock unconditionally because a cancellation happens
   * before dispatch, so the goods never left the building.
   */
  @ApiPropertyOptional({ description: 'Required when status is "refunded"' })
  @ValidateIf((dto: ChangeOrderStatusDto) => dto.status === 'refunded')
  @IsBoolean()
  restock?: boolean;
}
