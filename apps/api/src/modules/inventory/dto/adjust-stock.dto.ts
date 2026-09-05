import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, MaxLength, MinLength, NotEquals } from 'class-validator';

export class AdjustStockDto {
  /**
   * Signed: positive for a receipt, negative for shrinkage or a correction.
   *
   * `@IsInt()` and not `@IsNumber()`, because stock is whole packs — and it is also what keeps the
   * raw SQL fragment in `InventoryService.adjust` safe by construction, since a number cannot carry
   * a quote. `@NotEquals(0)` refuses the no-op here so the common case is a 400 naming the field
   * rather than the service's 422; the service keeps its own check for callers that do not arrive
   * through this DTO.
   */
  @ApiProperty({ example: -5 })
  @IsInt()
  @NotEquals(0)
  delta: number;

  /**
   * Required, and not from a fixed list. Brief §32 wants the history to say *why*, and a free-text
   * reason an admin actually writes is more useful than a dropdown they pick the first option from.
   *
   * `MaxLength(200)` matches `InventoryTransaction.reason`'s column width, so an over-long reason is
   * a named validation failure rather than a driver error from the insert.
   */
  @ApiProperty({ example: 'Damaged in transit — 5 packs discarded' })
  @IsString()
  @MinLength(4)
  @MaxLength(200)
  reason: string;
}
