import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * `GET /admin/products`' query string.
 *
 * **A separate DTO from `ProductQueryDto`, not an extension of it**, and the reason is the whole
 * point of the endpoint. `ProductQueryDto implements ProductFilters`, the storefront's filter set,
 * and every one of its filters is answered by `CatalogService.baseQuery`, which pins
 * `product.isPublished = true`. Inheriting it would drag in eleven storefront filters that the
 * admin query would then have to answer identically or silently ignore — `minPrice` resolved
 * through the `DISTINCT ON` per-kg derived table, `inStockOnly` through an `EXISTS` on inventory —
 * and would invite exactly the mistake this endpoint must not make: reusing a query that filters to
 * published.
 *
 * So this declares the four filters an operator actually needs and no more. Adding one later is
 * safe precisely because the global `ValidationPipe` runs with `forbidNonWhitelisted`, so an
 * undeclared parameter is a 400 today rather than a filter quietly ignored while an unfiltered page
 * comes back.
 */
export class AdminProductQueryDto {
  /**
   * Name or slug, case-insensitive substring.
   *
   * Narrower than the storefront's `q`, which also searches `subtitle`, `origin`, `grade` and the
   * category slug so a shopper's vague phrase finds something. An operator looking for a product to
   * edit knows what it is called, and a search that also matched every product sharing an origin
   * would bury it.
   */
  @ApiPropertyOptional({ example: 'almond' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  /** Category **slug**, matching the storefront's vocabulary. `all` is not a sentinel here. */
  @ApiPropertyOptional({ example: 'almonds' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  /**
   * Tri-state: omitted means **both**, which is the default and the entire reason this endpoint
   * exists. `true` narrows to published, `false` to drafts.
   *
   * `@Transform` and `@IsBoolean()`, never `@Type(() => Boolean)` or `@IsBooleanString()` —
   * `product-query.dto.ts` records the measurement: `"false"` is truthy under `Boolean()`, so every
   * checkbox reads as ticked, and class-transformer runs *before* class-validator so by validation
   * time the value is a real boolean and `@IsBooleanString` rejects it.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  published?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toQueryNumber(value))
  @IsInt()
  @Min(1)
  page?: number;

  /**
   * Capped at 60, the same ceiling `ProductQueryDto` uses and for the same reason — a list endpoint
   * must not be turnable into a table dump. The service clamps as well, so this is about telling a
   * caller their request was wrong rather than quietly answering a different question.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toQueryNumber(value))
  @IsInt()
  @Min(1)
  @Max(60)
  limit?: number;
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
