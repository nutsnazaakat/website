import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { MAX_LINE_QTY } from '../cart.constants';

export class CartLineDto {
  @ApiProperty() @IsString() @MaxLength(120) slug: string;

  @ApiProperty({ enum: ['retail', 'bulk'] })
  @IsIn(['retail', 'bulk'])
  mode: 'retail' | 'bulk';

  /**
   * Retail only — the pack size, which resolves the variant. **Required when `mode` is `retail`.**
   *
   * `@ValidateIf`, not `@IsOptional`, and the two must not be combined: `@IsOptional()` skips every
   * other decorator when the value is absent, which is precisely the case being rejected here.
   */
  @ApiPropertyOptional()
  @ValidateIf((line: CartLineDto) => line.mode === 'retail')
  @IsString()
  @MaxLength(20)
  size?: string;

  /**
   * Bulk only — the weight. **Required when `mode` is `bulk`.**
   *
   * Conditional rather than merely optional, because a bulk line without a weight is accepted by an
   * `@IsOptional()` rule, stored with `kg = null`, and then reports `BELOW_MOQ` forever: `verdictFor`
   * reads `Number(line.kg ?? 0)` and `0 < moqKg` is always true. The customer ends up with a basket
   * line that can never validate and that they can only fix by deleting — for a field they never knew
   * they had to send. The retail side is not symmetric today but is just as wrong: a missing `size`
   * falls through to `variants.find(... candidate.size === undefined ...)`, which matches nothing and
   * raises *"That pack size is no longer available"* — a stock message for a malformed request.
   *
   * Both now fail validation, where the response names the field.
   */
  @ApiPropertyOptional()
  @ValidateIf((line: CartLineDto) => line.mode === 'bulk')
  @IsNumber()
  @Min(0.01)
  @Max(100_000)
  kg?: number;

  /**
   * Capped at `MAX_LINE_QTY`. A cart does not reserve stock, so a large quantity is not itself an
   * attack — but an unbounded integer reaches an `int` column and a `bigint` multiplication, and 999 of
   * anything is past the point where a customer should be using the RFQ form instead.
   *
   * The number lives in `cart.constants.ts` because `mergeLines` has to honour the same bound: it
   * inserts straight into `cart_items` without passing through this class, so a merge that summed past
   * this cap would store a basket that every later `PUT` to this endpoint rejects. Do not restate the
   * literal, and do not move it into `cart.service.ts` — that file imports this one.
   */
  @ApiProperty() @IsInt() @Min(1) @Max(MAX_LINE_QTY) qty: number;
}

export class ReplaceCartDto {
  /**
   * The whole basket, replacing whatever is stored.
   *
   * Capped at 50 lines: the shop has 27 products with 8 variants each, so a legitimate basket is far
   * smaller, and an uncapped array is an unbounded transaction and an unbounded response.
   */
  @ApiProperty({ type: [CartLineDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CartLineDto)
  lines: CartLineDto[];
}
