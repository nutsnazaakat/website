import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, ValidateNested } from 'class-validator';
import { CartLineDto } from './replace-cart.dto';

/**
 * Validation is open to guests and takes the lines in the body rather than reading the stored cart,
 * so the checkout page can validate what the customer is looking at — which may differ from what was
 * last saved if a save is still in flight.
 *
 * Omitting `lines` validates the stored cart instead, which is what the cart page wants.
 */
export class ValidateCartDto {
  @ApiPropertyOptional({ type: [CartLineDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CartLineDto)
  lines?: CartLineDto[];
}
