import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * `POST /admin/orders/:orderNumber/shipment`' body.
 *
 * **`courier` is required and `trackingNumber` is not**, which is the asymmetry the operation
 * actually has: an operator recording a dispatch always knows who they handed the parcel to, and
 * the airway bill sometimes follows on a manifest an hour later. Both columns are nullable, so this
 * is a rule of the endpoint rather than of the schema — a shipment with neither field is a row that
 * records nothing but its own existence, and creating one would be indistinguishable from a
 * mis-click.
 *
 * **A gap worth stating, because this endpoint creates the situation:** spec §6.4 lists no route
 * that *updates* a shipment, so a tracking number arriving after dispatch has nowhere to go — the
 * order is already `shipped` by then and this route refuses to run twice. `PATCH
 * /admin/shipments/:id` is the missing row; plan 9.4 should add it.
 *
 * Both widths are the columns': `courier` is `varchar(80)` and `trackingNumber` is `varchar(120)`.
 * Untruncated, a longer value is a Postgres `22001` — a 500 on a request that was otherwise fine.
 *
 * There is no `status` and no `shippedAt`. Both are decided by the act: a shipment created here is
 * a parcel that has been handed over, so it is `DISPATCHED` as of now, and the order moves to
 * `shipped` in the same transaction. Letting a caller choose would allow a shipment sitting at
 * `PENDING` beside an order that says it has shipped — two records of one fact, disagreeing.
 */
export class CreateShipmentDto {
  @ApiProperty({ example: 'Delhivery' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  courier: string;

  @ApiPropertyOptional({ example: 'DL2894471104' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  trackingNumber?: string;
}
