import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import type { Badge } from '@nutwala/shared';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * `BESTSELLER` | `NEW` | `PREMIUM`, derived from the shared union rather than hand-listed.
 *
 * A `Record` keyed on the union is checked in both directions, so a fourth badge added in `shared/`
 * cannot reach this DTO as a value the client's own types call legal and the server answers 400
 * for. `product-query.dto.ts` derives its `SORTS` and `CHANNELS` the same way.
 */
const BADGES = Object.keys({
  BESTSELLER: true,
  NEW: true,
  PREMIUM: true,
} satisfies Record<Badge, true>) as Badge[];

/**
 * Lowercase letters, digits and single hyphens. Brief §39 and every existing seeded slug.
 *
 * Enforced here rather than only by the unique index, because a slug is a URL: `Premium Almonds`
 * would be accepted by a bare `@IsString()`, stored, and then 404 on the storefront under whatever
 * the client happened to encode it as.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Brief §39. Held as jsonb because the three fields always travel together. */
export class SeoDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(400)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  ogImage?: string;
}

/**
 * `POST /admin/products` — brief §30's product management form.
 *
 * **What is here and what is not, as one rule:** every editable scalar on `Product`, and nothing
 * else. That covers brief §30's own list — name, slug, description, category, HSN, GST, origin,
 * grade, ingredients, shelf life, storage — plus the six the entity or the storefront requires and
 * §30's prose does not enumerate (`subtitle`, `processing`, `badge`, `moqKg`, `quoteOnly`, `seo`).
 * Four columns are deliberately excluded:
 *
 * - `ratingAvg` and `reviewCount` are denormalised aggregates of the `reviews` table, recomputed
 *   when a review is approved or rejected. Letting an operator type them would put the database in
 *   permanent disagreement with itself — `catalog.seed.ts` records the same reasoning for not
 *   carrying the mock's display figures across.
 * - `isPublished` and `publishedAt` belong to `POST /admin/products/:id/publish` and its twin
 *   (spec §6.4). A product therefore **always begins unpublished**, which is both what a draft is
 *   and what keeps the `product.publish` audit action meaningful: if create could publish, the
 *   audit trail would have a live listing with no publish event behind it.
 *
 * **Brief §30 lists "SKU" among the product fields and this DTO has none. Raised, not silently
 * chosen:** there is no `products.sku` column. SKU in this schema is per *variant*
 * (`product_variants.sku`, unique index `uq_product_variants_sku`), which is also where §30's own
 * "Variants: weight, SKU, price, MRP, …" sentence puts it, and where `OrderItem` and the stock
 * ledger address it. A product-level SKU would need a migration and would be a second SKU
 * vocabulary with no consumer — so `CreateVariantDto.sku` is what answers §30 here.
 */
export class CreateProductDto {
  @ApiProperty({ example: 'Premium California Almonds' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @ApiProperty({ example: 'premium-california-almonds' })
  @IsString()
  @MaxLength(120)
  @Matches(SLUG_PATTERN, {
    message: 'slug must be lowercase letters, digits and single hyphens',
  })
  slug: string;

  /** A category **id**, because spec §6.4 addresses admin resources by uuid throughout. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  categoryId: string;

  @ApiProperty({ example: 'Crunchy, uniform kernels for daily snacking.' })
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  subtitle: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  description: string;

  @ApiProperty({ example: 'California, USA' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  origin: string;

  @ApiProperty({ example: 'Independence' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  grade: string;

  @ApiProperty({ example: 'Cleaned, sorted and machine graded' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  processing: string;

  @ApiProperty({ example: '9 months from packing' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  shelfLife: string;

  @ApiProperty({ example: 'Store in a cool, dry place. Refrigerate after opening.' })
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  storage: string;

  @ApiProperty({ example: 'Almonds' })
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  ingredients: string;

  /** Required on a compliant Indian GST tax invoice, and snapshotted onto every `OrderItem`. */
  @ApiProperty({ example: '0802' })
  @IsString()
  @MinLength(4)
  @MaxLength(12)
  hsn: string;

  /**
   * Whole or fractional percent — 5, 12, 18, or 12.5. Not money, so this is a plain number and the
   * column is `numeric(5,2)`.
   *
   * `maxDecimalPlaces: 2` matches the column's scale, so an over-precise rate is a named validation
   * failure rather than a value Postgres silently rounds. `@Max(100)` because a GST rate above par
   * is a typo, not a tax band.
   */
  @ApiProperty({ example: 5 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  gstRate: number;

  /** Brief §16's minimum bulk order, in kilograms. `numeric(8,2)`. */
  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999)
  moqKg?: number;

  /** Brief §47's "Quote Required". Checked before any tier, so it wins over a priced slab. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  quoteOnly?: boolean;

  @ApiPropertyOptional({ enum: BADGES })
  @IsOptional()
  @IsIn(BADGES)
  badge?: Badge;

  /**
   * `@ValidateNested` **and** `@Type` together, or neither works. Without `@Type` the pipe leaves
   * `seo` a plain object and class-validator has no metadata to recurse into, so every nested rule
   * is silently skipped; without `@ValidateNested` it never recurses at all. `forbidNonWhitelisted`
   * then rejects an unknown key inside `seo` too, which is what makes a typo there a 400 rather
   * than a jsonb column quietly carrying a field nothing reads.
   */
  @ApiPropertyOptional({ type: SeoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SeoDto)
  seo?: SeoDto;
}

/**
 * `PATCH /admin/products/:id`.
 *
 * `PartialType` rather than a hand-written twin, matching `UpdateAddressDto`: it copies the
 * inherited validation metadata and adds `@IsOptional()` to each property, so a rule added above
 * cannot be forgotten here. **Optional and lenient are different things** — an omitted field means
 * "leave unchanged", but a field that *is* sent still has to satisfy every rule it inherited, so a
 * PATCH cannot slip an invalid slug past the check a POST enforces.
 */
export class UpdateProductDto extends PartialType(CreateProductDto) {}
