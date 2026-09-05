import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Mirrors `frontend/src/features/reviews/schema.ts` so a submission the form accepts is not then
 * rejected by the server. `productSlug` is absent on purpose: it comes from the route, not the body,
 * so a caller cannot post a review for one product while reading another.
 *
 * `verifiedPurchase` is absent for a stronger reason. The global `ValidationPipe` runs with
 * `forbidNonWhitelisted: true`, so a client that sends it gets a 400 naming the field rather than
 * having it quietly stripped — which is the behaviour worth having, because a caller who thinks they
 * set the badge should be told they cannot instead of being left to assume it worked.
 */
export class CreateReviewDto {
  @ApiProperty({ example: 'Asha R.' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  author: string;

  @ApiProperty({ minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiProperty({ example: 'Fresh, and the 500g pack is the right size for us.' })
  @IsString()
  @MinLength(20)
  @MaxLength(2000)
  body: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(500)
  imageUrl?: string;
}
