import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { Product } from '../catalog/product.entity';
import { User } from '../identity/user.entity';

/**
 * One saved product, owned by either an account or an anonymous visitor.
 *
 * One flat table rather than a parent and child. A wishlist has no attributes of its own: it is a
 * set of products per owner. `Cart` needs a parent row because it carries `updatedAt` for the
 * abandoned-cart notification and because a cart line has a quantity and a mode; a saved product
 * has neither.
 *
 * Exactly one of `userId`/`guestToken` is set — `ck_wishlist_items_owner_exclusive` enforces it in
 * the database rather than trusting every future writer, the same reasoning as `carts`. Like
 * `ck_carts_owner_exclusive` it lives only in the migration, not in a `@Check` decorator, because
 * that is where `carts` put it and a second convention for the same rule is worse than either.
 */
@Entity('wishlist_items')
export class WishlistItem extends BaseEntity {
  /**
   * `idx_wishlist_items_user` and `idx_wishlist_items_guest` are strictly redundant for owner
   * lookups and are kept anyway — recorded here so the next reader knows it was measured, not
   * overlooked. `uq_wishlist_items_user_product` is a btree on `(user_id, product_id)`, so it
   * already serves `WHERE user_id = $1`: with 2500 rows on a throwaway database, dropping
   * `idx_wishlist_items_user` moved the plan from `Bitmap Index Scan on idx_wishlist_items_user`
   * to `Bitmap Index Scan on uq_wishlist_items_user_product` and nothing else changed. The same
   * holds for the guest pair.
   *
   * They stay because these two decorators are the only indexes the entity metadata declares for
   * this table — the check constraint and both unique indexes live in the migration alone, as they
   * do for `carts` — so removing them would leave the entity describing no index at all. Two small
   * btrees on a table written once per heart-click is the cheaper side of that trade.
   */
  @Index('idx_wishlist_items_user')
  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: User | null;

  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId: string | null;

  /**
   * The shared `nn_guest_token` key. See `guest-token.ts`.
   *
   * Named `guest_token` and not the `guestKey` spec §5.3 asks for, for the reason
   * `20260820090000-GuestCarts.ts` records: `pii-redactor.ts` matches on the key *name* and holds
   * no list of this application's fields, so `guestKey` would be logged in plaintext while
   * `guestToken` is caught by the `token` substring rule. The value is a bearer credential for a
   * basket and a saved-items list.
   */
  @Index('idx_wishlist_items_guest')
  @Column({ type: 'varchar', length: 64, name: 'guest_token', nullable: true })
  guestToken: string | null;

  /**
   * `CASCADE`, not `SET NULL`, and this matches the existing split rather than inventing one.
   *
   * Checked every FK referencing `products`: `cart_items`, `pricing_tiers`, `product_images` and
   * `product_variants` all CASCADE — they describe what a product *is* or what is currently in
   * someone's basket, so they have no meaning without it. `order_items`, `reviews` and `rfq_items`
   * all SET NULL — they are historical records that must survive to reprint an invoice or keep a
   * review readable.
   *
   * A saved product is the first group: there is nothing to reprint, and a wishlist row pointing at
   * nothing is not a record worth keeping. `cart_items` is the closest analogue and does the same.
   *
   * (An earlier version of this note said "nothing referencing `products` uses RESTRICT, so a product
   * can actually be deleted". That is false, and it matters to anyone writing a cascade test.
   * `product_variants.product_id` does CASCADE, but `inventory_transactions.variant_id` is
   * `ON DELETE RESTRICT` — `InitialSchema` line 352 — and `seedCatalog` writes one opening `RECEIPT`
   * per variant. So **no seeded product can be deleted**, measured:
   *
   *     DELETE FROM products WHERE slug = 'premium-california-almonds';
   *     ERROR: update or delete on table "product_variants" violates foreign key constraint
   *            "FK_aeb0f3a59ed2fd95e1a13097eda" on table "inventory_transactions"
   *
   * `wishlist.integration.spec.ts` asserts that error first, then clears the ledger rows as fixture
   * before exercising the cascade — which is the honest way round, and is why the ledger's RESTRICT is
   * the real protection here rather than this column's CASCADE.)
   */
  @ManyToOne(() => Product, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Column({ type: 'uuid', name: 'product_id' })
  productId: string;
}
