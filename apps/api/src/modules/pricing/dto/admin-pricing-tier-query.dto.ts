import { ApiPropertyOptional } from '@nestjs/swagger';
import { CUSTOMER_SEGMENTS, type CustomerSegment } from '@nutwala/shared';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min, ValidateIf } from 'class-validator';

/**
 * `GET /admin/pricing-tiers`' query string — brief §31's pricing screen.
 *
 * A DTO of its own, for `AdminProductQueryDto`'s reason: the global `ValidationPipe` runs with
 * `forbidNonWhitelisted`, so an undeclared parameter is a 400 rather than a filter silently ignored
 * while an unfiltered page comes back.
 */
export class AdminPricingTierQueryDto {
  /** One product's whole ladder, which is the screen an operator actually opens. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({ enum: CUSTOMER_SEGMENTS })
  @IsOptional()
  @IsIn(CUSTOMER_SEGMENTS)
  segment?: CustomerSegment;

  /**
   * One business's negotiated ladder, or — as the literal string `none` — the rungs scoped to no
   * business at all.
   *
   * A sentinel rather than `?businessId=null`, because a query string has no null: `businessId=`
   * is an empty string and `businessId=null` is the four characters. `none` is refused as a uuid by
   * `@IsUUID`, so it is checked first and translated by the service. `AdminProductQueryDto` records
   * the mirror-image decision — that `all` is *not* a sentinel there — for the same reason: a
   * sentinel is worth its cost only when the question cannot be asked without one, and "which rungs
   * belong to nobody in particular" cannot.
   */
  @ApiPropertyOptional({ format: 'uuid', description: "A business uuid, or 'none'" })
  @IsOptional()
  @ValidateIf((_object, value) => value !== 'none')
  @IsUUID()
  businessId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toQueryNumber(value))
  @IsInt()
  @Min(1)
  page?: number;

  /** Capped at 60, the ceiling every other admin list uses. The service clamps as well, so this is
   * about telling a caller their request was wrong rather than quietly answering a different
   * question. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toQueryNumber(value))
  @IsInt()
  @Min(1)
  @Max(60)
  limit?: number;
}

/** See `admin-product-query.dto.ts` — the global pipe does not coerce a query string, and a
 * non-numeric value is returned unchanged rather than as `NaN` so it stays legible in a log. */
function toQueryNumber(value: unknown): unknown {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? value : parsed;
}
