import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  toRupees,
  type Category as WireCategory,
  type Paginated,
  type ProductFilters,
  type QuotePreviewResponse,
  type Product as WireProduct,
} from '@nutwala/shared';
import { Repository, type SelectQueryBuilder } from 'typeorm';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { UserRole, VariantChannel } from '../../entities/enums';
import { Business } from '../../entities/identity/business.entity';
import { Category } from '../../entities/catalog/category.entity';
import { Product } from '../../entities/catalog/product.entity';
import { bulkTierFor, type BulkTier } from '../cart/cart-read.service';
import {
  resolveTiers,
  resolveTiersForWeight,
  type PricingViewer,
} from '../pricing/pricing.resolver';
import type { QuotePreviewDto } from './dto/quote-preview.dto';
import { toWireCategory } from './mappers/category.mapper';
import { toWireProduct } from './mappers/product.mapper';

/** Page size defaults. The cap exists so a client cannot turn a list endpoint into a table dump. */
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

/**
 * The per-kilogram price Phase 1 sorts and filters on, as a joined derived table.
 *
 * `frontend/src/features/catalog/api/index.ts` derives it as "the 1kg retail variant's price, else
 * the first variant's":
 *
 * ```ts
 * const kgPrice = (p: Product) =>
 *   p.variants.find((v) => v.grams === 1000)?.price ?? p.variants[0]?.price ?? 0;
 * ```
 *
 * `DISTINCT ON` reproduces that: one row per product, preferring `grams = 1000`, falling back to the
 * lowest `grams`. Anything simpler — a `MIN(price)` across variants, say — reorders the entire shop
 * and changes which products a price filter returns, which is a visible change nobody asked for.
 *
 * Two things about the shape, both deliberate:
 *
 * - **A join, not a correlated scalar subquery.** The figure is needed in three places (`minPrice`,
 *   `maxPrice`, `ORDER BY`) and TypeORM cannot let a `SELECT` alias be referenced from `WHERE` —
 *   Postgres does not allow it either. Inlining the subquery at each site would spell the
 *   derivation three times and evaluate it three times per row; a join spells it once. It also
 *   settles the `SELECT DISTINCT` problem below, because the ordered expression becomes a plain
 *   column.
 * - **`DISTINCT ON`, not `LEFT JOIN LATERAL`.** `LATERAL` would be the natural spelling, but
 *   TypeORM's `leftJoin` only recognises a raw string as a subquery when it both starts with `(`
 *   and ends with `)` (`SelectQueryBuilder.join`); `LATERAL (…)` is taken for a table name and gets
 *   escaped as an identifier. `DISTINCT ON` needs no correlation and is equivalent here.
 *
 * **Exported**, and read by `catalog.facets.service.ts`. The facets endpoint's price bounds are the
 * `MIN`/`MAX` of this same figure, so it interpolates this exact SQL text into its aggregate rather
 * than respelling the derivation — a `LEFT JOIN LATERAL` of its own would have been the natural raw
 * spelling and would have agreed with this one today, which is precisely how the slider's ends and
 * the price filter drift apart later. One derivation, one string.
 *
 * `grams ASC` as the fallback rather than the mock's seed-array order: every seeded product has an
 * active 1kg pack, so the fallback never fires today, and where it would, the mock's `variants[0]`
 * is always the 100g pack — which is also the lowest `grams`. The two rules coincide, and lowest
 * grams is the one a database can reproduce.
 */
const KG_PRICE_ALIAS = 'kgp';

export const KG_PRICE_JOIN = `(
  SELECT DISTINCT ON (v.product_id)
         v.product_id AS product_id,
         v."pricePaise" AS kg_price
    FROM product_variants v
   WHERE v."isActive" = true
   ORDER BY v.product_id, (v.grams = 1000) DESC, v.grams ASC
)`;

/** The joined figure, in paise. Null for a published product with no active variant at all. */
const KG_PRICE = `${KG_PRICE_ALIAS}.kg_price`;

/**
 * The same figure with Phase 1's `?? 0` tail applied, for ordering only.
 *
 * A product with no active variants has no per-kg price. Phase 1 called it 0, which put it first
 * ascending and last descending; a bare null would flip that (Postgres sorts nulls last ascending,
 * first descending), so the sort coalesces and lands such a product exactly where Phase 1 did.
 *
 * The price *filters* deliberately do not coalesce, and that is the one divergence from Phase 1 in
 * this file: a product with no sellable variant is excluded by a price bound rather than being
 * treated as costing ₹0 and matching every `maxPrice`. Phase 1's ₹0 was a side effect of `?? 0` on
 * an empty array, not a decision, and it made such a product surface in the cheapest bracket. No
 * seeded product is in that state.
 */
const KG_PRICE_SORTABLE = `COALESCE(${KG_PRICE}, 0)`;

/** The alias the ordered expression is selected under. See `applySort`. */
const KG_PRICE_SELECT_ALIAS = 'kg_price';

/**
 * Wire `Channel` is lowercase; the column is an uppercase enum. Same split as `variant.mapper.ts`.
 *
 * **Exported**, and read by `admin-variants.service.ts`. `variant.mapper.ts` holds the inverse
 * (`TO_WIRE_CHANNEL`) for the read side; this is the one map for the write side, so the admin
 * variant endpoints translate a body's `'retail'` through the same `Record` the storefront filter
 * does rather than a third copy. A `Record` keyed on the wire union is also checked in both
 * directions, so a third channel added in `shared/` is a compile error at both sites at once.
 */
export const TO_DB_CHANNEL: Record<NonNullable<ProductFilters['channel']>, VariantChannel> = {
  retail: VariantChannel.RETAIL,
  bulk: VariantChannel.BULK,
};

@Injectable()
export class CatalogService {
  constructor(
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @InjectRepository(Category) private readonly categories: Repository<Category>,
    @InjectRepository(Business) private readonly businesses: Repository<Business>,
  ) {}

  async listProducts(
    filters: ProductFilters,
    user: AuthenticatedUser | undefined,
  ): Promise<Paginated<WireProduct>> {
    const page = Math.max(1, Math.trunc(filters.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(filters.limit ?? DEFAULT_LIMIT)));

    const query = this.baseQuery();
    this.joinKgPrice(query);
    this.applyFilters(query, filters);
    this.applySort(query, filters.sort);

    query.skip((page - 1) * limit).take(limit);

    const [rows, total] = await query.getManyAndCount();
    const viewer = await this.viewerFor(user);
    return { items: rows.map((row) => toWireProduct(row, viewer)), total, page, limit };
  }

  async getProduct(slug: string, user: AuthenticatedUser | undefined): Promise<WireProduct> {
    const product = await this.baseQuery().andWhere('product.slug = :slug', { slug }).getOne();
    if (!product) {
      throw new DomainError(
        ErrorCodes.NOT_FOUND,
        'That product may have been renamed or is no longer stocked.',
        HttpStatus.NOT_FOUND,
      );
    }
    const viewer = await this.viewerFor(user);
    return toWireProduct(product, viewer);
  }

  /**
   * Same category, excluding the product itself. Returns an empty page rather than throwing for an
   * unknown slug, matching Phase 1's `listRelated`, which returned `[]` — a related-products rail is
   * decoration, and a 404 there would break a product page that otherwise rendered fine.
   *
   * `isPublished` is part of the lookup, unlike the plan's version, so an unpublished slug behaves
   * like an unknown one instead of leaking its category's siblings through a rail whose own product
   * page 404s.
   */
  async listRelated(
    slug: string,
    user: AuthenticatedUser | undefined,
    limit = 4,
  ): Promise<Paginated<WireProduct>> {
    const product = await this.products.findOne({
      where: { slug, isPublished: true },
      select: { id: true, categoryId: true },
    });
    if (!product) return { items: [], total: 0, page: 1, limit };

    const [rows, total] = await this.baseQuery()
      .andWhere('product.categoryId = :categoryId', { categoryId: product.categoryId })
      .andWhere('product.id != :id', { id: product.id })
      .orderBy('product.reviewCount', 'DESC')
      .addOrderBy('product.id', 'ASC')
      .take(limit)
      .getManyAndCount();

    const viewer = await this.viewerFor(user);
    return { items: rows.map((row) => toWireProduct(row, viewer)), total, page: 1, limit };
  }

  /**
   * One query for a set of slugs, published only. Used by combo assembly to avoid a round trip per
   * component.
   *
   * The empty guard is load-bearing rather than defensive: `IN (:...slugs)` with an empty array
   * expands to `IN ()`, which Postgres rejects as a syntax error.
   */
  async productsBySlugs(
    slugs: readonly string[],
    user: AuthenticatedUser | undefined,
  ): Promise<WireProduct[]> {
    if (slugs.length === 0) return [];
    const rows = await this.baseQuery()
      .andWhere('product.slug IN (:...slugs)', { slugs: [...slugs] })
      .getMany();
    const viewer = await this.viewerFor(user);
    return rows.map((row) => toWireProduct(row, viewer));
  }

  /**
   * The catalogue filtered to products a bulk buyer can actually order from — spec §6.1's bulk
   * landing page, which must not fetch every published product's retail variants just to render a
   * ladder.
   *
   * Reuses `applyFilters`/`applySort`/`joinKgPrice` rather than a second query builder, so a filter
   * or sort added to the main listing does not have to be remembered here too. What it cannot reuse
   * is `.skip().take()`: "resolvable" is a per-viewer property — `resolveTiers` can answer empty for
   * a viewer whose segment or business has no ladder and the product carries no `DEFAULT` fallback
   * either — so the page has to be sliced *after* that filter runs, not before it. The whole
   * filtered set is therefore fetched in one query; the deferred `>60`-products problem Plan 3's
   * listing DTO already carries applies here identically and is not this task's to solve
   * differently — `ProductQueryDto`'s own `@Max(60)` on `limit` is reused rather than a new cap.
   */
  async listBulkProducts(
    filters: ProductFilters,
    user: AuthenticatedUser | undefined,
  ): Promise<Paginated<WireProduct>> {
    const page = Math.max(1, Math.trunc(filters.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(filters.limit ?? DEFAULT_LIMIT)));

    const query = this.baseQuery();
    this.joinKgPrice(query);
    this.applyFilters(query, filters);
    this.applySort(query, filters.sort);

    const rows = await query.getMany();
    const viewer = await this.viewerFor(user);
    const bulkOrderable = rows.filter((row) => resolveTiers(row, viewer).length > 0);

    const start = (page - 1) * limit;
    const items = bulkOrderable
      .slice(start, start + limit)
      .map((row) => toWireProduct(row, viewer));

    return { items, total: bulkOrderable.length, page, limit };
  }

  /**
   * `POST /catalog/bulk/quote-preview` — spec §6.1's bulk calculator, priced server-side rather
   * than trusted from the client's own copy of the ladder (spec §13).
   *
   * Resolves through **`resolveTiersForWeight`** (Milestone 7, Task 4), never `resolveTiers`
   * directly: a viewer's own ladder may legitimately stop short of the requested weight, and the
   * composition is what swaps in the *whole* `DEFAULT` ladder rather than merging the two.
   * `bulkTierFor`, imported from the cart module rather than re-derived, is the same predicate
   * `verdictFor` and `CheckoutService.assess` use to pick one rung out of a resolved ladder — the
   * second of its callers outside the cart, not a third implementation of "which rung matches this
   * weight".
   *
   * `quoteOnly` is checked before the ladder, independent of it — matching `verdictFor`'s order —
   * because a quote-only product can sit inside a tier that carries a price, and the flag must win
   * regardless of which rung the weight would otherwise match.
   *
   * **`quoteRequired: true` is a `200`, not an error.** It is the answer, and it is what routes the
   * enquiry to the RFQ form. A `422` here would show the calculator an error state for the ordinary
   * case of a weight past every priced rung.
   */
  async quotePreview(
    dto: QuotePreviewDto,
    user: AuthenticatedUser | undefined,
  ): Promise<QuotePreviewResponse> {
    const product = await this.baseQuery()
      .andWhere('product.slug = :slug', { slug: dto.slug })
      .getOne();
    if (!product) {
      throw new DomainError(
        ErrorCodes.NOT_FOUND,
        'That product may have been renamed or is no longer stocked.',
        HttpStatus.NOT_FOUND,
      );
    }

    if (product.quoteOnly) {
      return {
        slug: product.slug,
        kg: dto.kg,
        pricePerKg: null,
        total: null,
        quoteRequired: true,
        tier: null,
      };
    }

    const viewer = await this.viewerFor(user);
    const ladder: BulkTier[] = resolveTiersForWeight(product, viewer, dto.kg).map((tier) => ({
      minKg: Number(tier.minKg),
      maxKg: tier.maxKg === null ? null : Number(tier.maxKg),
      pricePerKgPaise: tier.pricePerKgPaise,
    }));
    const matched = bulkTierFor(ladder, dto.kg);

    if (matched === null || matched.pricePerKgPaise === null) {
      return {
        slug: product.slug,
        kg: dto.kg,
        pricePerKg: null,
        total: null,
        quoteRequired: true,
        tier: matched ? { minKg: matched.minKg, maxKg: matched.maxKg } : null,
      };
    }

    const totalPaise = (matched.pricePerKgPaise * BigInt(Math.round(dto.kg * 100))) / 100n;
    return {
      slug: product.slug,
      kg: dto.kg,
      pricePerKg: toRupees(matched.pricePerKgPaise),
      total: toRupees(totalPaise),
      quoteRequired: false,
      tier: { minKg: matched.minKg, maxKg: matched.maxKg },
    };
  }

  async listCategories(): Promise<WireCategory[]> {
    const rows = await this.categories.find({
      where: { isPublished: true },
      order: { sortOrder: 'ASC' },
    });
    return rows.map(toWireCategory);
  }

  async getCategory(slug: string): Promise<WireCategory> {
    const category = await this.categories.findOne({ where: { slug, isPublished: true } });
    if (!category) {
      throw new DomainError(
        ErrorCodes.NOT_FOUND,
        'That category does not exist.',
        HttpStatus.NOT_FOUND,
      );
    }
    return toWireCategory(category);
  }

  /**
   * The relation set every catalogue response needs, and nothing derived.
   *
   * `inventory` is joined because `soldOut` cannot be derived without it, and joining here rather
   * than lazy-loading avoids an N+1 across a page of products with eight variants each.
   *
   * `pricingTiers` is joined with **`leftJoinAndSelect`**, and that is load-bearing rather than
   * incidental. `product.mapper.ts` resolves the relation through `resolveTiers`, which switches on
   * `tier.segment` and `tier.businessId`, so a narrowed `.select([...])` that omitted either column
   * would leave it `undefined`, make every comparison false, drop every tier, and turn `bulkTiers`
   * into `[]` — silently. That reaches four consumers: `/bulk-orders`, `/bulk/$category`, the
   * product page's bulk calculator, and `cart-math.ts`'s `bulkTotal`, which then reports every bulk
   * cart line total as `null`.
   */
  private baseQuery(): SelectQueryBuilder<Product> {
    return this.products
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.category', 'category')
      .leftJoinAndSelect('product.variants', 'variant')
      .leftJoinAndSelect('variant.inventory', 'inventory')
      .leftJoinAndSelect('product.images', 'image')
      .leftJoinAndSelect('product.pricingTiers', 'tier')
      .where('product.isPublished = true');
  }

  /**
   * The caller's pricing identity, or `null`.
   *
   * One lookup per request, before the products are mapped — a page of 24 products must not make
   * 24 identical `businesses` reads, which is why every caller resolves this once and passes the
   * same `PricingViewer` into every `toWireProduct` call for that response. `role !== BUSINESS`
   * short-circuits without touching the database, which is every retail customer, every admin, and
   * every guest (`user === undefined`).
   *
   * A `BUSINESS` user with no `businesses` row resolves to `null` and gets list pricing, not an
   * error. That is reachable — `BusinessesService.createFor` runs during registration and can fail
   * independently of the user row it follows — and list pricing is the honest answer rather than a
   * broken catalogue page.
   */
  private async viewerFor(user: AuthenticatedUser | undefined): Promise<PricingViewer | null> {
    // `user.role` is the signed token's plain `string` claim, not `UserRole` itself —
    // `RolesGuard.isUserRole` draws the identical distinction for the identical reason: the token
    // carries the database enum while the response body carries a lowercase wire role, so a cast
    // (`role as UserRole`) would compile whatever the token actually holds and leave this silently
    // false forever if either vocabulary is ever renamed. Comparing against the enum's own string
    // value, rather than the enum member, is what keeps the check honest without casting.
    if (user === undefined || user.role !== (UserRole.BUSINESS as string)) return null;
    const business = await this.businesses.findOne({
      where: { userId: user.id },
      select: { id: true, segment: true },
    });
    return business === null ? null : { businessId: business.id, segment: business.segment };
  }

  /**
   * Attaches the per-kg price and selects it under an alias.
   *
   * Only the listing needs it, so it is not in `baseQuery` — a single-product read has no filter
   * and no sort to spend a join on.
   *
   * The `addSelect` is what makes the sort work at all. TypeORM's paginated-with-joins path first
   * issues `SELECT DISTINCT <primary keys> FROM (<this query>) "distinctAlias" ORDER BY …`, and
   * Postgres rejects `SELECT DISTINCT … ORDER BY <expr>` unless the expression is in the select
   * list:
   *
   * ```
   * ERROR: for SELECT DISTINCT, ORDER BY expressions must appear in select list
   * ```
   *
   * `createOrderByCombinedWithSelectExpression` resolves a dotless `ORDER BY` key against the
   * select list's alias names and rewrites it to `"distinctAlias"."kg_price"`, adding it to the
   * outer select. So ordering by the alias — never by the expression — is what keeps that query
   * legal.
   */
  private joinKgPrice(query: SelectQueryBuilder<Product>): void {
    query
      .leftJoin(KG_PRICE_JOIN, KG_PRICE_ALIAS, `${KG_PRICE_ALIAS}.product_id = product.id`)
      .addSelect(KG_PRICE_SORTABLE, KG_PRICE_SELECT_ALIAS);
  }

  private applyFilters(query: SelectQueryBuilder<Product>, filters: ProductFilters): void {
    const parameters: Record<string, unknown> = {};

    // `all` is Phase 1's sentinel for "no category filter", emitted by the shop's category chips.
    if (filters.category && filters.category !== 'all') {
      query.andWhere('category.slug = :category');
      parameters.category = filters.category;
    }

    /**
     * Phase 1 matched against `${name} ${grade} ${category} ${origin}`. `subtitle` is added here
     * because the plan asks for it, and `grade` and `category.slug` are kept because dropping them
     * would silently narrow a live search box: no seeded subtitle contains a grade, so a visitor
     * typing "Independence", "House Blend" or "Shelled" into `SearchDialog` would stop getting the
     * hit they get today.
     */
    const term = filters.q?.trim();
    if (term) {
      query.andWhere(
        `(product.name ILIKE :q
          OR product.subtitle ILIKE :q
          OR product.origin ILIKE :q
          OR product.grade ILIKE :q
          OR category.slug ILIKE :q)`,
      );
      parameters.q = `%${term}%`;
    }

    if (filters.origin) {
      query.andWhere('product.origin = :origin');
      parameters.origin = filters.origin;
    }

    if (filters.grade) {
      query.andWhere('product.grade = :grade');
      parameters.grade = filters.grade;
    }

    if (filters.bestsellerOnly) {
      query.andWhere("product.badge = 'BESTSELLER'");
    }

    // Rupees in, paise compared: the column is paise, the filter arrives as rupees.
    if (filters.minPrice !== undefined) {
      query.andWhere(`${KG_PRICE} >= :minPrice`);
      parameters.minPrice = Math.round(filters.minPrice * 100);
    }

    if (filters.maxPrice !== undefined) {
      query.andWhere(`${KG_PRICE} <= :maxPrice`);
      parameters.maxPrice = Math.round(filters.maxPrice * 100);
    }

    /**
     * Channel-aware, unlike Phase 1's version. `EXISTS` rather than a join condition because the
     * base query already `leftJoinAndSelect`s every variant for the mapper — adding stock predicates
     * to that join would drop the sold-out variants from the response and make the product page
     * hide the very rows it needs to show as SOLD OUT.
     */
    if (filters.inStockOnly) {
      query.andWhere(`EXISTS (
        SELECT 1
          FROM product_variants sv
          JOIN inventory si ON si.variant_id = sv.id
         WHERE sv.product_id = product.id
           AND sv."isActive" = true
           AND si."onHand" - si.reserved > 0
           ${filters.channel ? 'AND sv.channel = :channel' : ''}
      )`);
    }

    if (filters.channel) {
      parameters.channel = TO_DB_CHANNEL[filters.channel];
    }

    // `moqKg` is `numeric`, so Postgres compares it against a number without a cast.
    if (filters.maxMoq !== undefined) {
      query.andWhere('product.moqKg <= :maxMoq');
      parameters.maxMoq = filters.maxMoq;
    }

    query.setParameters(parameters);
  }

  /**
   * `featured` and `newest` are Phase 1's fall-through cases — no explicit ordering there, so seed
   * order is what they mean.
   *
   * `createdAt ASC` is the closest a database can come to that, and worth knowing: it does nothing
   * against a seeded catalogue. `seedCatalog` writes all 27 products in one transaction and
   * Postgres's `now()` is transaction-start time, so every row carries the *same* `createdAt`
   * (measured: one distinct value across 27 rows). The effective order is therefore the
   * `product.id` tiebreak — arbitrary, but stable, which is the property pagination actually needs.
   * Reproducing the mock's array order would take an explicit `sortOrder` column on `products`.
   *
   * Every branch adds `product.id` as a tiebreak, because an unordered `LIMIT`/`OFFSET` in Postgres
   * may return the same row on two different pages.
   */
  private applySort(query: SelectQueryBuilder<Product>, sort: ProductFilters['sort']): void {
    switch (sort) {
      case 'price-asc':
        query.orderBy(KG_PRICE_SELECT_ALIAS, 'ASC');
        break;
      case 'price-desc':
        query.orderBy(KG_PRICE_SELECT_ALIAS, 'DESC');
        break;
      case 'rating':
        query.orderBy('product.ratingAvg', 'DESC');
        break;
      case 'best-selling':
        query.orderBy('product.reviewCount', 'DESC');
        break;
      case 'featured':
      case 'newest':
      default:
        query.orderBy('product.createdAt', 'ASC');
        break;
    }
    query.addOrderBy('product.id', 'ASC');
  }
}
