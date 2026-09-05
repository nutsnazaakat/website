import { ApiPropertyOptional } from '@nestjs/swagger';
import { BLOG_CATEGORIES, type BlogCategory } from '@nutwala/shared';
import { IsIn, IsOptional } from 'class-validator';

/**
 * `GET /content/posts`' query string — spec §6.1's `?category`, and nothing else.
 *
 * `@IsIn(BLOG_CATEGORIES)` against the shared tuple, so the six brief §28 categories are declared
 * once and this DTO cannot drift from the storefront's own filter chips. An unknown category is a
 * **400**, not an empty list: the global pipe runs with `forbidNonWhitelisted`, the value comes
 * from a closed set the client already holds, and silently answering "no posts" for a misspelled
 * category is indistinguishable from a genuinely empty section.
 *
 * `BLOG_CATEGORIES` is a `readonly` tuple of literals and `@IsIn` takes `readonly unknown[]`, so it
 * is passed straight through — no spread, no cast.
 */
export class PostQueryDto {
  @ApiPropertyOptional({ enum: BLOG_CATEGORIES, example: 'Buying Guides' })
  @IsOptional()
  @IsIn(BLOG_CATEGORIES)
  category?: BlogCategory;
}
