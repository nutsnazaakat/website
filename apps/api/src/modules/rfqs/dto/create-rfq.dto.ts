import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  BUSINESS_TYPES,
  GSTIN_REGEX,
  ORDER_FREQUENCIES,
  PACKAGING_OPTIONS,
  PHONE_REGEX,
  PINCODE_REGEX,
} from '@nutwala/shared';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * One line of a bulk enquiry, mirroring `frontend/src/features/rfq/schema.ts`'s
 * `rfqLineSchema`.
 *
 * `kg`'s floor is `@Min(1)`, not the `0.01` `QuotePreviewDto` uses — the form's own rule is a
 * whole kilogram, and a bound here loosens what the frontend already enforces rather than
 * matching it. The ceiling is a business one, not the `numeric(10,2)` column's mathematical
 * limit: nothing plausible about an enquiry needs six-figure tonnage, and a caller that means it
 * has the sales desk's phone number.
 */
export class CreateRfqLineDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(120) productSlug: string;

  @ApiProperty() @IsNumber() @Min(1) @Max(100_000) kg: number;
}

/**
 * `POST /rfqs` — spec §6.1's bulk quote request, in the **public** block. Every field here is
 * one `frontend/src/features/rfq/schema.ts`'s `rfqSchema` already validates and would otherwise
 * discard, matching `PlaceOrderDto`'s own docblock: the server does not trust the client's copy
 * of a rule it can check itself.
 *
 * `businessType`/`packaging`/`frequency` are validated with `@IsIn` over a `shared` tuple rather
 * than `@IsString`, wherever spec §14/§17's vocabulary exists — not only tidiness: an unvalidated
 * enum string reaching `undefined` makes TypeORM *drop* a filter criterion rather than narrow it,
 * a defect Plan 3 found the hard way. Inserts carry a smaller version of that risk, but `@IsIn`
 * is also what stops the RFQ queue filling with values no report ever groups by.
 */
export class CreateRfqDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(160) businessName: string;

  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) contactPerson: string;

  @ApiProperty({ pattern: PHONE_REGEX.source })
  @Matches(PHONE_REGEX, { message: 'Enter a valid 10-digit Indian mobile number' })
  mobile: string;

  @ApiProperty() @IsEmail() @MaxLength(255) email: string;

  @ApiPropertyOptional({ pattern: GSTIN_REGEX.source })
  @IsOptional()
  @Matches(GSTIN_REGEX, { message: 'Enter a valid 15-character GSTIN' })
  gstin?: string;

  @ApiProperty({ enum: BUSINESS_TYPES }) @IsIn(BUSINESS_TYPES) businessType: string;

  @ApiProperty({ pattern: PINCODE_REGEX.source })
  @Matches(PINCODE_REGEX, { message: 'Enter a valid 6-digit pincode' })
  pincode: string;

  @ApiProperty({ type: [CreateRfqLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CreateRfqLineDto)
  lines: CreateRfqLineDto[];

  @ApiProperty({ enum: PACKAGING_OPTIONS }) @IsIn(PACKAGING_OPTIONS) packaging: string;

  @ApiProperty({ enum: ORDER_FREQUENCIES }) @IsIn(ORDER_FREQUENCIES) frequency: string;

  /** `rfqs.notes` is `text`; bounded here so the request is not. */
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}
