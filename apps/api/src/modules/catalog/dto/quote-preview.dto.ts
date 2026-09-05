import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * `POST /catalog/bulk/quote-preview`'s body. Spec §6.1's bulk calculator: a slug and a weight, so
 * the server can answer with the rate the caller's own viewer resolves to.
 */
export class QuotePreviewDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  slug: string;

  /**
   * Kilograms, and a `number` rather than a string because the ladder compares numerically.
   * `@Max(10_000)` because `pricing_tiers."minKg"`/`"maxKg"` are `numeric(8,2)` and an unbounded
   * value is the SQLSTATE-22003 sibling of the `22001` the address `label` cap prevents —
   * `@Min(0.01)` for the same reason at the other end, and because a zero-kilogram quote is not a
   * real request.
   */
  @ApiProperty()
  @IsNumber()
  @Min(0.01)
  @Max(10_000)
  kg: number;
}
