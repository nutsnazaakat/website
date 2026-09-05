import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { RFQ_STATUSES, type RfqStatus } from '@nutwala/shared';

/** Brief §17's two front doors, on the wire. `RfqKind` is `'bulk' | 'gifting'`; restating the two
 * literals here would be a second vocabulary, so the tuple is spelled once and typed against the
 * shared union by `@IsIn`. */
export const RFQ_KINDS = ['bulk', 'gifting'] as const;

/**
 * `GET /admin/rfqs`' query string — brief §34's queue.
 *
 * A DTO of its own, for `AdminProductQueryDto`'s reason: the global `ValidationPipe` runs with
 * `forbidNonWhitelisted`, so an undeclared parameter is a 400 rather than a filter silently ignored
 * while an unfiltered page comes back.
 */
export class AdminRfqQueryDto {
  /**
   * **`RFQ_STATUSES` from `@nutwala/shared`, never a list written here.** Brief §34's seven-state
   * pipeline is spelled in exactly one place and `RFQ_TRANSITIONS` is the only rule about what
   * follows what; a filter vocabulary of its own would be the second copy, and the one that drifts
   * the day an eighth state is discussed.
   */
  @ApiPropertyOptional({ enum: RFQ_STATUSES })
  @IsOptional()
  @IsIn(RFQ_STATUSES)
  status?: RfqStatus;

  /** Bulk or gifting. Omitted means both, which is the queue an operator triages. */
  @ApiPropertyOptional({ enum: RFQ_KINDS })
  @IsOptional()
  @IsIn(RFQ_KINDS)
  kind?: (typeof RFQ_KINDS)[number];

  /**
   * RFQ number, business name, contact person or email — case-insensitive substring.
   *
   * The RFQ number is included because it is the reference a prospect quotes down a phone line, and
   * `RfqsController` records that quoting it to the sales desk is a no-account prospect's **only**
   * recovery path. An operator who cannot search for it has no way to act on that call.
   */
  @ApiPropertyOptional({ example: 'RFQ-2026-0001' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toQueryNumber(value))
  @IsInt()
  @Min(1)
  page?: number;

  /** Capped at 60, the ceiling every other admin list uses. The service clamps as well, so this is
   * about telling a caller their request was wrong rather than quietly answering a different
   * question. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toQueryNumber(value))
  @IsInt()
  @Min(1)
  @Max(60)
  limit?: number;
}

/** See `admin-product-query.dto.ts` — the global pipe does not coerce a query string, and a
 * non-numeric value is returned unchanged rather than as `NaN` so it stays legible in a log. */
function toQueryNumber(value: unknown): unknown {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? value : parsed;
}
