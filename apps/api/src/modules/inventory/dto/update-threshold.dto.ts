import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

/**
 * `PATCH /admin/inventory/:variantId/threshold` — the one field, and it is **required**.
 *
 * Required rather than optional, unlike every other admin PATCH in this codebase where an omitted
 * field means "leave unchanged": there is only one field, so an empty body is not a partial update,
 * it is a request that cannot mean anything. A 400 naming `lowStockThreshold` says so; a 200 that
 * changed nothing would read as success.
 *
 * The bounds are `CreateVariantDto.lowStockThreshold`'s, deliberately identical — it is the same
 * column, and a threshold that could be set at creation but not corrected afterwards, or corrected
 * to a value creation would have refused, is two rules for one field.
 *
 * **`0` is legal and means "only warn me when it is actually gone".** Spec §12's rule is
 * `available <= lowStockThreshold`, so a zero threshold makes `low` exactly `outOfStock` rather
 * than disabling the flag — worth knowing before someone reads a zero as "no threshold set".
 */
export class UpdateThresholdDto {
  @ApiProperty({ example: 25 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  lowStockThreshold: number;
}
