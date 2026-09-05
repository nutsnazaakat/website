import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * `GET /admin/coupons`' query string.
 *
 * **Paginated, unlike `GET /admin/categories`.** The taxonomy is fixed at brief §7's twelve, so a
 * category list is bounded by the business; coupons are campaigns and accumulate for as long as the
 * shop runs, with no reason ever to delete an expired one (and `coupon_redemptions` refusing to let
 * you delete a redeemed one anyway). A list endpoint that can be turned into a table dump is what
 * the 60-row cap on every other admin list exists to prevent.
 *
 * Only one filter, and it is the one an operator actually opens this page with — "which of these
 * are live". Expiry is deliberately **not** a filter: `expiresAt` is nullable, so "expired" is a
 * three-way question (never expires / expired / not yet), and a boolean would answer the wrong one
 * of the three silently. The global `ValidationPipe` runs with `forbidNonWhitelisted`, so adding a
 * filter later is safe and declaring speculative ones now is not free.
 */
export class AdminCouponQueryDto {
  /** `coupons.isActive` — the soft-disable flag, not an expiry check. */
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toQueryBoolean(value))
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toQueryNumber(value))
  @IsInt()
  @Min(1)
  page?: number;

  /** Capped at 60, matching every other admin list. The service clamps as well. */
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
export function toQueryNumber(value: unknown): unknown {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? value : parsed;
}

/**
 * `'true'` / `'false'` only, and anything else is passed through untouched so `@IsBoolean()`
 * refuses it by name.
 *
 * Not `value === 'true'`, which is the shape this would obviously take: that maps `?isActive=yes`
 * and `?isActive=1` to **false**, so a caller who guessed the spelling would be shown the disabled
 * coupons and told nothing. A filter that answers the opposite question in silence is worse than a
 * 400.
 */
export function toQueryBoolean(value: unknown): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}
