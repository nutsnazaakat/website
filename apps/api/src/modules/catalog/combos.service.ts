import { Inject, Injectable } from '@nestjs/common';
import type { Combo, ComboComponent, Product, Variant } from '@nutwala/shared';
import { WinstonLoggerService } from '../../common/logging/winston-logger.service';
import { CatalogService } from './catalog.service';
import type { ComboComposition } from './combo-composition';

/** Injected so the spec can supply its own fixtures instead of the real six. */
export const COMBO_COMPOSITION_SOURCE = 'COMBO_COMPOSITION_SOURCE';

/** Every box holds 4 × 250g, so the box's own 1kg pack is what the combo costs. */
const BOX_GRAMS = 1000;

/**
 * A combo card is a retail offer, so only retail packs may price it.
 *
 * The size and weight alone do not identify a pack: a bulk row of the same weight carries a
 * wholesale rate, and pricing a public gift card off one understates the price. Phase 1 got this for
 * free because its mock had no bulk pack under 5kg; the seeded catalogue has the same shape today,
 * which is exactly why the constraint is worth stating rather than relying on.
 */
const retailPack = (
  product: Product,
  matches: (variant: Variant) => boolean,
): Variant | undefined =>
  product.variants.find((variant) => variant.channel === 'retail' && matches(variant));

@Injectable()
export class CombosService {
  constructor(
    private readonly catalog: CatalogService,
    @Inject(COMBO_COMPOSITION_SOURCE) private readonly compositions: readonly ComboComposition[],
    private readonly logger: WinstonLoggerService,
  ) {
    this.logger.setContext(CombosService.name);
  }

  /**
   * Assembles every combo from live catalogue prices.
   *
   * One query for every product involved — the boxes and their components together — rather than one
   * per combo, because six combos of four components each would otherwise be thirty round trips for
   * a page that renders six cards.
   */
  async list(): Promise<Combo[]> {
    const slugs = new Set<string>();
    for (const composition of this.compositions) {
      slugs.add(composition.slug);
      for (const component of composition.components) slugs.add(component.slug);
    }

    // `undefined`, not a resolved viewer: `Combo`/`ComboComponent` (`@nutwala/shared`) carry no
    // `bulkTiers` field, so a combo box's per-viewer ladder is computed by `toWireProduct` and then
    // discarded here. Threading a real caller through `/catalog/combos` — which has no session
    // context today — would buy a `businesses` lookup nothing in this file reads.
    const products = await this.catalog.productsBySlugs([...slugs], undefined);
    const bySlug = new Map(products.map((product) => [product.slug, product]));

    return this.compositions
      .map((composition) => this.assemble(composition, bySlug))
      .filter((combo): combo is Combo => combo !== null);
  }

  private assemble(
    composition: ComboComposition,
    bySlug: ReadonlyMap<string, Product>,
  ): Combo | null {
    const boxProduct = bySlug.get(composition.slug);
    if (!boxProduct) {
      this.logger.warn('Combo omitted: its box product is missing', {
        comboSlug: composition.slug,
      });
      return null;
    }

    const boxVariant = retailPack(boxProduct, (variant) => variant.grams === BOX_GRAMS);
    if (!boxVariant) {
      this.logger.warn('Combo omitted: its box has no 1kg retail pack', {
        comboSlug: composition.slug,
      });
      return null;
    }

    const components: ComboComponent[] = [];
    for (const wanted of composition.components) {
      const product = bySlug.get(wanted.slug);
      const variant = product && retailPack(product, (candidate) => candidate.size === wanted.size);
      if (!product || !variant) {
        // Omit the whole combo rather than a component: a box advertising four things and listing
        // three misprices itself and misleads the customer.
        this.logger.warn('Combo omitted: a component could not be resolved', {
          comboSlug: composition.slug,
          componentSlug: wanted.slug,
          size: wanted.size,
        });
        return null;
      }
      components.push({
        slug: product.slug,
        name: product.name,
        size: variant.size,
        grams: variant.grams,
        price: variant.price,
        mrp: variant.mrp,
      });
    }

    const partsPrice = components.reduce((sum, component) => sum + component.price, 0);
    const partsMrp = components.reduce((sum, component) => sum + component.mrp, 0);
    // Floored at zero: brief §1 forbids unsupported claims, and "save -₹1401" is worse than silence.
    const savings = Math.max(0, partsMrp - boxVariant.price);

    return {
      slug: boxProduct.slug,
      name: boxProduct.name,
      subtitle: boxProduct.subtitle,
      blurb: composition.blurb,
      occasion: composition.occasion,
      image: boxProduct.images[0] ?? '',
      price: boxVariant.price,
      partsMrp,
      partsPrice,
      savings,
      savingsPercent: partsMrp > 0 ? Math.round((savings / partsMrp) * 100) : 0,
      totalGrams: components.reduce((sum, component) => sum + component.grams, 0),
      components,
    };
  }
}
