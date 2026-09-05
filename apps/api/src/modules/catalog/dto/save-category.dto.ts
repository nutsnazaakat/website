import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { SeoDto } from './save-product.dto';

/** Same rule as a product slug, and for the same reason: a slug is a URL. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * `POST /admin/categories` — brief §7's twelve categories, editable.
 *
 * Every editable column on `Category`: slug, name, image, blurb, description, sortOrder,
 * isPublished, seo. Unlike a product, `isPublished` **is** settable here, and the asymmetry is
 * deliberate rather than an oversight — spec §6.4 gives products a publish/unpublish pair of
 * endpoints and gives categories none, so a category's only route to being published is this field.
 * Adding a `POST /admin/categories/:id/publish` to make the two symmetrical would be inventing
 * surface the spec does not list.
 *
 * `SeoDto` is imported from `save-product.dto.ts` rather than redeclared: `categories.seo` and
 * `products.seo` are the same three-field jsonb column, and two DTOs for one shape is how they come
 * to disagree about `ogImage`'s length.
 */
export class CreateCategoryDto {
  @ApiProperty({ example: 'almonds' })
  @IsString()
  @MaxLength(80)
  @Matches(SLUG_PATTERN, {
    message: 'slug must be lowercase letters, digits and single hyphens',
  })
  slug: string;

  @ApiProperty({ example: 'Almonds' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 'https://images.example.com/almonds.jpg' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  image: string;

  /** The short line under the tile on the categories rail. */
  @ApiProperty({ example: 'Badam, graded and crisp' })
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  blurb: string;

  @ApiProperty({ example: 'Graded almond kernels from California, Iran and Afghanistan.' })
  @IsString()
  @MinLength(2)
  description: string;

  /** Display order on the storefront. Ties break on id, so a duplicate is stable, not random. */
  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;

  /** Defaults to **true**, matching the column: a category with no products is harmless. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;

  /** `@ValidateNested` and `@Type` together, or neither works — see `CreateProductDto.seo`. */
  @ApiPropertyOptional({ type: SeoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SeoDto)
  seo?: SeoDto;
}

/** `PATCH /admin/categories/:id`. `PartialType` for the reason `UpdateProductDto` records. */
export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {}
