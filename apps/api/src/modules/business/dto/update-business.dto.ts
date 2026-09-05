import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BUSINESS_TYPES, GSTIN_REGEX, PHONE_REGEX } from '@nutwala/shared';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * `PUT /business/me` — brief §19's fuller business profile, on top of what registration already
 * collected. Mirrors `frontend/src/routes/business/profile.tsx`'s form field for field, with one
 * deliberate difference: no `email` — `Business` has no email column, and the form's old
 * `email` field was never backed by anything real.
 *
 * A full replace, not a patch: every field is required (`billingAddressId`/`shippingAddressId`
 * accept `null` rather than being omittable, so "the customer has not chosen an address" is a
 * value this DTO can carry rather than a state a patch would leave alone). Task 15's own plan
 * calls this out — the form always submits the whole object.
 *
 * `billingAddressId`/`shippingAddressId` are validated as **uuids**, not as address rows —
 * `BusinessesService.update` is what checks each belongs to the caller and is not soft-deleted,
 * because that check needs a database read this DTO cannot perform. `@IsUUID()` alone is still
 * load-bearing: Task 21 measured a non-uuid reaching a `uuid` column as SQLSTATE `22P02`, a
 * **500** where a 400 belongs, and this is what stops one ever reaching that column.
 *
 * `segment` and `assignedSalespersonId` are deliberately absent. Both are commercial/sales
 * decisions about this customer, and the global `ValidationPipe`'s `forbidNonWhitelisted` turns
 * either one appearing in a request into a 400 rather than a value silently ignored — the same
 * guard `CreateRfqDto`'s docblock explains for the identical reason.
 */
export class UpdateBusinessDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(160) companyName: string;

  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) contactPerson: string;

  @ApiProperty({ pattern: PHONE_REGEX.source })
  @Matches(PHONE_REGEX, { message: 'Enter a valid 10-digit Indian mobile number' })
  mobile: string;

  @ApiPropertyOptional({ pattern: GSTIN_REGEX.source })
  @IsOptional()
  @Matches(GSTIN_REGEX, { message: 'Enter a valid 15-character GSTIN' })
  gstin?: string;

  @ApiProperty({ enum: BUSINESS_TYPES }) @IsIn(BUSINESS_TYPES) businessType: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  billingAddressId?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  shippingAddressId?: string | null;
}
