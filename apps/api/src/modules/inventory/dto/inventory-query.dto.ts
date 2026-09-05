import { ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * What an operator opens the stock screen to find.
 *
 * `low` is inclusive of `out` — spec §12's rule is `available <= lowStockThreshold` and a threshold
 * is never negative, so a variant at zero satisfies it too. That containment is why this is one
 * enum rather than two booleans: `?low=true&out=false` is a question with no useful answer, and
 * offering it invites a client to ask it. `low` is "everything that needs ordering", `out` is
 * "everything already lost", and omitting the parameter is every stock position there is.
 */
const STOCK_STATUSES = ['low', 'out'] as const;
export type StockStatusFilter = (typeof STOCK_STATUSES)[number];

/**
 * `GET /admin/inventory`'s query string.
 *
 * Four parameters and no more, for the reason `admin-product-query.dto.ts` states: the global
 * `ValidationPipe` runs with `forbidNonWhitelisted`, so an undeclared parameter is a 400 today
 * rather than a filter silently ignored while an unfiltered page comes back. Adding one later is
 * therefore safe; declaring speculative ones now is not free.
 */
export class InventoryQueryDto {
  /**
   * SKU or product name, case-insensitive substring.
   *
   * The two things an operator has in front of them when they come looking for one pack: the label
   * on the sack, or the product they were just told about. Not `size` — every 1kg pack in the
   * catalogue would match — and not the variant uuid, which nobody types.
   */
  @ApiPropertyOptional({ example: 'almond' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  /** Omitted means every stock position. See `STOCK_STATUSES`. */
  @ApiPropertyOptional({ enum: STOCK_STATUSES, example: 'low' })
  @IsOptional()
  @IsIn(STOCK_STATUSES)
  status?: StockStatusFilter;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toQueryNumber(value))
  @IsInt()
  @Min(1)
  page?: number;

  /**
   * Capped at 60, matching `AdminProductQueryDto` and `ProductQueryDto` — a list endpoint must not
   * be turnable into a table dump. The service clamps as well, so this is about telling a caller
   * their request was wrong rather than quietly answering a different question.
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
 * `GET /admin/inventory/:variantId/transactions`' query string — pagination only.
 *
 * `PickType` rather than a second declaration of the same two fields, so the cap and the coercion
 * cannot drift apart between the two lists. There is no `status` or `q` here on purpose: a ledger
 * is read from the top, and filtering an audit trail by *type* is how an operator misses the row
 * that explains the discrepancy they were chasing.
 */
export class InventoryLedgerQueryDto extends PickType(InventoryQueryDto, [
  'page',
  'limit',
] as const) {}

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
