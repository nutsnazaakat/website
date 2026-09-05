import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  toPaise,
  toRupees,
  type CartValidationCode,
  type CartValidationLine,
  type CartValidationResult,
  type Paise,
} from '@nutwala/shared';
import { Repository } from 'typeorm';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { ErrorCodes, type ErrorCode } from '../../common/errors/domain-error';
import { Product } from '../../entities/catalog/product.entity';
import { ProductVariant } from '../../entities/catalog/product-variant.entity';
import type { Cart } from '../../entities/commerce/cart.entity';
import { OrderChannelEnum, UserRole } from '../../entities/enums';
import { Business } from '../../entities/identity/business.entity';
import { Setting } from '../../entities/ops/setting.entity';
import { cartLineId, toCartLine } from './cart-line.mapper';
import { CartPricingService, type PricedLine, type ShippingSettings } from './cart-pricing.service';
import type { CartResponse } from './cart.controller';
import type { CartLineDto } from './dto/replace-cart.dto';
import {
  resolveTiers,
  resolveTiersForWeight,
  type PricingViewer,
} from '../pricing/pricing.resolver';

/**
 * Compile-time proof that every cart validation code is a real `ErrorCode`.
 *
 * Not decoration: without it, renaming a code in the registry leaves clients branching on a string
 * the server has stopped sending, and nothing fails. `CartValidationCode` is a named type over an
 * `as const` tuple in `shared/src/types/cart.ts` precisely so something can check it, and the check
 * has to live on this side — `shared/` must not import from `backend/`.
 */
const _validationCodesExist: Record<CartValidationCode, ErrorCode> = {
  OUT_OF_STOCK: ErrorCodes.OUT_OF_STOCK,
  BELOW_MOQ: ErrorCodes.BELOW_MOQ,
  QUOTE_REQUIRED: ErrorCodes.QUOTE_REQUIRED,
  NOT_FOUND: ErrorCodes.NOT_FOUND,
};
void _validationCodesExist;

/** The minimum a line needs for a verdict. Structural, so entities and DTOs both fit. */
export interface ValidatableLine {
  id: string;
  slug: string;
  mode: 'RETAIL' | 'BULK';
  qty: number;
  kg: string | null;
  variant: { moq: number; pricePaise: Paise; available: number } | null;
  product: {
    gstRate: number;
    moqKg: number;
    /**
     * `Product.quoteOnly` — the business declaring this product has no self-service price.
     *
     * Carried here because it must be enforced **server-side**. It was not, and the consequence was
     * measured: `POST /cart/validate` for a 25kg `corporate-gift-box` returned
     * `{ ok: true, lineTotal: 33975, hasQuoteLines: false }`. The storefront honours the flag, so the
     * only thing between a negotiated custom-branded product and a self-service COD order was a React
     * boolean — precisely what spec §13 says client-side gating is worth.
     */
    quoteOnly: boolean;
    bulkTiers: { minKg: number; maxKg: number | null; pricePerKgPaise: Paise | null }[];
  } | null;
}

/** A product's rules and its tier ladder, in the units the rules read them in. */
export type ProductRules = NonNullable<ValidatableLine['product']>;
export type BulkTier = ProductRules['bulkTiers'][number];

/**
 * The tier a weight lands in, or null when the ladder has no slab for it.
 *
 * Extracted from `verdictFor` rather than duplicated, because `CheckoutService` needs the same answer:
 * a bulk `OrderItem` snapshots the per-kg rate it was billed at, and a second copy of this predicate
 * would let the rate on the invoice come from a different slab than the money on the order.
 */
export function bulkTierFor(bulkTiers: readonly BulkTier[], kg: number): BulkTier | null {
  return (
    bulkTiers.find(
      (candidate) => kg >= candidate.minKg && (candidate.maxKg === null || kg <= candidate.maxKg),
    ) ?? null
  );
}

/**
 * One line's verdict. Exported for its own unit test, because this is where the rules live and the
 * repository work around it is uninteresting by comparison.
 *
 * Order matters, and it is: `NOT_FOUND`, then stock, then the minimum. A line whose product has gone
 * cannot be measured against a minimum or a stock level at all, and where both remaining rules fire
 * at once the stock answer is the actionable one — see the comment on the retail branch.
 */
export function verdictFor(line: ValidatableLine): CartValidationLine {
  const base = { id: line.id, slug: line.slug, requestedQty: line.qty };

  if (!line.product || (line.mode === 'RETAIL' && !line.variant)) {
    return { ...base, unavailable: true, availableQty: null, lineTotal: null, code: 'NOT_FOUND' };
  }

  /**
   * Checked before either channel prices anything, and independently of the tier ladder: a quote-only
   * product can sit inside a tier that *does* carry a price, which is why the `pricePerKgPaise IS NULL`
   * case could not catch it. `corporate-gift-box` is exactly that — `quoteOnly` with a priced 25-49kg
   * slab.
   */
  if (line.product.quoteOnly) {
    return {
      ...base,
      unavailable: false,
      availableQty: line.mode === 'BULK' ? null : (line.variant?.available ?? null),
      lineTotal: null,
      code: 'QUOTE_REQUIRED',
    };
  }

  if (line.mode === 'BULK') {
    const kg = Number(line.kg ?? 0);
    // A bulk line is not variant-bound, so there is no single row to report. Null means "not
    // applicable"; zero would mean "none left", which is a different and wrong claim.
    const bulk = { ...base, unavailable: false, availableQty: null };

    if (kg < line.product.moqKg) return { ...bulk, lineTotal: null, code: 'BELOW_MOQ' };

    const tier = bulkTierFor(line.product.bulkTiers, kg);
    if (!tier || tier.pricePerKgPaise === null) {
      return { ...bulk, lineTotal: null, code: 'QUOTE_REQUIRED' };
    }

    /**
     * `kg` is a `numeric(8,2)` string. Multiplied in paise to avoid a float rupee total. Verified:
     * 25kg at ₹849/kg gives exactly 2122500 paise (₹21,225), and 7.5kg gives 636750 (₹6,367.50)
     * with no loss.
     *
     * **A fractional weight yields a sub-rupee total, which `inr()` rounds for display.** ₹6,367.50
     * shows as ₹6,368, so a displayed line total can sit 50 paise from the figure the server bills.
     * Not reachable through the UI today — the bulk buttons offer whole weights — but the DTO
     * accepts `@Min(0.01)`, so the API allows it. Recorded rather than guarded: rounding paise for
     * display is inherent, and the server's figure stays authoritative for the order.
     */
    const perKg = tier.pricePerKgPaise;
    /**
     * Multiply everything, then divide **once**. Not `(perKg * kg100) / 100n * qty`.
     *
     * `BigInt` division truncates, so dividing before the `qty` multiplication truncates the
     * per-unit figure and then multiplies the error by the quantity. Measured:
     *
     *   perKg 84999 (₹849.99), kg 0.01, qty 10
     *     divide-then-multiply -> 8490 paise
     *     multiply-then-divide -> 8499 paise      9 paise lost
     *   perKg 99999, kg 0.03, qty 7               6 paise lost
     *
     * Both orders agree on every whole-rupee-per-kg tier the seeder holds — 25kg at ₹849 gives
     * 2122500 either way — which is why a test on those two cases would not show it. The loss needs
     * a `pricePerKgPaise` that is not a multiple of 100 together with a fractional `kg`, and the DTO
     * accepts `@Min(0.01)`, so the API reaches it even though the bulk buttons do not.
     */
    const totalPaise = (perKg * BigInt(Math.round(kg * 100)) * BigInt(line.qty)) / 100n;
    return { ...bulk, lineTotal: toRupees(totalPaise) };
  }

  const variant = line.variant as NonNullable<ValidatableLine['variant']>;
  const retail = { ...base, unavailable: false, availableQty: variant.available };

  /**
   * Stock **before** minimum, not the other way round. Both can be true at once, and only one of
   * the two answers is actionable.
   *
   * A variant with `moq: 3` and `available: 0` asked for qty 1 satisfies both rules. Reporting
   * `BELOW_MOQ` tells the customer to raise the quantity to 3, which they do, and the next validate
   * answers `OUT_OF_STOCK` — two round trips to learn there is nothing to buy. `OUT_OF_STOCK` first
   * tells them the truth immediately: remove the line.
   */
  if (line.qty > variant.available) return { ...retail, lineTotal: null, code: 'OUT_OF_STOCK' };
  if (line.qty < variant.moq) return { ...retail, lineTotal: null, code: 'BELOW_MOQ' };

  return { ...retail, lineTotal: toRupees(variant.pricePaise * BigInt(line.qty)) };
}

/**
 * A product's pricing rules, in the units `verdictFor` reads them in.
 *
 * `gstRate`, `moqKg`, `minKg` and `maxKg` are all `numeric` columns, which `pg` hands back as
 * strings — `'5.00'`, `'10.00'`. Left as strings they break every comparison silently rather than
 * loudly: `'5.00' < 10` coerces and happens to work, while `Number(line.kg) < '10.00'` also coerces,
 * so a bug here would surface as a misplaced verdict rather than a type error.
 *
 * Shared by the stored-cart path and the body-lines path deliberately. Two copies is how
 * `POST /cart/validate` comes to answer differently depending on whether the caller sent its lines,
 * which is the one thing this endpoint cannot afford — the page validates a basket it is also
 * showing.
 *
 * `pricePerKgPaise` is already a `bigint` via `PaiseColumn`, and is **not** converted: money never
 * passes through a float in this system.
 *
 * **`viewer` and `kg` are what close the leak this milestone exists to close.** This used to map
 * `product.pricingTiers` with no filter at all, so the moment a business-specific or non-`DEFAULT`
 * tier existed, every cart in the shop priced from every tier in the table — one business's
 * negotiated rate, visible to every other buyer. `resolveTiers`/`resolveTiersForWeight` (Milestone
 * 7, Tasks 2 and 4) are the one implementation of the resolution order; this function's job is only
 * to convert the resolved ladder's units, the same way it always did.
 *
 * `kg` is `null` for a retail line — `bulkTiers` is built for it anyway, for the wire shape, but
 * `verdictFor`'s `RETAIL` branch never reads it, so which ladder it resolves to is immaterial. A
 * `kg` reaching this function is the request's own weight, not a rung already chosen: falling
 * through to `DEFAULT` when that weight sits outside the viewer's own ladder is
 * `resolveTiersForWeight`'s job, not something re-derived here.
 */
function toProductRules(
  product: Product,
  viewer: PricingViewer | null,
  kg: number | null,
): ProductRules {
  const tiers =
    kg === null ? resolveTiers(product, viewer) : resolveTiersForWeight(product, viewer, kg);
  return {
    gstRate: Number(product.gstRate),
    moqKg: Number(product.moqKg),
    quoteOnly: product.quoteOnly,
    bulkTiers: tiers.map((tier) => ({
      minKg: Number(tier.minKg),
      maxKg: tier.maxKg === null ? null : Number(tier.maxKg),
      pricePerKgPaise: tier.pricePerKgPaise,
    })),
  };
}

/**
 * A variant's stock and price, in the shape a verdict needs.
 *
 * `available` is `onHand - reserved`, computed here rather than read: `Inventory` deliberately has no
 * third column, because a stored `available` is a third thing that can disagree with the other two.
 * A missing `inventory` row reads as zero on hand, so a variant nobody has stocked is out of stock
 * rather than infinitely available.
 */
function toVariantRules(variant: ProductVariant): NonNullable<ValidatableLine['variant']> {
  return {
    moq: variant.moq,
    pricePaise: variant.pricePaise,
    available: (variant.inventory?.onHand ?? 0) - (variant.inventory?.reserved ?? 0),
  };
}

/**
 * A line's contribution to the money, derived from the verdict rather than recomputed.
 *
 * The verdict already decided whether the line is billable and for how much, so re-deriving a total
 * here would be a second answer to the same question — and the two would drift the first time a rule
 * changed. `lineTotal` is null exactly when the line contributes nothing, so the null propagates and
 * `CartPricingService.isPriceable` drops the line.
 *
 * The rupee round trip is deliberate and was measured rather than assumed: `toPaise(toRupees(p))`
 * returns `p` exactly for every total reachable through `CartLineDto`'s own bounds (`kg <= 100_000`,
 * `qty <= 999`, swept to ₹9,999.99/kg), so nothing is lost between the figure the customer is shown
 * and the figure that is summed.
 *
 * **This once made a null total set `CartTotals.hasQuoteLines`. Fixed — `quoteRequired` is now its own
 * signal and `hasUnpriceableLines` is a second field.** The two questions were conflated:
 * `CartPricingService` derived the flag as "some line was left out of the money", which is right for
 * the money and wrong for the name, because an `OUT_OF_STOCK` retail line also has a null total. The
 * frontend reads it literally — `cart.tsx` says *"Quote-required items are not included in this
 * total"* and offers **Request Quote**, and `CheckoutForm.tsx` sets `isB2b` from it and then demands a
 * GSTIN — so a B2C basket whose only problem was a sold-out bag got invited to raise a B2B quote.
 *
 * `hasQuoteLines` is now narrow (a quote-required tier and nothing else) and drives that routing;
 * `hasUnpriceableLines` is the broad one and drives the honesty notice. Pinned on the wire by
 * `cart.integration.spec.ts` and on the service by `cart-pricing.service.spec.ts`. Left recorded rather
 * than deleted, because "why are there two flags" is the question a reader will arrive with, and the
 * per-line `code` this service returns is still the only thing that says *which* line and *why*.
 */
export function toPricedLine(line: ValidatableLine, verdict: CartValidationLine): PricedLine {
  return {
    mode: line.mode,
    qty: line.qty,
    kg: line.kg,
    lineTotalPaise: verdict.lineTotal === null ? null : toPaise(verdict.lineTotal),
    // Null only on a line whose product could not be resolved, which is never billable anyway.
    gstRate: line.product?.gstRate ?? 0,
    quoteRequired: verdict.code === 'QUOTE_REQUIRED',
  };
}

@Injectable()
export class CartReadService {
  constructor(
    @InjectRepository(Setting) private readonly settings: Repository<Setting>,
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @InjectRepository(ProductVariant) private readonly variants: Repository<ProductVariant>,
    @InjectRepository(Business) private readonly businesses: Repository<Business>,
    private readonly pricing: CartPricingService,
  ) {}

  /**
   * The caller's pricing identity, or `null` — `CatalogService.viewerFor`'s counterpart on this
   * side of the leak, and `CheckoutService.place`/`previewCoupon` call this one directly rather than
   * growing a third copy, since both already inject this service.
   *
   * One lookup per request, resolved once by `present`/`validateStored`/`validateLines` and passed
   * into every line's `toProductRules` call, rather than re-resolved per line. `role !== BUSINESS`
   * short-circuits without touching the database, which is every retail customer, every admin, and
   * every guest (`user === undefined`). A `BUSINESS` user with no `businesses` row resolves to
   * `null` and gets list pricing, not an error.
   */
  async viewerFor(user: AuthenticatedUser | undefined): Promise<PricingViewer | null> {
    // `user.role` is the signed token's plain `string` claim, not `UserRole` itself — see
    // `CatalogService.viewerFor`'s identical comment for why a cast (`role as UserRole`) would be
    // silently wrong forever if either vocabulary is ever renamed.
    if (user === undefined || user.role !== (UserRole.BUSINESS as string)) return null;
    const business = await this.businesses.findOne({
      where: { userId: user.id },
      select: { id: true, segment: true },
    });
    return business === null ? null : { businessId: business.id, segment: business.segment };
  }

  /** A stored cart as the client sees it: wire lines plus live totals. */
  async present(cart: Cart | null, user: AuthenticatedUser | undefined): Promise<CartResponse> {
    const items = cart?.items ?? [];
    const viewer = await this.viewerFor(user);
    const { totals } = await this.evaluate(items.map((item) => this.toValidatable(item, viewer)));
    return { lines: items.map((item) => toCartLine(item)), totals };
  }

  /** The stored cart's verdict, line by line, with the same totals `GET /cart` reports. */
  async validateStored(
    cart: Cart | null,
    user: AuthenticatedUser | undefined,
  ): Promise<CartValidationResult> {
    const viewer = await this.viewerFor(user);
    return this.evaluate((cart?.items ?? []).map((item) => this.toValidatable(item, viewer)));
  }

  /**
   * Validates lines from the request body rather than the stored cart, so the checkout page can
   * check exactly what the customer is looking at — which may differ from what was last saved if a
   * `PUT` is still in flight. Spec §6.3 makes this route available to guests for the same reason.
   *
   * Unlike `CartService.replace`, an unresolvable slug or pack size is **reported, not thrown**. A
   * `PUT` refuses to store a basket the catalogue cannot account for, but this route exists to tell
   * the customer what is wrong with the basket they are holding — a 422 would name one bad line and
   * hide the state of every other, which is the opposite of per-line reporting. `verdictFor` already
   * has `NOT_FOUND` for exactly this.
   */
  async validateLines(
    lines: CartLineDto[],
    user: AuthenticatedUser | undefined,
  ): Promise<CartValidationResult> {
    const viewer = await this.viewerFor(user);
    return this.evaluate(await this.resolveBodyLines(lines, viewer));
  }

  /**
   * The one derivation behind all three routes.
   *
   * `GET /cart`, `POST /cart/validate` on the stored cart, and `POST /cart/validate` on body lines
   * differ only in where their `ValidatableLine`s come from. Everything after that — the verdicts,
   * the money, `ok` — is computed here once, so the totals on a cart page cannot disagree with the
   * totals in the verdict that annotates it. Written twice they drift: `validateStored` previously
   * called `present` and then recomputed every verdict a second time to build its own line list.
   */
  private async evaluate(lines: ValidatableLine[]): Promise<CartValidationResult> {
    const shipping = await this.shippingSettings();
    // Paired in one pass rather than zipped by index afterwards: two same-length arrays joined on a
    // subscript is a silent misalignment waiting for the first `filter` anyone adds.
    const assessed = lines.map((line) => {
      const verdict = verdictFor(line);
      return { verdict, priced: toPricedLine(line, verdict) };
    });

    return {
      ok: assessed.every(({ verdict }) => verdict.code === undefined),
      lines: assessed.map(({ verdict }) => verdict),
      totals: this.pricing.totals(
        assessed.map(({ priced }) => priced),
        shipping,
      ),
    };
  }

  /**
   * Body lines resolved against the live catalogue: one query for the products, one for the
   * variants, never one per line.
   *
   * **`find({ where: [] })` returns every row.** Measured against the seeded catalogue in
   * `CartService.resolveLines`: an empty OR-array is treated as no condition at all, so both guards
   * below are load-bearing rather than defensive. Without the second, a basket of unknown slugs
   * would pull every variant in the catalogue before answering `NOT_FOUND`.
   *
   * No `select` narrowing, unlike `resolveLines`: that method needs two columns, this one needs most
   * of the product's scalars plus two relations, and a partial select spanning a relation is where a
   * silently-undefined `pricePerKgPaise` would come from. The basket is capped at 50 lines.
   *
   * **`isPublished` is part of the criterion**, matching `CartService.resolveLines` and every
   * catalogue query. An unpublished product therefore resolves to nothing and `verdictFor` reports the
   * line `NOT_FOUND` — the same answer this route already gave for a slug the catalogue never held,
   * which is the point: a route that answered differently for the two would tell a caller which
   * unreleased slugs exist. It is a `where` and not a filter on the loaded rows so that the row never
   * reaches this process at all, and not part of a `select` because a column omitted from a narrowed
   * select comes back `undefined` and would reject the whole catalogue.
   */
  private async resolveBodyLines(
    lines: CartLineDto[],
    viewer: PricingViewer | null,
  ): Promise<ValidatableLine[]> {
    const slugs = [...new Set(lines.map((line) => line.slug))];
    const products =
      slugs.length === 0
        ? []
        : await this.products.find({
            where: slugs.map((slug) => ({ slug, isPublished: true })),
            relations: { pricingTiers: true },
          });
    const productBySlug = new Map(products.map((product) => [product.slug, product]));

    const variants =
      products.length === 0
        ? []
        : await this.variants.find({
            where: products.map((product) => ({ productId: product.id })),
            relations: { inventory: true },
          });

    return lines.map((line) => {
      const product = productBySlug.get(line.slug);
      // A retail line names a pack size; a bulk line names a weight and is not variant-bound. The
      // `isActive` filter matches `CartService.resolveLines`, so a line this route calls valid is a
      // line a `PUT` will accept.
      const variant =
        product && line.mode === 'retail'
          ? variants.find(
              (candidate) =>
                candidate.productId === product.id &&
                candidate.size === line.size &&
                candidate.isActive,
            )
          : undefined;

      return {
        // The client's own name for the line, from the same helper `GET /cart` uses. A body line
        // carries no row id, so this is the only identity both sides can spell.
        id: cartLineId(line),
        slug: line.slug,
        mode: line.mode === 'bulk' ? 'BULK' : 'RETAIL',
        qty: line.qty,
        // `numeric(8,2)` reaches `verdictFor` as a string from Postgres, so a body number is
        // stringified to match rather than the rule being taught two input shapes.
        kg: line.kg === undefined ? null : String(line.kg),
        variant: variant ? toVariantRules(variant) : null,
        product: product
          ? toProductRules(product, viewer, line.mode === 'bulk' ? (line.kg ?? null) : null)
          : null,
      };
    });
  }

  /**
   * A stored row in the shape the rules read. `product.pricingTiers` and `variant.inventory` must
   * both be loaded by whatever fetched this cart — all three `relations` clauses in `CartService`
   * request them, and `toProductRules` explains what an unloaded ladder costs.
   *
   * The `id` is the client's line id, not `item.id`. A verdict exists to annotate a line the browser
   * is already showing, and the browser addresses lines as `r:slug:size` / `b:slug:kg` — so a row
   * uuid here would produce a `CartValidationResult` whose entries join to nothing on the page. It
   * also has to match whatever `validateLines` can produce, and a body line carries no row id at
   * all.
   *
   * **A line whose product has since been unpublished reads back as unavailable, not as gone.** The
   * row stays in `GET /cart` and gets a `NOT_FOUND` verdict with no price, which is exactly what
   * `resolveBodyLines` produces for the same slug — and the two must not disagree, because the cart
   * page annotates lines it got from `GET /cart` with verdicts it got from `POST /cart/validate`. The
   * alternative, dropping the row, was rejected: a body verdict the client cannot find reads as "no
   * problem with that line", so the body path cannot drop it, and it would be silent data loss on
   * this one — an admin who withdraws a product for a week would have emptied every basket holding it.
   * Reporting it keeps the money right (`lineTotal` null, so `CartPricingService` leaves it out),
   * keeps `ok` false so checkout is blocked, and leaves the customer a line they can remove.
   *
   * The filter is a read of the **already-loaded** relation rather than a second query, and that
   * carries an obligation on the callers: every `relations` clause in `CartService` loads
   * `items.product` in full, with no `select`, so `isPublished` is really there. Narrow one of those
   * with a `select` that omits the column and it arrives `undefined` — falsy — and every stored line
   * in every basket reads `NOT_FOUND`. `cart.integration.spec.ts` proves the flag survives the real
   * relation load; `cart-read.service.spec.ts`'s `PRODUCT` fixture states it for the same reason.
   *
   * Public, and not just for `present`/`validateStored` above: `CheckoutService.assess` calls this
   * directly too, so placement re-applies the cart page's own gates from the same `verdictFor`
   * rather than restating them, and prices from the same resolved `viewer` the cart used.
   */
  toValidatable(item: Cart['items'][number], viewer: PricingViewer | null): ValidatableLine {
    return {
      id: toCartLine(item).id,
      slug: item.product.slug,
      mode: item.mode === OrderChannelEnum.BULK ? 'BULK' : 'RETAIL',
      qty: item.qty,
      kg: item.kg,
      variant: item.variant ? toVariantRules(item.variant) : null,
      product: item.product.isPublished
        ? toProductRules(item.product, viewer, item.kg === null ? null : Number(item.kg))
        : null,
    };
  }

  /**
   * Shipping rules from the seeded `Setting` rows rather than a constant, so admin can change them
   * without a deploy. `frontend/src/config/settings.ts` still holds hardcoded defaults and
   * `PincodeChecker.tsx` carries its own second copy of the 79 — both are Milestone 8's to remove.
   *
   * Public because `CheckoutService` needs the same two figures to decide an order's shipping charge,
   * and reading the rows itself would be the third copy of the free-shipping threshold in this
   * codebase rather than the second.
   */
  async shippingSettings(): Promise<ShippingSettings> {
    const rows = await this.settings.find({
      where: [{ key: 'freeShippingThreshold' }, { key: 'flatShippingRate' }],
    });
    const value = (key: string, fallback: number): number => {
      const row = rows.find((candidate) => candidate.key === key);
      return typeof row?.value === 'number' ? row.value : fallback;
    };
    return {
      freeShippingThreshold: value('freeShippingThreshold', 999),
      flatShippingRate: value('flatShippingRate', 79),
    };
  }
}
