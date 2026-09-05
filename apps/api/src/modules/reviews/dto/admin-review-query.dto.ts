import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import type { ReviewStatus } from '@nutwala/shared';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Derived through a `satisfies` record, so a status added to `shared`'s `ReviewStatus` is a compile
 * error here rather than a value the client's own types call legal and the server answers 400 for.
 */
const REVIEW_STATUSES = Object.keys({
  pending: true,
  approved: true,
  rejected: true,
} satisfies Record<ReviewStatus, true>) as ReviewStatus[];

/**
 * `GET /admin/reviews`' query string — brief §27's moderation queue.
 *
 * **`status` defaults to `pending` in the service, not here**, and the difference matters: a default
 * applied in the DTO would make `?status=` and an omitted parameter indistinguishable in the
 * service, and would put the queue's definition in a validation class. The default is the queue —
 * an operator opens this page to moderate, and an unfiltered list of every review ever written is
 * not that. Passing `?status=approved` is how you look at the rest.
 *
 * There is no "all statuses" value, deliberately. Three explicit filters cover every question, and
 * a magic fourth string (`?status=any`) would be a value outside `ReviewStatus` that the shared
 * union could never describe.
 */
export class AdminReviewQueryDto {
  /** Omitted means `pending` — the queue. See the class docblock. */
  @ApiPropertyOptional({ enum: REVIEW_STATUSES, example: 'pending' })
  @IsOptional()
  @IsIn(REVIEW_STATUSES)
  status?: ReviewStatus;

  /**
   * Narrow to one product, by slug.
   *
   * `reviews.productSlug` is a **snapshot** column carrying `idx_reviews_product_slug`, so this
   * finds the reviews of a product that has since been deleted as well as one that still exists —
   * which is the right behaviour for a moderation queue, where the review outlives the product by
   * design (`product_id` is `ON DELETE SET NULL`).
   */
  @ApiPropertyOptional({ example: 'w320-cashews' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  productSlug?: string;

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
function toQueryNumber(value: unknown): unknown {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? value : parsed;
}
