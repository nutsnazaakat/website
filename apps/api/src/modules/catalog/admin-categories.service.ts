import { HttpStatus, Injectable } from '@nestjs/common';
import type { AdminCategory } from '@nutwala/shared';
import { DataSource, type EntityManager } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Category } from '../../entities/catalog/category.entity';
import { AuditAction, AuditEntity, AuditLogService } from '../admin/audit-log.service';
import type { CreateCategoryDto, UpdateCategoryDto } from './dto/save-category.dto';
import { toAdminCategory } from './mappers/admin-catalog.mapper';

interface CategorySnapshot {
  slug: string;
  name: string;
  image: string;
  blurb: string;
  description: string;
  sortOrder: number;
  isPublished: boolean;
  seo: Record<string, unknown>;
}

function snapshot(category: Category): CategorySnapshot {
  return {
    slug: category.slug,
    name: category.name,
    image: category.image,
    blurb: category.blurb,
    description: category.description,
    sortOrder: category.sortOrder,
    isPublished: category.isPublished,
    seo: { ...category.seo },
  };
}

function diff(
  before: CategorySnapshot,
  after: CategorySnapshot,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  for (const key of Object.keys(before) as (keyof CategorySnapshot)[]) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    changedBefore[key] = before[key];
    changedAfter[key] = after[key];
  }

  return Object.keys(changedAfter).length === 0
    ? null
    : { before: changedBefore, after: changedAfter };
}

/**
 * `GET`, `POST` and `PATCH /admin/categories` — spec §6.4, brief §7's twelve categories.
 *
 * **There is no delete, and that is a decision the spec already made.** §6.4 lists three verbs for
 * this resource and no `DELETE`, so none is added. It is also the right answer on the data:
 * `products.category_id` is `ON DELETE RESTRICT`, so deleting a category holding products is
 * refused by Postgres, and every one of the twelve seeded categories holds some. What an operator
 * actually wants — take it off the storefront, keep the products — is `isPublished: false`, which
 * `PATCH` already does and which the storefront's own `listCategories` already honours. Reported
 * rather than invented: if a genuine delete is ever wanted, it needs the same
 * refuse-when-referenced treatment as products and variants, plus a decision about what happens to
 * the products underneath.
 *
 * Same two rules as the product and variant services: one transaction per write, the audit row
 * inside it, and no audit row for a write that changed nothing.
 */
@Injectable()
export class AdminCategoriesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * `GET /admin/categories` — **every** category, published or not.
   *
   * Unpaginated, matching the storefront's `GET /catalog/categories`, which also returns a bare
   * array. Brief §7 fixes the taxonomy at twelve, and a category list is what a product form's
   * dropdown is built from — paginating it would make that dropdown wrong on page two.
   *
   * `sortOrder ASC` is the storefront's own order so an operator sees what a shopper sees; `id` is
   * the tiebreak, because `sortOrder` has no unique constraint and two categories sharing one would
   * otherwise reorder between requests.
   */
  async list(): Promise<AdminCategory[]> {
    const rows = await this.dataSource
      .getRepository(Category)
      .find({ order: { sortOrder: 'ASC', id: 'ASC' } });
    return rows.map(toAdminCategory);
  }

  async create(input: CreateCategoryDto & { actorUserId: string }): Promise<AdminCategory> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertSlugFree(manager, input.slug, null);

      const categories = manager.getRepository(Category);
      const created = await categories.save(
        categories.create({
          slug: input.slug,
          name: input.name,
          image: input.image,
          blurb: input.blurb,
          description: input.description,
          sortOrder: input.sortOrder ?? 0,
          // Defaults to true, matching the column. Unlike a product, a category has no
          // publish/unpublish endpoint in §6.4, so this field is its only route to either state.
          isPublished: input.isPublished ?? true,
          seo: input.seo ?? {},
        }),
      );

      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: AuditAction.CATEGORY_CREATE,
        entityType: AuditEntity.CATEGORY,
        entityId: created.id,
        after: { ...snapshot(created) },
      });

      return toAdminCategory(created);
    });
  }

  async update(
    id: string,
    input: UpdateCategoryDto & { actorUserId: string },
  ): Promise<AdminCategory> {
    return this.dataSource.transaction(async (manager) => {
      const category = await this.loadOrThrow(manager, id);
      const before = snapshot(category);

      if (input.slug !== undefined) {
        await this.assertSlugFree(manager, input.slug, id);
        category.slug = input.slug;
      }
      if (input.name !== undefined) category.name = input.name;
      if (input.image !== undefined) category.image = input.image;
      if (input.blurb !== undefined) category.blurb = input.blurb;
      if (input.description !== undefined) category.description = input.description;
      if (input.sortOrder !== undefined) category.sortOrder = input.sortOrder;
      if (input.isPublished !== undefined) category.isPublished = input.isPublished;
      if (input.seo !== undefined) category.seo = { ...input.seo };

      const changed = diff(before, snapshot(category));
      if (changed === null) return toAdminCategory(category);

      await manager.getRepository(Category).save(category);
      await this.audit.record(manager, {
        actorUserId: input.actorUserId,
        action: AuditAction.CATEGORY_UPDATE,
        entityType: AuditEntity.CATEGORY,
        entityId: id,
        before: changed.before,
        after: changed.after,
      });

      return toAdminCategory(category);
    });
  }

  private async loadOrThrow(manager: EntityManager, id: string): Promise<Category> {
    const category = await manager.getRepository(Category).findOne({ where: { id } });
    if (!category) {
      throw new DomainError(ErrorCodes.NOT_FOUND, 'No such category.', HttpStatus.NOT_FOUND, {
        categoryId: id,
      });
    }
    return category;
  }

  /** Named 409 rather than a driver error from `uq_categories_slug`. See `AdminProductsService`. */
  private async assertSlugFree(
    manager: EntityManager,
    slug: string,
    exceptId: string | null,
  ): Promise<void> {
    const builder = manager
      .getRepository(Category)
      .createQueryBuilder('category')
      .where('category.slug = :slug', { slug });
    if (exceptId !== null) builder.andWhere('category.id != :exceptId', { exceptId });

    if (await builder.getExists()) {
      throw new DomainError(
        ErrorCodes.IDENTIFIER_IN_USE,
        'Another category already uses that slug.',
        HttpStatus.CONFLICT,
        { field: 'slug', value: slug },
      );
    }
  }
}
