import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GSTIN_REGEX, PHONE_REGEX } from '@nutwala/shared';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class CompanyProfileDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  companyName: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  contactPerson: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  businessType: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(GSTIN_REGEX, { message: 'Enter a valid 15-character GSTIN' })
  gstin?: string;
}

export class RegisterDto {
  @ApiProperty()
  @IsString()
  @MinLength(2, { message: 'Enter your full name' })
  @MaxLength(120)
  name: string;

  @ApiProperty()
  @IsEmail({}, { message: 'Enter a valid email address' })
  @MaxLength(255)
  email: string;

  /** Exactly the rule the checkout form applies, from `@nutwala/shared`. */
  @ApiProperty({ example: '9876543210' })
  @Matches(PHONE_REGEX, { message: 'Enter a valid 10-digit Indian mobile number' })
  phone: string;

  /**
   * Only a length floor here; `PasswordService.validateStrength` owns the real rule and answers
   * `WEAK_PASSWORD` with its own wording. Duplicating the character classes in this decorator
   * would give two definitions of "strong enough" that drift apart.
   */
  @ApiProperty()
  @IsString()
  @MinLength(8, { message: 'Use at least 8 characters' })
  @MaxLength(200)
  password: string;

  @ApiProperty({ description: 'Brief §46 — one account, promoted to bulk buying' })
  @IsBoolean()
  isBusiness: boolean;

  @ApiPropertyOptional({ type: CompanyProfileDto })
  @ValidateIf((dto: RegisterDto) => dto.isBusiness)
  @IsOptional()
  @ValidateNested()
  @Type(() => CompanyProfileDto)
  company?: CompanyProfileDto;
}
