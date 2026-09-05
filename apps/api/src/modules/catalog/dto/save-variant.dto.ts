import { ApiProperty, ApiPropertyOptional, PartialType, PickType } from '@nestjs/swagger';
import type { Channel } from '@nutwala/shared';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * The wire channel vocabulary, derived from the shared union rather than hand-listed — the same
 * `Record`-keyed derivation `product-query.dto.ts` uses, checked in both directions.
 *
 * The wire is lowercase (`retail`) and the column is an uppercase enum (`RETAIL`).
 * `TO_DB_CHANNEL` in `catalog.service.ts` is the one map between them and is imported by the
 * service that writes this DTO, rather than a second copy living here.
 */
const CHANNELS = Object.keys({
  retail: true,
  bulk: true,
} satisfies Record<Channel, true>) as Channel[];

/**
 * Money arrives in **rupees**, per spec §8's boundary rule: "API responses convert to rupee numbers
 * at the boundary", and a request body is the same boundary read the other way. The service
 * converts with `toPaise`, once.
 *
 * `maxDecimalPlaces: 2` is what keeps that conversion from throwing. `toPaise` **rejects** sub-paise
 * input rather than rounding — deliberately, because "a price of ₹12.345 is a data-entry mistake,
 * and silently storing ₹12.35 would make the stored catalogue disagree with what an admin typed" —
 * and an unguarded `RangeError` from a service is a 500. With this decorator ₹12.345 is a 400
 * naming the field, which is the same refusal delivered usefully.
 *
 * `@Max` is a sanity bound, not a business rule: ₹1 crore for a single pack is a slipped decimal
 * point. It also keeps the value far inside the range `toPaise`'s own float-residual sweep covers.
 */
const RUPEE_CEILING = 10_000_000;

export class CreateVariantDto {
  /**
   * Brief §30's "SKU", and the only SKU this schema has — `products` carries no such column.
   * Unique across the whole table (`uq_product_variants_sku`), which the service checks before
   * inserting so a collision is a named 409 rather than a driver error.
   */
  @ApiProperty({ example: 'PCA-1KG' })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  sku: string;

  /** Brief §30's "weight" as a customer reads it: `100g`, `1kg`, `50kg`. */
  @ApiProperty({ example: '1kg' })
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  size: string;

  /**
   * The canonical unit behind `size`, for brief §47's per-100g and per-kg comparison.
   *
   * Kept as its own field rather than parsed out of `size`: a parser would have to guess at `1.5kg`,
   * `500 g` and `½ kg`, and the figure it produces is what every price comparison on the storefront
   * divides by. Two fields that can disagree is the lesser risk, and the pair is what the seeded
   * catalogue already holds.
   */
  @ApiProperty({ example: 1000 })
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  grams: number;

  @ApiProperty({ enum: CHANNELS, example: 'retail' })
  @IsIn(CHANNELS)
  channel: Channel;

  /** GST-**exclusive**, matching the column. `gstOn` adds tax on top of this at checkout. */
  @ApiProperty({ example: 899 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(RUPEE_CEILING)
  price: number;

  /**
   * By law a consumer-facing **inclusive** figure, unlike `price` — the two are not directly
   * comparable, and `product-variant.entity.ts` says so at the column. Not validated against
   * `price`, deliberately: an MRP below the selling price is legitimate for a loss-leader and
   * illegal to print, which is a commercial judgment the server has no basis to make.
   */
  @ApiProperty({ example: 1045 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(RUPEE_CEILING)
  mrp: number;

  /** Minimum order quantity in packs. Brief §30. */
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  moq?: number;

  /**
   * Defaults to true. A false here creates a pack that exists but is not offered, which is the same
   * state `PATCH /admin/variants/:id` puts a withdrawn pack into.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /**
   * The threshold on the `Inventory` row created alongside this variant. Brief §32's "low stock".
   *
   * **The one place in spec §6.4's whole admin surface where a threshold can be set at all**, which
   * is why it is here rather than left to the column's default of 10:
   * `PATCH /admin/inventory/:variantId` takes only a signed delta and a reason, and
   * `GET /admin/inventory` is a read. Reported as a gap for plan 9.2 rather than solved by inventing
   * a route this plan does not own.
   *
   * `onHand` is deliberately **not** settable. A variant is created with zero stock and stock
   * arrives through the audited inventory path, because `SUM(inventory_transactions.delta) =
   * inventory.onHand` per variant is an invariant `schema-invariants.integration.spec.ts` asserts —
   * an opening figure written straight into the column with no ledger row behind it would break it
   * on the first variant anyone created.
   */
  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  lowStockThreshold?: number;
}

/**
 * `PATCH /admin/variants/:id`.
 *
 * `PickType` first, then `PartialType`: `lowStockThreshold` is excluded because it belongs to the
 * `Inventory` row, not the variant, and letting a variant PATCH reach across into stock would put a
 * second writer on a table whose whole design is that `InventoryService` is the only one — the
 * ledger invariant depends on it. `productId` is not here either: moving a variant between products
 * would orphan its stock ledger against the wrong catalogue entry, and the operation an operator
 * actually wants is to deactivate one and create another.
 */
export class UpdateVariantDto extends PartialType(
  PickType(CreateVariantDto, [
    'sku',
    'size',
    'grams',
    'channel',
    'price',
    'mrp',
    'moq',
    'isActive',
  ] as const),
) {}
