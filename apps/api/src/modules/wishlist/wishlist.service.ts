import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Product as WireProduct } from '@nutwala/shared';
import { DataSource, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Product } from '../../entities/catalog/product.entity';
import { WishlistItem } from '../../entities/commerce/wishlist-item.entity';
import { CatalogService } from '../catalog/catalog.service';

export interface WishlistOwner {
  userId?: string;
  guestToken?: string;
}

/**
 * The SQL the sign-in merge issues, kept as a named constant so a test can assert on it.
 *
 * `WHERE user_id IS NOT NULL` in the `ON CONFLICT` clause is **required, not decorative**, and
 * deleting it is the obvious simplification. `uq_wishlist_items_user_product` is a *partial* unique
 * index, and Postgres only infers a partial index when the predicate is restated. Measured on
 * Postgres 15 against this exact table, with the user already holding product A and the guest holding
 * A and B:
 *
 *   ON CONFLICT (user_id, product_id) WHERE user_id IS NOT NULL DO NOTHING
 *     -> INSERT 0 1        A skipped, B transferred. Correct.
 *   ON CONFLICT (user_id, product_id) DO NOTHING
 *     -> ERROR: there is no unique or exclusion constraint matching the ON CONFLICT specification
 *
 * That error is **swallowed** by the caller's catch in `auth.controller.ts`, so the broken version
 * returns 200 from sign-in, writes one line to a log, and the customer's saved list is simply gone.
 * There is no failing request to notice.
 *
 * The self-reference is safe: `INSERT ... SELECT` reads the snapshot taken at statement start, so the
 * rows this statement writes are invisible to its own `SELECT`. Verified — the merge terminates with
 * exactly the rows expected, not a growing table.
 */
export const MERGE_WISHLIST_SQL = `
        INSERT INTO wishlist_items (user_id, product_id)
        SELECT $1, w.product_id FROM wishlist_items w WHERE w.guest_token = $2
        ON CONFLICT (user_id, product_id) WHERE user_id IS NOT NULL DO NOTHING
        `;

@Injectable()
export class WishlistService {
  constructor(
    @InjectRepository(WishlistItem) private readonly items: Repository<WishlistItem>,
    @InjectRepository(Product) private readonly products: Repository<Product>,
    private readonly catalog: CatalogService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * The saved products, newest first, priced live through the catalogue mapper.
   *
   * Returns full wire `Product` objects rather than slugs, so the wishlist page renders the same
   * `ProductCard` as the shop — including its SOLD OUT state, which is the most useful thing a saved
   * list can tell you.
   *
   * `user` is forwarded to `CatalogService.productsBySlugs` unchanged, not derived from `owner`:
   * `owner.userId` is a bare id with no segment attached, and re-deriving a `PricingViewer` from it
   * here would be a second, competing resolution of the same question `CatalogService.viewerFor`
   * already answers. A signed-in business's saved products must show their own price, the same as
   * every other catalogue read.
   */
  async list(owner: WishlistOwner, user: AuthenticatedUser | undefined): Promise<WireProduct[]> {
    // `id` is selected deliberately. `select` constrains the root entity's columns while `relations`
    // still hydrates the relation in full — the pattern `seeds/seed-context.ts:80` already relies on —
    // but omitting the primary key from a select is asking for trouble with relation hydration, and
    // `slugs()` below selects it too. Keep the two consistent.
    const rows = await this.items.find({
      where: this.ownerWhere(owner),
      order: { createdAt: 'DESC' },
      select: { id: true, createdAt: true },
      relations: { product: true },
    });
    if (rows.length === 0) return [];

    const bySlug = new Map(
      (
        await this.catalog.productsBySlugs(
          rows.map((row) => row.product.slug),
          user,
        )
      ).map((product) => [product.slug, product]),
    );
    // Ordered by the wishlist, not by the catalogue query, so "newest saved first" survives.
    return rows
      .map((row) => bySlug.get(row.product.slug))
      .filter((product): product is WireProduct => product !== undefined);
  }

  /**
   * Saves a product. Idempotent: saving twice is not an error, because the heart is a toggle and a
   * double click must not 409 at the customer.
   *
   * **`isPublished` is part of the lookup, and it closed an existence oracle.** This route answered
   * **200** for an unpublished slug and **404** for one no product has, while every catalogue route —
   * `catalog.service.ts`'s `baseQuery` is `WHERE product.isPublished = true` — answered 404 for both.
   * A client could therefore probe `POST /wishlist/<guess>` and read which unreleased product slugs
   * exist straight off the status code. The two answers are now the same one, which is also the only
   * answer consistent with `list()`: that went through the catalogue mapper all along, so an
   * unpublished save was already dropped on the way out and the heart was filled for a product the
   * wishlist page refused to show.
   *
   * In the `where`, not tested against the `select`. `select: { id: true }` stays as it is — a column
   * omitted from a narrowed select arrives `undefined`, `undefined` is falsy, and an `isPublished`
   * check against that would 404 every product in the shop.
   */
  async add(owner: WishlistOwner, slug: string): Promise<void> {
    const product = await this.products.findOne({
      where: { slug, isPublished: true },
      select: { id: true },
    });
    if (!product) {
      throw new DomainError(
        ErrorCodes.NOT_FOUND,
        'That product may have been renamed or is no longer stocked.',
        HttpStatus.NOT_FOUND,
      );
    }

    // `orIgnore()` leans on the partial unique index, so two concurrent saves cannot both insert —
    // the same reasoning as the cart's conditional update, one layer simpler.
    await this.items
      .createQueryBuilder()
      .insert()
      .values({
        userId: owner.userId ?? null,
        guestToken: owner.guestToken ?? null,
        productId: product.id,
      })
      .orIgnore()
      .execute();
  }

  /**
   * Unsaves a product. **Deliberately not filtered on `isPublished`, unlike `add()`** — do not make
   * the two symmetrical.
   *
   * A row saved before the product was withdrawn is still the customer's row, and it is theirs to
   * clear. Filtering here would strand it: `slugs()` no longer lists it, so they could not even see
   * what they were failing to remove. It costs nothing in oracle terms either — this route answers
   * with the saved slugs whatever happens, so an unpublished slug and an absent one are already
   * indistinguishable from outside.
   *
   * Not filtering also means an admin who withdraws a product for a fortnight and republishes it
   * hands every customer their save back, rather than having silently emptied their lists.
   */
  async remove(owner: WishlistOwner, slug: string): Promise<void> {
    const product = await this.products.findOne({ where: { slug }, select: { id: true } });
    // Removing something that is not there is a no-op, not a 404: the customer's intent is satisfied
    // either way, and a toggle that errors on the second click is worse than one that does nothing.
    if (!product) return;
    await this.items.delete({ ...this.ownerWhere(owner), productId: product.id });
  }

  /**
   * Folds a guest's saved items into the account on sign-in, then deletes the guest rows.
   *
   * `ON CONFLICT ... DO NOTHING` again, because the customer may have saved the same product both
   * signed in and as a guest — a duplicate is the expected case here, not an exception. See
   * `MERGE_WISHLIST_SQL` for why the `WHERE` predicate on the conflict target cannot be dropped.
   */
  async mergeInto(userId: string, guestToken: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(MERGE_WISHLIST_SQL, [userId, guestToken]);
      await manager.getRepository(WishlistItem).delete({ guestToken });
    });
  }

  /**
   * Just the saved slugs, newest first. What the heart needs and what both mutations return.
   *
   * Deliberately separate from `list()`: that one goes through the catalogue mapper to build full wire
   * products for the wishlist page, which is far more work than a toggle needs.
   *
   * **Published only, so this agrees with `list()`.** The two had drifted: `list()` resolves through
   * `CatalogService.productsBySlugs`, which filters on publication, so an unpublished save was already
   * dropped there — while this method returned it, and this is the method the heart reads. The visible
   * result was a heart rendered filled on every listing page for a product the wishlist page would not
   * show.
   *
   * A condition on the joined product rather than a filter over the returned rows: the predicate
   * belongs in SQL, and reading `row.product.isPublished` here would depend on the `select` above
   * continuing not to narrow the relation — the same `undefined`-is-falsy hazard that makes this an
   * `isPublished: true` criterion and not a column in a `select`. The owner half of the `where` is
   * spread from `ownerWhere` so it still throws rather than building an unscoped query.
   */
  async slugs(owner: WishlistOwner): Promise<string[]> {
    const rows = await this.items.find({
      where: { ...this.ownerWhere(owner), product: { isPublished: true } },
      order: { createdAt: 'DESC' },
      relations: { product: true },
      select: { id: true, createdAt: true },
    });
    return rows.map((row) => row.product.slug);
  }

  private ownerWhere(owner: WishlistOwner): { userId: string } | { guestToken: string } {
    if (owner.userId) return { userId: owner.userId };
    if (owner.guestToken) return { guestToken: owner.guestToken };
    // Never build an unscoped query. An empty `where` would return every wishlist in the database.
    throw new DomainError(
      ErrorCodes.NOT_FOUND,
      'No wishlist for this visitor.',
      HttpStatus.NOT_FOUND,
    );
  }
}
