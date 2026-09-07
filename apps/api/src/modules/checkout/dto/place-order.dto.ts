import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { GSTIN_REGEX, PHONE_REGEX, PINCODE_REGEX, type PaymentMethod } from '@nutwala/shared';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * The address block, mirroring `CheckoutForm`'s `addressSchema` field for field.
 *
 * Every rule here is the one the form already applies, from the same `@nutwala/shared` regexes the
 * zod schema imports — so the server is not a second, differently-strict opinion about what a phone
 * number is. `PINCODE_REGEX` is `/^\d{6}$/` and therefore accepts `110001`, which the Phase 1 mock's
 * `/^[2-8]\d{5}$/` refused; the database's `serviceable_pincodes` table is what decides deliverability
 * now, and it says prefix `1` is serviceable. Whether a well-formed pincode can be delivered to is
 * `PincodeService`'s answer, not this class's.
 *
 * The lengths are `Address`'s own column widths rather than round numbers, so an address that clears
 * checkout is one the address book can also store. The snapshot columns are `jsonb` and have no width
 * of their own, which is exactly why the bound has to be stated here — an unbounded string is an
 * unbounded row.
 */
export class AddressDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) fullName: string;

  @ApiProperty({ pattern: PHONE_REGEX.source })
  @Matches(PHONE_REGEX, { message: 'Enter a valid 10-digit Indian mobile number' })
  phone: string;

  @ApiProperty() @IsEmail() @MaxLength(255) email: string;

  @ApiProperty() @IsString() @MinLength(4) @MaxLength(255) line1: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(255) line2?: string;

  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80) city: string;

  /**
   * `MinLength(2)`, matching the form, rather than `@IsIn(INDIAN_STATES)`.
   *
   * The Select only ever offers the 36 entries in `shared`'s list, so the stricter rule would pass
   * today — but it is a different rule from the one the client enforces, and the first union
   * territory renamed would reject a form the browser had already accepted. Milestone 8 owns
   * unifying that list; this DTO's job is to accept what the form validates.
   */
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80) state: string;

  @ApiProperty({ pattern: PINCODE_REGEX.source })
  @Matches(PINCODE_REGEX, { message: 'Enter a valid 6-digit pincode' })
  pincode: string;
}

/**
 * Everything `POST /checkout/orders` takes — and, deliberately, **nothing that decides money**.
 *
 * No lines, no quantities, no prices, no totals. Spec §13: *"Server recomputes subtotal, GST,
 * shipping, discount and total from the database; client-supplied money is ignored entirely."* The
 * basket is read from the caller's own server-side cart, the same row `GET /cart` returns, so the
 * screen the customer confirmed is the thing being confirmed rather than the thing being trusted. A
 * body carrying lines would let a client name its own basket at the last step and leave the cart it
 * had been shown decorative.
 *
 * Every field below is one `CheckoutForm` already validates and then throws away
 * (`CheckoutForm.tsx:132-141` sends none of them), which is the other half of the plan's disagreement
 * 2. Task 13 makes the form send them.
 */
export class PlaceOrderDto {
  @ApiProperty({ type: AddressDto })
  @ValidateNested()
  @Type(() => AddressDto)
  shipping: AddressDto;

  @ApiProperty({ enum: ['cod', 'online'] })
  @IsIn(['cod', 'online'])
  paymentMethod: PaymentMethod;

  /** `orders.coupon_code` is `varchar(40)`. Matched case-insensitively by `CouponService`. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  couponCode?: string;

  // Brief §20's B2B block. Optional here because whether an order *is* B2B is decided by the
  // basket — `CheckoutForm` switches schemas on `lines.some(bulk) || totals.hasQuoteLines` — and a
  // DTO cannot see the cart. Widths are `orders`' own columns.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  companyName?: string;

  /**
   * `GSTIN_REGEX` from `shared`, the same pattern the form applies — 2-digit state, 5-letter PAN
   * prefix, 4 digits, letter, digit, `Z`, checksum. Validated rather than trusted: the form's rule is
   * a courtesy to the customer, and this is the copy that stops a malformed GST number reaching a tax
   * invoice.
   */
  @ApiPropertyOptional({ pattern: GSTIN_REGEX.source })
  @IsOptional()
  @Matches(GSTIN_REGEX, { message: 'Enter a valid 15-character GSTIN' })
  gstin?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) poNumber?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() billingSameAsShipping?: boolean;

  /**
   * Required exactly when the customer said billing differs, and `@ValidateIf` rather than
   * `@IsOptional` for the reason `CartLineDto.size` records: `@IsOptional()` skips every other
   * decorator when the value is absent, which is the one case being rejected here. "Bill somewhere
   * else" with no address is the request that would otherwise store a null billing snapshot and
   * print an invoice addressed to nobody.
   */
  @ApiPropertyOptional({ type: AddressDto })
  @ValidateIf((dto: PlaceOrderDto) => dto.billingSameAsShipping === false)
  @ValidateNested()
  @Type(() => AddressDto)
  billing?: AddressDto;

  /** `orders.special_instructions` is `text`; bounded here so the request is not. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  specialInstructions?: string;
}
