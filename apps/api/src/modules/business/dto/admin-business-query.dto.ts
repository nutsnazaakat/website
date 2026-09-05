import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CUSTOMER_SEGMENTS, type CustomerSegment } from '@nutwala/shared';

/**
 * `GET /admin/businesses`' query string — brief §35's B2B half.
 *
 * A DTO of its own rather than a shared page query, for `AdminProductQueryDto`'s reason: the global
 * `ValidationPipe` runs with `forbidNonWhitelisted`, so an undeclared parameter is a 400 rather
 * than a filter silently ignored while an unfiltered page comes back.
 */
export class AdminBusinessQueryDto {
  /**
   * Company name, contact person or GSTIN — case-insensitive substring.
   *
   * The account's own `name`/`email` are deliberately not searched here: they are
   * `GET /admin/customers`' columns, and a business search that also matched them would return the
   * same account from two screens on two different rules. A GSTIN is included because it is the one
   * identifier a tax query arrives quoting.
   */
  @ApiPropertyOptional({ example: 'sweet' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  /**
   * Brief §31's price band. Omitted means every band.
   *
   * The wire vocabulary, lowercase — `CUSTOMER_SEGMENTS` from `@nutwala/shared`, never the Postgres
   * enum's uppercase spelling. The service maps it through a total `Record`, so the two cannot
   * grow apart.
   */
  @ApiPropertyOptional({ enum: CUSTOMER_SEGMENTS })
  @IsOptional()
  @IsIn(CUSTOMER_SEGMENTS)
  segment?: CustomerSegment;

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
