import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { BLOG_CATEGORIES, type BlogCategory } from '@nutwala/shared';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * `GET /admin/posts`' query string.
 *
 * `isPublished` is a filter here and not on the public list, where it is a fixed condition. That
 * asymmetry is the whole difference between the two endpoints: an editor needs to see drafts and a
 * visitor must not.
 */
export class AdminPostQueryDto {
  @ApiPropertyOptional({ enum: BLOG_CATEGORIES, example: 'Recipes' })
  @IsOptional()
  @IsIn(BLOG_CATEGORIES)
  category?: BlogCategory;

  /** Omitted means both — the drafts and the live posts, which is what an editor's index is. */
  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => toQueryBoolean(value))
  @IsBoolean()
  isPublished?: boolean;

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

/** `'true'` / `'false'` only; anything else falls through to `@IsBoolean()` and a named 400. */
function toQueryBoolean(value: unknown): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}
