import { HttpStatus, Injectable } from '@nestjs/common';
import type { AdminProduct, Paginated } from '@nutwala/shared';
import { DataSource, type EntityManager, type SelectQueryBuilder } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Category } from '../../entities/catalog/category.entity';
import { Product } from '../../entities/catalog/product.entity';
import { AuditAction, AuditEntity, AuditLogService } from '../admin/audit-log.service';
import type { AdminProductQueryDto } from './dto/admin-product-query.dto';
import type { CreateProductDto, UpdateProductDto } from './dto/save-product.dto';
import { toAdminProduct } from './mappers/admin-catalog.mapper';

/** Page size defaults, matching `CatalogService`'s so one screen cannot ask for more than another. */
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

/**
 * The product columns an audit row records, and the shape it records them in.
 *
 * Deliberately not "the whole entity": `ratingAvg` and `reviewCount` are recomputed by the reviews
 * module, so including them would fill the trail with diffs no admin caused, and `createdAt` /
 * `updatedAt` are noise. `id` is on the row already as `entityId`.
 */
interface ProductSnapshot {
  slug: string;
  name: string;
  categoryId: string;
  subtitle: string;
  description: string;
  origin: string;
  grade: string;
  processing: string;
  shelfLife: string;
  storage: string;
  ingredients: string;
  hsn: string;
  /**
   * **Numbers, not the entity's strings.** `gstRate` and `moqKg` are Postgres `numeric`, which
   * `pg` hands back as `'5.00'` and `'10.00'` — while a freshly-saved entity still carries whatever
   * the write set, `'5'`. Left as strings the two spellings compare unequal, so `PATCH { gstRate: 5 }`
   * against a stored `5.00` would look like a change: a pointless `UPDATE` and an audit row claiming
   * a rate moved from 5 to 5. Normalising through `Number` here is what makes the diff mean what it
   * says, and it also matches the wire type, so a trail reads in the same units an operator typed.
   */
  gstRate: number;
  moqKg: number;
  quoteOnly: boolean;
  badge: string | null;
  isPublished: boolean;
  seo: Record<string, unknown>;
}

function snapshot(product: Product): ProductSnapshot {
  return {
    slug: product.slug,
    name: product.name,
    categoryId: product.categoryId,
    subtitle: product.subtitle,
    description: product.description,
    origin: product.origin,
    grade: product.grade,
    processing: product.processing,
    shelfLife: product.shelfLife,
    storage: product.storage,
    ingredients: product.ingredients,
    hsn: product.hsn,
    gstRate: Number(product.gstRate),
    moqKg: Number(product.moqKg),
    quoteOnly: product.quoteOnly,
    badge: product.badge,
    isPublished: product.isPublished,
    seo: { ...product.seo },
  };
}

/**
 * The fields that actually changed, both sides, or `null` when nothing did.
 *
 * A trail whose every `update` row carries eighteen unchanged fields is a trail nobody reads, and
 * `AuditLogInput`'s own docblock asks for "the changed fields, not the whole row". Comparison is by
 * `JSON.stringify` because `seo` is an object; every other field is a scalar, where it degenerates
 * to equality.
 */
function diff(
  before: ProductSnapshot,
  after: ProductSnapshot,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  for (const key of Object.keys(before) as (keyof ProductSnapshot)[]) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    changedBefore[key] = before[key];
    changedAfter[key] = after[key];
  }

  return Object.keys(changedAfter).length === 0
    ? null
    : { before: changedBefore, after: changedAfter };
}

/**
 * Admin product reads and writes — spec §6.4's `/admin/products` block, brief §30.
 *
 * **Every write runs in one `dataSource.transaction` and calls `AuditLogService.record` with the
 * caller's own manager inside it.** That is not belt-and-braces: an audit row committed separately
 * from the change it describes "can outlive a write that rolled back, claiming a change that never
 * happened, or be lost while the write survives, hiding one that did", and both are worse than no
 * trail because both get trusted. A failed audit write therefore takes the mutation down with it.
 *
 * **Nothing here is a no-op that still writes an audit row.** `InventoryService.adjust` records the
 * measurement that makes this a rule rather than a nicety: an adjustment of zero once produced a
 * 200 and a ledger row "asserting a movement of zero", and "an audit trail reads as authoritative,
 * so a row recording a change that never happened is worse than no row". So a PATCH that changes
 * nothing, a publish of an already-published product and an unpublish of an unpublished one all
 * return the current state and write nothing.
 */
@Injectable()
export class AdminProductsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * `GET /admin/products` — paginated, filterable, and **including unpublished products**. That
   * inclusion is the entire reason this endpoint exists beside `GET /catalog/products`: the
   * storefront query pins `product.isPublished = true` inside `CatalogService.baseQuery`, so a
   * draft is invisible to every catalogue route and there would otherwise be no way to reach one.
   *
   * The query is built here rather than by reusing `CatalogService`'s builder, and that is the
   * safer arrangement rather than duplication for its own sake: `baseQuery`'s `where` is what makes
   * every storefront route safe, and a shared builder with a "published only, unless…" flag is one
   * edit away from leaking drafts onto the shop. Two builders that must differ is better than one
   * that must remember.
   *
   * Newest first. An admin list is a worklist — the product you just created is the one you want to
   * see — where the storefront's default is seed order. `id` is the tiebreak, because `seedCatalog`
   * writes all 27 products in one transaction and Postgres's `now()` is transaction-start time, so
   * every seeded row shares one `createdAt` (measured: one distinct value across 27 rows) and an
   * unordered `LIMIT`/`OFFSET` may return the same row on two pages.
   */
  async list(query: AdminProductQueryDto): Promise<Paginated<AdminProduct>> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT)));

    const builder = this.baseQuery();

    if (query.q) {
      builder.andWhere('(product.name ILIKE :q OR product.slug ILIKE :q)', {
        q: `%${query.q.trim()}%`,
      });
    }
    if (query.category) {
      builder.andWhere('category.slug = :category', { category: query.category });
    }
    if (query.published !== undefined) {
      builder.andWhere('product.isPublished = :published', { published: query.published });
    }

    const [rows, total] = await builder
      .orderBy('product.createdAt', 'DESC')
      .addOrderBy('product.id', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { items: rows.map(toAdminProduct), total, page, limit };
  }

  /** `GET /admin/products/:id`. By uuid, not slug — spec §6.4 addresses admin resources by id. */
  async get(id: string): Promise<AdminProduct> {
    return toAdminProduct(await this.loadOrThrow(this.dataSource.manager, id));
  }

  /**
   * `POST /admin/products`.
   *
   * The product is created **unpublished**, always: `CreateProductDto` carries no `isPublished`, so
   * `POST /admin/products/:id/publish` is the only way a listing goes live and the audit trail
   * therefore has a `product.publish` row behind every live product.
   *
   * The category is verified inside the transaction rather than trusted. `products.category_id` is
   * `ON DELETE RESTRICT` with a real FK, so an unknown id would fail anyway — as an opaque driver
   * error surfacing through `GlobalExceptionFilter` as a 500. One `exists` turns that into a 422
   * naming the field.
   */
  async create(input: CreateProductDto & { actorUserId: string }): Promise<AdminProduct> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertCategoryExists(manager, input.categoryId);
      await this.assertSlugFree(manager, input.slug, null);

      const products = manager.getRepository(Product);
      const created = await products.save(
        products.create({
          slug: input.slug,
          name: input.name,
          categoryId: input.categoryId,
          subtitle: input.subtitle,
          description: input.description,
          badge: input.badge ?? null,
          origin: input.origin,
          grade: input.grade,
          processing: input.processing,
          shelfLife: input.shelfLife,
          storage: input.storage,
          ingredients: input.ingredients,
          hsn: input.hsn,
          // `numeric` columns are strings on the entity, because `pg` hands them back as strings.
          // Stringifying here rather than at the column keeps that boundary in one place.
          gstRate: String(input.gstRate),
          moqKg: String(input.moqKg ?? 0),
          quoteOnly: input.quoteOnly ?? false,
          isPublished: false,
          publishedAt: null,
          seo: input.seo ?? {},
        }),
      );

      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: AuditAction.PRODUCT_CREATE,
        entityType: AuditEntity.PRODUCT,
        entityId: created.id,
        after: { ...snapshot(created) },
      });

      return toAdminProduct(await this.loadOrThrow(manager, created.id));
    });
  }

  /**
   * `PATCH /admin/products/:id`.
   *
   * An omitted field means "leave unchanged", so the update is applied field by field from the
   * DTO's own keys rather than by spreading it over the entity — a spread would write `undefined`
   * into every omitted column.
   */
  async update(
    id: string,
    input: UpdateProductDto & { actorUserId: string },
  ): Promise<AdminProduct> {
    return this.dataSource.transaction(async (manager) => {
      const product = await this.loadOrThrow(manager, id);
      const before = snapshot(product);

      if (input.categoryId !== undefined) {
        await this.assertCategoryExists(manager, input.categoryId);
        product.categoryId = input.categoryId;
      }
      if (input.slug !== undefined) {
        await this.assertSlugFree(manager, input.slug, id);
        product.slug = input.slug;
      }
      if (input.name !== undefined) product.name = input.name;
      if (input.subtitle !== undefined) product.subtitle = input.subtitle;
      if (input.description !== undefined) product.description = input.description;
      if (input.origin !== undefined) product.origin = input.origin;
      if (input.grade !== undefined) product.grade = input.grade;
      if (input.processing !== undefined) product.processing = input.processing;
      if (input.shelfLife !== undefined) product.shelfLife = input.shelfLife;
      if (input.storage !== undefined) product.storage = input.storage;
      if (input.ingredients !== undefined) product.ingredients = input.ingredients;
      if (input.hsn !== undefined) product.hsn = input.hsn;
      if (input.gstRate !== undefined) product.gstRate = String(input.gstRate);
      if (input.moqKg !== undefined) product.moqKg = String(input.moqKg);
      if (input.quoteOnly !== undefined) product.quoteOnly = input.quoteOnly;
      if (input.badge !== undefined) product.badge = input.badge;
      if (input.seo !== undefined) product.seo = { ...input.seo };

      const after = snapshot(product);
      const changed = diff(before, after);

      // Nothing changed: no write, no audit row. See the class docblock — a trail that records a
      // change nobody made is worse than one that records nothing.
      if (changed === null) return toAdminProduct(product);

      await manager.getRepository(Product).save(product);
      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: AuditAction.PRODUCT_UPDATE,
        entityType: AuditEntity.PRODUCT,
        entityId: id,
        before: changed.before,
        after: changed.after,
      });

      return toAdminProduct(await this.loadOrThrow(manager, id));
    });
  }

  /**
   * `DELETE /admin/products/:id`.
   *
   * **Decision: a hard delete, refused with a named 409 when history references the product.** The
   * plan left this open between soft delete and refuse-when-referenced; refuse is right here, for
   * four reasons measured against this schema rather than in the abstract.
   *
   * 1. **Order history does not need protecting from a delete — it is already snapshotted.**
   *    `order_items.product_id` is nullable `ON DELETE SET NULL`, and `productSlug`, `name`, `hsn`
   *    and `unitPricePaise` are copies, so the entity's own docblock says "a product deleted or
   *    repriced in admin leaves this row — and the invoice it prints — completely unchanged".
   *    `reviews` and `rfq_items` are the same shape and also snapshot `productSlug`. So the plan's
   *    premise — "either fails on the FK or orphans order history" — is not what this schema does.
   * 2. **The real blocker is the stock ledger, and it is already `RESTRICT`.**
   *    `inventory_transactions.variant_id` is `ON DELETE RESTRICT` and `seedCatalog` writes one
   *    opening `RECEIPT` per variant, so no seeded product can be deleted at all —
   *    `wishlist-item.entity.ts` records the exact Postgres error. Left alone that surfaces as a
   *    500 with a constraint name in it. Checking first turns the schema's existing intent into an
   *    answer an operator can act on.
   * 3. **Soft delete would be a second hidden state beside `isPublished`.** Unpublish already means
   *    "withdraw from the storefront, keep everything", and it has its own endpoint, its own audit
   *    action and its own cart behaviour. A `deletedAt` column would need a migration and would
   *    then have to be honoured by every catalogue query, cart read, checkout assessment and
   *    dashboard aggregate — `Address.deletedAt`, the one soft delete in this codebase, is a plain
   *    `@Column` precisely because `@DeleteDateColumn` filters were judged too easy to forget, and
   *    `addresses.service.ts` carries four separate notes about remembering `deletedAt IS NULL`.
   *    Reproducing that across the catalogue for a row that can equally be unpublished is a poor
   *    trade.
   * 4. **Delete then remains meaningful for the case it is actually for:** a product created by
   *    mistake, or one that never sold, which is exactly the product with no ledger and no orders.
   *
   * What a successful delete does take with it, by the schema's existing choice rather than this
   * method's: `product_variants`, `product_images`, `pricing_tiers`, `inventory`, `cart_items` and
   * `wishlist_items` all CASCADE. So deleting a product does silently empty the baskets holding it.
   * That is `cart-item.entity.ts`'s own decision — "a cart is a list of intentions" — and unpublish
   * is the operation for a withdrawal that must not do it. Not re-litigated here, but stated,
   * because it is surprising.
   */
  async remove(id: string, actorUserId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const product = await this.loadOrThrow(manager, id);

      const orderItems = await this.countReferences(
        manager,
        `SELECT count(*)::int AS count FROM order_items WHERE product_id = $1`,
        id,
      );
      if (orderItems > 0) {
        throw new DomainError(
          ErrorCodes.ENTITY_IN_USE,
          'This product has been ordered, so it cannot be deleted. Unpublish it instead to withdraw it from the shop.',
          HttpStatus.CONFLICT,
          { productId: id, orderItems },
        );
      }

      /**
       * The append-only stock ledger, reached through the product's variants.
       *
       * Checked separately from the order count and *after* it, because the two send an operator to
       * different places and only one of them is about selling. `InventoryService.adjust` splits its
       * own zero-rows failure for the identical reason: "no such variant" and "would oversell
       * reserved units" are one status code and two entirely different things to go and look at.
       */
      const ledgerRows = await this.countReferences(
        manager,
        `SELECT count(*)::int AS count
           FROM inventory_transactions t
           JOIN product_variants v ON v.id = t.variant_id
          WHERE v.product_id = $1`,
        id,
      );
      if (ledgerRows > 0) {
        throw new DomainError(
          ErrorCodes.ENTITY_IN_USE,
          'This product has stock movement history, which is append-only and must outlive it. Unpublish it instead, or deactivate its variants.',
          HttpStatus.CONFLICT,
          { productId: id, inventoryTransactions: ledgerRows },
        );
      }

      // The audit row is written *before* the delete, inside the same transaction, so the FK from
      // `audit_logs.actor_user_id` is the only one involved — the row references the actor, never
      // the deleted product, so ordering is a readability choice and not a constraint. `before`
      // carries the whole snapshot: there is no `after`, and nothing else will ever hold this row.
      await this.audit.record(manager, {
        actorUserId,
        action: AuditAction.PRODUCT_DELETE,
        entityType: AuditEntity.PRODUCT,
        entityId: id,
        before: { ...snapshot(product) },
      });

      await manager.getRepository(Product).delete({ id });
    });
  }

  /**
   * `POST /admin/products/:id/publish`.
   *
   * `publishedAt` is set only when it is still null. It records when the listing **first** went
   * live, so an unpublish/republish cycle — a product pulled for a week while a photo is redone —
   * must not rewrite it. Nothing reads the column today; `isPublished` is what every catalogue query
   * filters on, and `catalog.seed.ts` leaves it null deliberately rather than inventing a date.
   */
  async publish(id: string, actorUserId: string): Promise<AdminProduct> {
    return this.setPublished(id, true, actorUserId);
  }

  /**
   * `POST /admin/products/:id/unpublish`.
   *
   * **What happens to a cart holding this product: nothing is written, and the line reports itself
   * unavailable.** That is `CartReadService.toValidatable`'s existing behaviour, followed rather
   * than invented beside — it maps an unpublished product's rules to `null`, `verdictFor` returns
   * `NOT_FOUND` for the line, the row stays in `GET /cart`, its `lineTotal` is null so
   * `CartPricingService` leaves it out of the money, and `ok` is false so checkout is blocked. The
   * customer is left a line they can remove.
   *
   * The alternative — deleting the cart rows — was already rejected there, and this endpoint has no
   * business reopening it: "a body verdict the client cannot find reads as 'no problem with that
   * line'", and "an admin who withdraws a product for a week would have emptied every basket holding
   * it". So `unpublish` touches exactly one column, and the cart's own sold-out machinery (spec
   * §10.1) does the rest. `admin-products.integration.spec.ts` asserts the whole chain end to end.
   */
  async unpublish(id: string, actorUserId: string): Promise<AdminProduct> {
    return this.setPublished(id, false, actorUserId);
  }

  private async setPublished(
    id: string,
    isPublished: boolean,
    actorUserId: string,
  ): Promise<AdminProduct> {
    return this.dataSource.transaction(async (manager) => {
      const product = await this.loadOrThrow(manager, id);

      // Already in the requested state: no write, no audit row. Idempotent, and honest about it.
      if (product.isPublished === isPublished) return toAdminProduct(product);

      const before = { isPublished: product.isPublished, publishedAt: product.publishedAt };
      product.isPublished = isPublished;
      if (isPublished && product.publishedAt === null) product.publishedAt = new Date();

      await manager.getRepository(Product).save(product);
      await this.audit.record(manager, {
        actorUserId,
        action: isPublished ? AuditAction.PRODUCT_PUBLISH : AuditAction.PRODUCT_UNPUBLISH,
        entityType: AuditEntity.PRODUCT,
        entityId: id,
        before: { ...before },
        after: { isPublished: product.isPublished, publishedAt: product.publishedAt },
      });

      return toAdminProduct(await this.loadOrThrow(manager, id));
    });
  }

  /**
   * The relation set every admin product response needs.
   *
   * The same joins `CatalogService.baseQuery` makes and one fewer condition — no
   * `isPublished = true`. `pricingTiers` is `leftJoinAndSelect` with no narrowed `select` for the
   * reason that method records at length: `resolveTiers` switches on `tier.segment` and
   * `tier.businessId`, and a partial select that omitted either would drop every tier silently and
   * turn `bulkTiers` into `[]`.
   *
   * `variants` is joined without an `isActive` filter, which is what lets `toAdminProduct` list a
   * deactivated pack.
   */
  private baseQuery(): SelectQueryBuilder<Product> {
    return this.dataSource
      .getRepository(Product)
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.category', 'category')
      .leftJoinAndSelect('product.variants', 'variant')
      .leftJoinAndSelect('variant.inventory', 'inventory')
      .leftJoinAndSelect('product.images', 'image')
      .leftJoinAndSelect('product.pricingTiers', 'tier');
  }

  /**
   * One product with its relations, or a 404.
   *
   * Takes an `EntityManager` so a write path reads through its **own** transaction: reading outside
   * it would let the row change between the check and the write, and the audit `before` would then
   * describe a state that was never overwritten.
   */
  private async loadOrThrow(manager: EntityManager, id: string): Promise<Product> {
    const product = await manager
      .getRepository(Product)
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.category', 'category')
      .leftJoinAndSelect('product.variants', 'variant')
      .leftJoinAndSelect('variant.inventory', 'inventory')
      .leftJoinAndSelect('product.images', 'image')
      .leftJoinAndSelect('product.pricingTiers', 'tier')
      .where('product.id = :id', { id })
      .getOne();

    if (!product) {
      throw new DomainError(ErrorCodes.NOT_FOUND, 'No such product.', HttpStatus.NOT_FOUND, {
        productId: id,
      });
    }
    return product;
  }

  private async assertCategoryExists(manager: EntityManager, categoryId: string): Promise<void> {
    const exists = await manager.getRepository(Category).exists({ where: { id: categoryId } });
    if (!exists) {
      throw new DomainError(
        ErrorCodes.VALIDATION_FAILED,
        'No such category.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { categoryId },
      );
    }
  }

  /**
   * A named 409 for a taken slug, instead of a driver error from `uq_products_slug`.
   *
   * `exceptId` is the row being updated, so a PATCH that resends the product's own slug is not a
   * collision with itself.
   *
   * The unique index remains the backstop and is not redundant: two concurrent creates can both pass
   * this check and one will then fail on the constraint as a 500. That is the correct division —
   * the check exists to give the ordinary case a usable message, and the index is what guarantees
   * correctness. `AddressesService` reasons the same way about its partial unique index.
   */
  private async assertSlugFree(
    manager: EntityManager,
    slug: string,
    exceptId: string | null,
  ): Promise<void> {
    const builder = manager
      .getRepository(Product)
      .createQueryBuilder('product')
      .where('product.slug = :slug', { slug });
    if (exceptId !== null) builder.andWhere('product.id != :exceptId', { exceptId });

    if (await builder.getExists()) {
      throw new DomainError(
        ErrorCodes.IDENTIFIER_IN_USE,
        'Another product already uses that slug.',
        HttpStatus.CONFLICT,
        { field: 'slug', value: slug },
      );
    }
  }

  private async countReferences(manager: EntityManager, sql: string, id: string): Promise<number> {
    const rows = await manager.query<{ count: number }[]>(sql, [id]);
    return rows[0]?.count ?? 0;
  }
}
