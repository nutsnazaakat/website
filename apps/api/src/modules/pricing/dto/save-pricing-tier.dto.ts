import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { CUSTOMER_SEGMENTS, type CustomerSegment } from '@nutwala/shared';
import { IsIn, IsNumber, IsOptional, IsUUID, Max, Min, ValidateIf } from 'class-validator';

/** `pricing_tiers."minKg"`/`"maxKg"` are `numeric(8,2)`, so six digits before the point. 10,000 kg
 * is the same ceiling `QuotePreviewDto` puts on a quoted weight, and for the same reason: an
 * unbounded value would overflow the column rather than be refused. */
const MAX_KG = 10_000;

/** ₹1,000,000 per kilo. `pricePerKgPaise` is a `bigint`, so nothing at the database level caps this;
 * the ceiling is here so an extra zero is a 400 rather than a price somebody is charged. */
const MAX_PRICE_PER_KG = 1_000_000;

/**
 * `POST /admin/pricing-tiers` — brief §31: quantity tiers, retailer / distributor / HORECA pricing,
 * and customer-specific pricing.
 *
 * **MOQ is not here and is not missing.** `products.moqKg` is a product field, already editable
 * through `PATCH /admin/products/:id` (plan 9.1). A second writer would be a second answer to "what
 * is the minimum for this product".
 *
 * **`pricePerKg: null` is meaningful and is not "unset"**: brief §47's quote-required slab, which
 * `CatalogService.quotePreview` answers `quoteRequired: true` for. `@ValidateIf` is what lets an
 * explicit `null` reach the handler — `@IsOptional()` treats `null` as absent, so the pair
 * `@IsOptional()` + `@IsNumber()` would accept it *and* discard it, and there would be no way to
 * declare a slab quote-only.
 *
 * **`maxKg: null` is the open-ended top slab**, brief §16's "50kg+", and the same reasoning applies
 * to it. Whether `maxKg` is at least `minKg`, and whether the rung overlaps one that already
 * exists, are questions about the *ladder* rather than about this body, and both live in
 * `AdminPricingTiersService` — the second needs a database read, and the first would have to be
 * duplicated there anyway, since a `PATCH` merges these fields with the ones already stored.
 */
export class CreatePricingTierDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productId: string;

  @ApiProperty({ example: 10 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_KG)
  minKg: number;

  /** `null` for the open-ended top slab. */
  @ApiProperty({ nullable: true, example: 24 })
  @ValidateIf((_object, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_KG)
  maxKg: number | null;

  /** Rupees, per spec §8's money boundary — the service converts to `pricePerKgPaise`. `null`
   * makes the slab quote-required. */
  @ApiProperty({ nullable: true, example: 620 })
  @ValidateIf((_object, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_PRICE_PER_KG)
  pricePerKg: number | null;

  /**
   * Brief §31's price band. Defaults to `default`, matching the column — list pricing, which is
   * what an anonymous visitor and every un-banded business resolve.
   *
   * The wire vocabulary, lowercase; the service maps it to the Postgres enum through a total
   * `Record` so the two cannot grow apart.
   */
  @ApiPropertyOptional({ enum: CUSTOMER_SEGMENTS })
  @IsOptional()
  @IsIn(CUSTOMER_SEGMENTS)
  segment?: CustomerSegment;

  /**
   * Brief §31's customer-specific pricing — the one business this rung belongs to, or absent for a
   * segment ladder every business in that band resolves.
   *
   * **A business-scoped rung is resolved by `businessId` alone, whatever its `segment`** — see
   * `resolveTiers`, whose first rung filters on `businessId` and does not look at the band. That is
   * why a `DEFAULT`-segment tier scoped to a business is a legitimate row ("this business also gets
   * ordinary list pricing"), and why the overlap check groups business rungs by business rather
   * than by band.
   */
  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @ValidateIf((_object, value) => value !== null)
  @IsOptional()
  @IsUUID()
  businessId?: string | null;
}

/**
 * `PATCH /admin/pricing-tiers/:id`. `PartialType` for the reason `UpdateProductDto` records: every
 * field optional, an omitted one left unchanged, and the validators inherited rather than restated.
 *
 * `productId` is inherited and therefore movable — deliberately: a rung created against the wrong
 * product is otherwise unfixable, since spec §6.4 gives this resource no `DELETE`. Moving one
 * re-runs the overlap check against the destination ladder.
 */
export class UpdatePricingTierDto extends PartialType(CreatePricingTierDto) {}
