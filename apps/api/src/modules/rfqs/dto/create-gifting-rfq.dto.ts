import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  BUSINESS_TYPES,
  GIFTING_OCCASIONS,
  GSTIN_REGEX,
  PHONE_REGEX,
  PINCODE_REGEX,
} from '@nutwala/shared';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * `POST /rfqs/gifting` — spec §6.1/brief §24's corporate gifting enquiry, in the **public**
 * block. Mirrors `frontend/src/features/gifting/schema.ts`'s `giftingSchema` field for field,
 * with one deliberate addition: `businessType`.
 *
 * Measured against the live schema before this DTO was written: `rfqs.packaging`, `.frequency`
 * and `.businessType` were all `NOT NULL`, and the gifting form asks for none of the three.
 * `packaging`/`frequency` genuinely do not apply to a gift box and were made nullable
 * (`RfqGiftingNullable20260822110000`) — but `businessType` **is** a real question about a real
 * corporate customer, and `BUSINESS_TYPES` already answers it with "Corporate gifting", so this
 * DTO asks for it rather than the column being relaxed a third time.
 *
 * `companyName`, not `businessName` — the gifting form's own word for the field, and the right
 * one for a corporate customer. `RfqsController` maps it onto `CreateRfqInput.businessName`;
 * the column keeps the name a kirana store's enquiry also uses, and the mapping lives at the
 * boundary rather than forcing one form to use the other's vocabulary.
 */
export class CreateGiftingRfqDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(160) companyName: string;

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
  @Matches(PINCODE_REGEX, { message: 'Enter a valid 6-digit delivery pincode' })
  pincode: string;

  @ApiProperty({ enum: GIFTING_OCCASIONS }) @IsIn(GIFTING_OCCASIONS) occasion: string;

  @ApiProperty() @IsString() @MaxLength(120) giftBoxSlug: string;

  @ApiProperty() @IsInt() @Min(1) @Max(100_000) boxes: number;

  /** Rupees, per spec §8's money boundary — `RfqsService.create` is what converts to paise. */
  @ApiProperty() @IsNumber() @Min(1) @Max(1_000_000) budgetPerBox: number;

  @ApiProperty() @IsBoolean() brandingRequired: boolean;

  /** ISO `yyyy-mm-dd`, straight from a native date input, matching the form's own shape. */
  @ApiProperty() @IsDateString({ strict: true }) deliveryDate: string;

  /** `rfq_gifting_details.message` is `text`; bounded here so the request is not. */
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) message?: string;
}
