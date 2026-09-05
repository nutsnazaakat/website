import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * The two roles a **customer** can hold, on the wire.
 *
 * Not `Role` from `@nutwala/shared`, which also carries `admin`: brief §35's screen is "separate
 * B2C and B2B customers", and an operator account is neither. Allowing `?role=admin` would make
 * this endpoint a way to enumerate the admin accounts, and would answer a list whose `total`
 * disagrees with `GET /admin/dashboard`'s `customers` card — which counts `role <> 'ADMIN'`.
 */
export const ADMIN_CUSTOMER_ROLES = ['b2c', 'b2b'] as const;
export type AdminCustomerRole = (typeof ADMIN_CUSTOMER_ROLES)[number];

/**
 * `GET /admin/customers`' query string — brief §35's list.
 *
 * A DTO of its own rather than a shared page query, matching `AdminProductQueryDto`'s reasoning:
 * the global `ValidationPipe` runs with `forbidNonWhitelisted`, so every parameter this endpoint
 * answers has to be declared here and an undeclared one is a 400 rather than a filter silently
 * ignored while an unfiltered page comes back.
 */
export class AdminCustomerQueryDto {
  /**
   * Name, email or phone — case-insensitive substring, matching all three.
   *
   * The three fields an operator has to hand when a customer rings: a name off an order, the
   * address they signed up with, or the number on the delivery. Deliberately not the address book:
   * a search that also matched `addresses.fullName` would return the account of anybody who has
   * ever shipped something to a person with that name, which is a different question.
   */
  @ApiPropertyOptional({ example: 'asha' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  /** Omitted means **both**, which is brief §35's default view. */
  @ApiPropertyOptional({ enum: ADMIN_CUSTOMER_ROLES })
  @IsOptional()
  @IsIn(ADMIN_CUSTOMER_ROLES)
  role?: AdminCustomerRole;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toQueryNumber(value))
  @IsInt()
  @Min(1)
  page?: number;

  /** Capped at 60, the ceiling every other admin list uses — a list endpoint must not be turnable
   * into a table dump. The service clamps as well, so this is about telling a caller their request
   * was wrong rather than quietly answering a different question. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toQueryNumber(value))
  @IsInt()
  @Min(1)
  @Max(60)
  limit?: number;
}

/**
 * The global pipe runs with `transformOptions: { enableImplicitConversion: false }`, so nothing
 * else coerces a query string. Returns the original value when it is not numeric rather than
 * `NaN`, so a rejected input stays legible in a log — `admin-product-query.dto.ts` carries the
 * same helper and the fuller reasoning.
 */
function toQueryNumber(value: unknown): unknown {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? value : parsed;
}
