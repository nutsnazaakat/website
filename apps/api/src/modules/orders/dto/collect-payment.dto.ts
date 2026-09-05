import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * `POST /admin/orders/:orderNumber/payment/collect`' body — one optional field.
 *
 * **Optional, unlike `UpdateThresholdDto`'s single required field**, and the difference is what an
 * empty body means. There, a body with nothing in it was a request that could not mean anything;
 * here it means "cash collected, no receipt number", which is a real and common thing to record —
 * a delivery agent hands over notes and the reference follows on a manifest, or never comes at all.
 * `payments.reference` is nullable for exactly that reason.
 *
 * `MaxLength(120)` is the column's width. Untruncated, a longer value is a Postgres `22001` — a 500
 * on a request that was otherwise fine.
 *
 * There is deliberately **no amount**. Spec §13's rule that the server recomputes money and ignores
 * whatever the client sends applies here as much as at checkout: what was collected is what the
 * order is worth, and `payments.amountPaise` already holds it from placement. An amount on this
 * request would be a second figure with nothing to reconcile it against, and a partial-collection
 * feature — which nothing in the brief asks for — would need a schema that can express one.
 */
export class CollectPaymentDto {
  @ApiPropertyOptional({ example: 'DLV-88213' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}
