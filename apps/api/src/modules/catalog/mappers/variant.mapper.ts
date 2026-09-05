import { toRupees, variantSoldOut, type Channel, type Variant } from '@nutwala/shared';
import { VariantChannel } from '../../../entities/enums';
import type { ProductVariant } from '../../../entities/catalog/product-variant.entity';

/**
 * The database enum is uppercase; the wire vocabulary is lowercase. Same translation shape as
 * `user.mapper.ts` does for roles, and for the same reason: the two vocabularies are both correct
 * and the mapper is the single place they meet.
 */
const TO_WIRE_CHANNEL: Record<VariantChannel, Channel> = {
  [VariantChannel.RETAIL]: 'retail',
  [VariantChannel.BULK]: 'bulk',
};

/**
 * `available` is `onHand - reserved` (spec §10.1). `Inventory` is a separate row so stock writes
 * never contend with catalogue reads, which means the relation can legitimately be absent — a
 * variant created without one has nothing to sell, so it maps to zero rather than to `NaN`.
 */
export function availableFor(variant: ProductVariant): number {
  const inventory = variant.inventory;
  if (!inventory) return 0;
  return inventory.onHand - inventory.reserved;
}

export function toWireVariant(variant: ProductVariant): Variant {
  const available = availableFor(variant);
  return {
    sku: variant.sku,
    size: variant.size,
    grams: variant.grams,
    channel: TO_WIRE_CHANNEL[variant.channel],
    price: toRupees(variant.pricePaise),
    mrp: toRupees(variant.mrpPaise),
    moq: variant.moq,
    available,
    // The shared helper, never an inline comparison. `eslint.config.mjs` enforces this.
    soldOut: variantSoldOut(available),
  };
}
