import { ApiPropertyOptional } from '@nestjs/swagger';
import type { Channel, ProductFilters, ProductSort } from '@nutwala/shared';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * The accepted values, derived from the shared unions rather than hand-listed.
 *
 * A `Record` keyed on the union is checked in both directions — a missing key and an extra key are
 * both compile errors — so a `ProductSort` added in `shared/` cannot reach this DTO as a value the
 * client's own types call legal and the server answers 400 for. A bare `as const` array would have
 * type-checked while silently rejecting the new sort.
 */
const SORTS = Object.keys({
  featured: true,
  'best-selling': true,
  'price-asc': true,
  'price-desc': true,
  newest: true,
  rating: true,
} satisfies Record<ProductSort, true>) as ProductSort[];

const CHANNELS = Object.keys({
  retail: true,
  bulk: true,
} satisfies Record<Channel, true>) as Channel[];

/**
 * `@Transform` rather than `@Type`, because a query string's `"true"` is truthy under
 * `@Type(() => Boolean)` and so is `"false"` — every checkbox would read as ticked.
 *
 * Pair it with **`@IsBoolean()`, never `@IsBooleanString()`.** class-transformer runs before
 * class-validator, so by validation time the value is a real boolean and `@IsBooleanString` rejects
 * it: measured, and both `inStockOnly=true` and `inStockOnly=false` fail with "must be a boolean
 * string". That pairing would have made every request carrying the shop's in-stock filter a 400.
 *
 * The explicit transform is load-bearing because the global pipe runs with
 * `transformOptions: { enableImplicitConversion: false }` — nothing else coerces a query string.
 */
const toBoolean = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  );

/**
 * Returns the original value when it is not numeric, rather than `NaN`.
 *
 * The plan's reason for this was that `NaN` "fails `@Max` before `@IsInt`, so the customer is told
 * 'limit must not be greater than 60' for a value that was never a number". That is not what
 * happens — measured both ways: class-validator collects *every* failing constraint, so
 * `limit=abc` answers with all three messages, `@Max`'s first, whether the transform hands back
 * `'abc'` or `NaN`. Neither spelling gives a better error.
 *
 * What it does buy is that the transform never fabricates a value: the rejected input stays
 * `'abc'` in the instance, where a `NaN` would serialise to `null` in a log or an echoed request
 * and hide what the caller actually sent.
 */
const toNumber = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === '') return undefined;
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed;
  });

/**
 * The listing query, mirroring `ProductFilters` from `@nutwala/shared`.
 *
 * `implements ProductFilters` is the control that keeps the two aligned: a field whose type drifts
 * from the shared contract — `sort?: string`, say — stops compiling here rather than at the seam
 * that consumes it.
 *
 * The global `ValidationPipe` runs with `whitelist: true` and `forbidNonWhitelisted: true`, so an
 * undeclared query parameter is a 400. That is the behaviour we want against mass assignment, and
 * it also means **every parameter the frontend sends must be declared here** or the shop breaks
 * with a validation error rather than an ignored filter.
 */
export class ProductQueryDto implements ProductFilters {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @toNumber()
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @toNumber()
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  origin?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  grade?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @toBoolean()
  @IsBoolean()
  bestsellerOnly?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @toBoolean()
  @IsBoolean()
  inStockOnly?: boolean;

  @ApiPropertyOptional({ enum: CHANNELS })
  @IsOptional()
  @IsIn(CHANNELS)
  channel?: Channel;

  /** The bulk catalogue's MOQ buttons offer 5, 10, 25 and 50; the seeded values are 5, 10 and 25. */
  @ApiPropertyOptional()
  @IsOptional()
  @toNumber()
  @IsNumber()
  @Min(0)
  maxMoq?: number;

  @ApiPropertyOptional({ enum: SORTS })
  @IsOptional()
  @IsIn(SORTS)
  sort?: ProductSort;

  @ApiPropertyOptional()
  @IsOptional()
  @toNumber()
  @IsInt()
  @Min(1)
  page?: number;

  /**
   * Capped at the service's `MAX_LIMIT`. The service clamps anyway, so this is about telling a
   * caller their request was wrong instead of quietly answering a different question.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @toNumber()
  @IsInt()
  @Min(1)
  @Max(60)
  limit?: number;
}
