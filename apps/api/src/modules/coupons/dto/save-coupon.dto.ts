import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import type { AdminCouponChannel, AdminCouponScope, AdminCouponType } from '@nutwala/shared';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Each wire vocabulary derived through a `satisfies` record, the way `admin-order-query.dto.ts`
 * does it: a missing key and an extra key are both compile errors, so a member added in `shared/`
 * cannot reach this DTO as a value the client's own types call legal and the server answers 400 for.
 */
const COUPON_TYPES = Object.keys({
  percent: true,
  flat: true,
} satisfies Record<AdminCouponType, true>) as AdminCouponType[];

const COUPON_SCOPES = Object.keys({
  all: true,
  category: true,
} satisfies Record<AdminCouponScope, true>) as AdminCouponScope[];

const COUPON_CHANNELS = Object.keys({
  all: true,
  retail: true,
  bulk: true,
} satisfies Record<AdminCouponChannel, true>) as AdminCouponChannel[];

/**
 * `POST /admin/coupons` — brief §36 in full: percentage discount, flat discount, minimum order
 * value, category-specific, B2C-only, B2B-only, first-order, expiry, usage limit.
 *
 * **Money arrives in rupees**, per spec §8, and is converted once in the service. `percentValue` is
 * the one number here that is not money: `coupons.percentValue` is `numeric(5,2)`, so two decimal
 * places is the column's own precision rather than a chosen limit.
 *
 * **Nullable fields accept an explicit `null`, and that is load-bearing on the PATCH.**
 * `@IsOptional()` skips validation for `null` as well as `undefined`, so `{ "maxDiscount": null }`
 * validates and arrives as `null` while an omitted key arrives as `undefined` — which is exactly
 * the distinction `AdminCouponsService.update` needs to tell "leave the cap alone" from "remove the
 * cap". Every partial update in this codebase relies on that difference; here it is the only way to
 * clear a field at all.
 */
export class CreateCouponDto {
  /**
   * The code a customer types. **Stored and compared uppercase**, per `Coupon.code`'s docblock, so
   * `save10` matches `SAVE10`; the transform below is what makes the uniqueness check see the same
   * string the redemption path will.
   *
   * Letters, digits, hyphen and underscore only. A code with a space or a slash in it cannot be
   * read down a phone line or put in a URL, and this one goes in both.
   */
  @ApiProperty({ example: 'DIWALI25' })
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @MinLength(3)
  @MaxLength(40)
  @Matches(/^[A-Z0-9][A-Z0-9_-]*$/, {
    message:
      'code must be letters, digits, hyphens and underscores, starting with a letter or digit',
  })
  code: string;

  @ApiProperty({ enum: COUPON_TYPES, example: 'percent' })
  @IsIn(COUPON_TYPES)
  type: AdminCouponType;

  /**
   * Required when `type` is `percent`, refused when it is `flat` — `ck_coupons_value_exclusive`.
   * The service enforces the pairing rather than this DTO, because it is a rule about two fields
   * together and has to hold on a PATCH that sends only one of them.
   */
  @ApiPropertyOptional({ example: 15 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(100)
  percentValue?: number | null;

  /** Rupees. Required when `type` is `flat`, refused when it is `percent`. */
  @ApiPropertyOptional({ example: 500 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  flatValue?: number | null;

  /** Rupees. The eligible subtotal the basket must reach. Null or omitted means no minimum. */
  @ApiPropertyOptional({ example: 10_000 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  minOrderValue?: number | null;

  /**
   * Rupees. Brief §36's cap on a percentage discount — "10% off, up to ₹200".
   *
   * Only meaningful for a `percent` coupon: `applyFlat` takes no cap, so a `maxDiscount` on a flat
   * coupon would be stored, displayed, and silently ignored at redemption. The service refuses the
   * combination for that reason.
   */
  @ApiPropertyOptional({ example: 200 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  maxDiscount?: number | null;

  /** Defaults to `all`, matching the column. */
  @ApiPropertyOptional({ enum: COUPON_SCOPES, example: 'category' })
  @IsOptional()
  @IsIn(COUPON_SCOPES)
  appliesTo?: AdminCouponScope;

  /** Required when `appliesTo` is `category`, refused when it is `all`. */
  @ApiPropertyOptional({ example: '5f9b2c1e-0000-4000-8000-000000000000' })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  /** Brief §36's B2C-only / B2B-only. Defaults to `all`, matching the column. */
  @ApiPropertyOptional({ enum: COUPON_CHANNELS, example: 'bulk' })
  @IsOptional()
  @IsIn(COUPON_CHANNELS)
  channel?: AdminCouponChannel;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  firstOrderOnly?: boolean;

  /** Total redemptions allowed across every customer. Null or omitted means uncapped. */
  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimit?: number | null;

  /** Redemptions allowed per account. Counts nobody while the coupon is used by guests. */
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimitPerUser?: number | null;

  /** ISO-8601 instant. Before this the coupon reads as `COUPON_INVALID`, never `COUPON_EXPIRED`. */
  @ApiPropertyOptional({ example: '2026-10-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  startsAt?: string | null;

  /** ISO-8601 instant. `CouponService.preview` refuses at or after it, with `COUPON_EXPIRED`. */
  @ApiPropertyOptional({ example: '2026-11-15T18:29:59.999Z' })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string | null;

  /**
   * Defaults to **true**, matching the column.
   *
   * This is the soft-disable path, and it is the answer to "stop this campaign now" — not a delete,
   * which is refused once the coupon has been redeemed, and not an expiry in the past, which works
   * but loses the distinction between "the campaign ended" and "we switched it off".
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * `PATCH /admin/coupons/:code`. `PartialType` over `OmitType`, so every field is optional and
 * **`code` is not among them**.
 *
 * The code is immutable once created, and that is a decision rather than an oversight. Three things
 * key on it and none of them can be rewritten: `orders.couponCode` is a snapshot column recording
 * which coupon each past order used, `audit_logs.entityId` is the coupon's code for the same
 * reason, and the URL of this very endpoint is it. Renaming `WELCOME10` would leave every one of
 * those pointing at a code that no longer exists, with nothing to say what happened. A coupon
 * created with a typo has no redemptions by definition, so `DELETE` then `POST` is available and is
 * the honest way to do it.
 */
export class UpdateCouponDto extends PartialType(OmitType(CreateCouponDto, ['code'] as const)) {}
