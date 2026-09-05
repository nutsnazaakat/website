import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { BLOG_CATEGORIES, type BlogCategory } from '@nutwala/shared';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Same rule as a product and a category slug, and for the same reason: a slug is a URL. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Brief §39's SEO block for a post — title, meta description, OG image.
 *
 * A class of its own here rather than the catalogue's `SeoDto`, and that is the one place this DTO
 * departs from `save-category.dto.ts`'s "import it, do not redeclare it". The two blocks are the
 * same *shape* but not the same column: `products.seo`/`categories.seo` and `blog_posts.seo` are
 * three separate `jsonb` columns on three tables, and the lengths that make sense for a product
 * page's meta description are not obviously the ones for an article. Sharing the class would make
 * a length change for one silently a length change for all three.
 *
 * Brief §39's fourth field, the slug, is not here: it is `slug` on the post itself, because it is
 * the row's identity as well as an SEO field.
 */
export class PostSeoDto {
  @ApiPropertyOptional({ example: 'How to Choose the Right Almonds | Nuts & Nazaakat' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ example: 'Californian, Mamra and Gurbandi almonds behave differently.' })
  @IsOptional()
  @IsString()
  @MaxLength(320)
  description?: string;

  @ApiPropertyOptional({ example: 'https://images.example.com/almonds-og.jpg' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  ogImage?: string;
}

/**
 * `POST /admin/posts` — brief §28's editorial blog, brief §39's SEO fields.
 *
 * Every editable column on `BlogPost`. `publishedAt` is **not** among them: it is stamped by the
 * service on first publication and never cleared, exactly as `products.publishedAt` is, so an
 * unpublish/republish cycle does not rewrite the only record of when the post first existed.
 */
export class CreatePostDto {
  @ApiProperty({ example: 'how-to-store-dry-fruits-at-home' })
  @IsString()
  @MaxLength(160)
  @Matches(SLUG_PATTERN, {
    message: 'slug must be lowercase letters, digits and single hyphens',
  })
  slug: string;

  @ApiProperty({ example: 'How to Store Dry Fruits at Home' })
  @IsString()
  @MinLength(2)
  @MaxLength(250)
  title: string;

  /** One of brief §28's six, through the shared tuple so the vocabulary is declared once. */
  @ApiProperty({ enum: BLOG_CATEGORIES, example: 'Storage Tips' })
  @IsIn(BLOG_CATEGORIES)
  category: BlogCategory;

  /** The line under the card on the blog index. */
  @ApiProperty({ example: 'Airtight, cool and dark, in that order of importance.' })
  @IsString()
  @MinLength(2)
  @MaxLength(400)
  excerpt: string;

  @ApiProperty({ example: 'https://images.example.com/storage.jpg' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  image: string;

  @ApiProperty({ example: 'Nuts & Nazaakat' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  author: string;

  /** The article. `text`, so no length cap here beyond the 1 MB request body limit. */
  @ApiProperty({ example: 'Dry fruits go stale for two reasons: air and warmth.' })
  @IsString()
  @MinLength(2)
  body: string;

  /**
   * Defaults to **false**, matching the column — a post is created as a draft.
   *
   * The same rule plan 9.1 set for products ("products are always created unpublished, so every
   * live listing has a `product.publish` audit row behind it"), reached differently: §6.4 gives a
   * product a publish endpoint and gives a post none, so publication is an ordinary field here and
   * the trail carries it as `post.update` with `isPublished` in `before`/`after`.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;

  /** `@ValidateNested` and `@Type` together, or neither works — see `CreateProductDto.seo`. */
  @ApiPropertyOptional({ type: PostSeoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PostSeoDto)
  seo?: PostSeoDto;
}

/**
 * `PATCH /admin/posts/:slug`. `PartialType`, so every field is optional — **including `slug`**.
 *
 * **A published post's slug may be changed, and the old URL then 404s.** Recorded rather than
 * assumed, because it is a decision:
 *
 * - Brief §39 makes the slug an editable SEO field for "every product, category and blog post". A
 *   typo in a live URL is exactly what an operator must be able to fix, and the alternative —
 *   delete and recreate — destroys the row, its `publishedAt` and its audit history.
 * - **A published product's slug is already mutable**, in `AdminProductsService.update`, with no
 *   published check. Making a post stricter would be a second rule for one question, and the
 *   inconsistency would be discovered by whoever hit it rather than decided by anyone.
 * - The rename is auditable end to end: `audit_logs.entityId` is the slug, so a `post.update` row
 *   carrying `before.slug` and `after.slug` is the only join between the two identities. That is
 *   why the rename is audited with both halves.
 *
 * **What happens to the old URL: nothing. It 404s.** There is no redirect table in this schema and
 * inventing one is a migration and a new concept this plan has no mandate for — so the honest
 * statement is that renaming a live post drops its inbound links, and closing that gap means a
 * `blog_post_redirects` table (or an `alias` column) that `ContentService.get` falls back to.
 * Reported, not built.
 */
export class UpdatePostDto extends PartialType(CreatePostDto) {}
