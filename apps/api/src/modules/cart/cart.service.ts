import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { Cart } from '../../entities/commerce/cart.entity';
import { CartItem } from '../../entities/commerce/cart-item.entity';
import { OrderChannelEnum } from '../../entities/enums';
import { Product } from '../../entities/catalog/product.entity';
import { ProductVariant } from '../../entities/catalog/product-variant.entity';
import { MAX_LINE_QTY } from './cart.constants';
import type { ReplaceCartDto } from './dto/replace-cart.dto';

/** The fields that decide whether two cart lines are the same line. */
interface MergeableLine {
  productId: string;
  variantId: string | null;
  mode: 'RETAIL' | 'BULK';
  kg: string | null;
  qty: number;
}

/**
 * The identity of a cart line.
 *
 * A product in two pack sizes is two lines; the same product retail and bulk is two lines; and two
 * bulk weights are two lines, because 10kg and 25kg resolve to different pricing tiers and folding
 * them would misprice the basket.
 */
const lineKey = (line: MergeableLine): string =>
  `${line.mode}|${line.productId}|${line.variantId ?? ''}|${line.kg ?? ''}`;

/**
 * Folds a guest's lines into the signed-in user's, summing quantities for lines that match.
 *
 * Exported for its own unit test: the arithmetic is the part worth testing in isolation, and the
 * database behaviour around it is proven against Postgres in Task 23.
 */
export function mergeLines<T extends MergeableLine>(existing: T[], incoming: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const line of existing) byKey.set(lineKey(line), { ...line });

  for (const line of incoming) {
    const key = lineKey(line);
    const current = byKey.get(key);
    // Summed, not maxed: two bags added as a guest plus one added after signing in is three bags.
    //
    // Clamped to `MAX_LINE_QTY`, which is the same cap `CartLineDto` enforces with `@Max`. Without the
    // clamp this function can write state the API's own validator refuses: 999 as a guest plus 999
    // signed in stores 1998 in an `int` column quite happily, and then **every** subsequent
    // `PUT /cart` fails validation with `qty must not be greater than 999` — because the client echoes
    // the basket back as it read it. The customer's cart becomes unremovable and unmodifiable, and
    // they discover it at checkout.
    //
    // Clamping rather than throwing, because the alternative is failing the sign-in merge, which is the
    // exact moment this task opens by calling the worst possible one to lose a basket. Keeping 999 of
    // something is a better outcome than keeping nothing, and a customer who genuinely wants more than
    // 999 units belongs in the RFQ form — which is the reasoning behind the cap in the first place.
    if (current) current.qty = Math.min(current.qty + line.qty, MAX_LINE_QTY);
    else byKey.set(key, { ...line, qty: Math.min(line.qty, MAX_LINE_QTY) });
  }

  return [...byKey.values()];
}

@Injectable()
export class CartService {
  constructor(
    @InjectRepository(Cart) private readonly carts: Repository<Cart>,
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @InjectRepository(ProductVariant) private readonly variants: Repository<ProductVariant>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Finds the caller's cart, or `null` when they have never had one.
   *
   * Deliberately does not create on read: a bot crawling the shop would otherwise leave a cart row
   * per request. Rows are created on the first write instead.
   *
   * `manager` makes the read join a caller's transaction instead of taking its own connection.
   * `CheckoutService.place` needs that: reading the basket outside the transaction that prices it,
   * decrements stock against it and then empties it is a read-then-write gap, and a `PUT /cart`
   * landing in the middle would leave the order priced from one snapshot and the delete issued
   * against another. Optional so the three existing callers are unchanged, and it is this method
   * rather than a fourth copy of the `relations` clause in the checkout module — `toValidatable`
   * reads `isPublished`, `pricingTiers` and `variant.inventory` straight off the loaded relations, so
   * a clause that drifts makes every stored line read `NOT_FOUND`.
   */
  async find(
    owner: { userId?: string; guestToken?: string },
    manager?: EntityManager,
  ): Promise<Cart | null> {
    const repository = manager ? manager.getRepository(Cart) : this.carts;
    const relations = {
      items: { product: { pricingTiers: true }, variant: { inventory: true } },
    };

    if (owner.userId) return repository.findOne({ where: { userId: owner.userId }, relations });
    if (owner.guestToken) {
      return repository.findOne({ where: { guestToken: owner.guestToken }, relations });
    }
    return null;
  }

  /**
   * Replaces the whole basket.
   *
   * A whole-basket `PUT` rather than per-line endpoints, because the client already holds the array
   * and this makes the server's state a function of one request instead of a sequence — so a dropped
   * request cannot leave the two disagreeing about a quantity, and there is no ordering to get wrong.
   *
   * Every line is resolved against the live catalogue and rejected if it does not exist. Storing a
   * slug the catalogue does not have would produce a basket that cannot be priced.
   *
   * "Does not exist" means the catalogue's definition of it, `isPublished` included — see
   * `resolveLines`.
   */
  async replace(
    owner: { userId?: string; guestToken?: string },
    dto: ReplaceCartDto,
  ): Promise<Cart> {
    const resolved = await this.resolveLines(dto);

    return this.dataSource.transaction(async (manager) => {
      const cart = await this.upsertCart(manager, owner);
      await this.lockCart(manager, cart.id);
      await manager.getRepository(CartItem).delete({ cartId: cart.id });
      if (resolved.length > 0) {
        await manager
          .getRepository(CartItem)
          .insert(resolved.map((line) => ({ ...line, cartId: cart.id })));
      }
      // Touched so spec §38's abandoned-cart notification has a timestamp to read.
      await manager.getRepository(Cart).update({ id: cart.id }, { updatedAt: new Date() });
      return this.mustFind(manager, cart.id);
    });
  }

  /**
   * Folds a guest cart into the user's and deletes the guest one, in one transaction.
   *
   * Called immediately after sign-in. If this fails silently the customer loses their basket at the
   * checkout step, which is the worst possible moment, so it throws rather than swallowing.
   */
  async mergeInto(userId: string, guestToken: string): Promise<Cart> {
    return this.dataSource.transaction(async (manager) => {
      const guest = await manager.getRepository(Cart).findOne({
        where: { guestToken },
        relations: { items: true },
      });

      const userCart = await this.upsertCart(manager, { userId });
      await this.lockCart(manager, userCart.id);

      if (!guest || guest.items.length === 0) {
        // Nothing to fold. Still delete the guest row if it exists, so a stale empty cart does not
        // outlive the cookie and hold the unique key.
        if (guest) await manager.getRepository(Cart).delete({ id: guest.id });
        return this.mustFind(manager, userCart.id);
      }

      const existing = await manager
        .getRepository(CartItem)
        .find({ where: { cartId: userCart.id } });
      const merged = mergeLines(
        existing.map((item) => this.toMergeable(item)),
        guest.items.map((item) => this.toMergeable(item)),
      );

      await manager.getRepository(CartItem).delete({ cartId: userCart.id });
      await manager.getRepository(CartItem).insert(
        merged.map((line) => ({
          ...line,
          mode: line.mode as OrderChannelEnum,
          cartId: userCart.id,
        })),
      );
      // Deleting the guest cart cascades to its items, and is what makes a repeated merge impossible.
      await manager.getRepository(Cart).delete({ id: guest.id });

      return this.mustFind(manager, userCart.id);
    });
  }

  private toMergeable(item: CartItem): MergeableLine {
    return {
      productId: item.productId,
      variantId: item.variantId,
      mode: item.mode === OrderChannelEnum.BULK ? 'BULK' : 'RETAIL',
      kg: item.kg,
      qty: item.qty,
    };
  }

  /**
   * Resolves wire lines to entity columns, rejecting anything the catalogue cannot account for.
   *
   * One query for the products and one for the variants, not one per line: a twenty-line basket
   * would otherwise be forty round trips on every save.
   *
   * **`isPublished` is part of the product criterion, exactly as it is in `catalog.service.ts`'s
   * `baseQuery`.** Without it an unpublished product could be added to a basket, priced by
   * `CartReadService`, and checked out — while its own product page, its listing, its reviews and its
   * related rail all answered 404, because every one of those goes through a query that filters on
   * publication. Unpublishing is what an admin does to pull a product mid-season, so this is the
   * ordinary path and not an edge case. The asymmetry that gave it away is visible two statements
   * down: variants were already filtered on `isActive`, so variant activation had been considered and
   * product publication had not.
   *
   * In the `where` and not in the `select`. A column left out of a narrowed `select` comes back
   * `undefined`, `undefined` is falsy, and an `isPublished` test against that rejects **every**
   * product in the shop — a basket nothing can be added to. The `select` below stays at `id` and
   * `slug`, which is all the loop reads.
   */
  private async resolveLines(
    dto: ReplaceCartDto,
  ): Promise<
    Omit<CartItem, 'id' | 'cartId' | 'cart' | 'product' | 'variant' | 'createdAt' | 'updatedAt'>[]
  > {
    if (dto.lines.length === 0) return [];

    const slugs = [...new Set(dto.lines.map((line) => line.slug))];
    const products = await this.products.find({
      where: slugs.map((slug) => ({ slug, isPublished: true })),
      select: { id: true, slug: true },
    });
    const productBySlug = new Map(products.map((product) => [product.slug, product]));

    /**
     * **`find({ where: [] })` returns every row.** Measured: against the seeded catalogue it comes back
     * with all 27 products, not zero — TypeORM treats an empty OR-array as no condition at all, the same
     * trap as `IN ()` being a syntax error rather than an empty set.
     *
     * `products` is empty exactly when no line's slug resolved, so without this guard a basket full of
     * unknown slugs would load **every variant in the catalogue** before the loop below threw
     * `NOT_FOUND`. Harmless in outcome, wasteful now, and a genuine hazard the moment anyone reuses this
     * shape somewhere the result is returned rather than discarded.
     */
    const variants =
      products.length === 0
        ? []
        : await this.variants.find({
            where: products.map((product) => ({ productId: product.id })),
            select: { id: true, productId: true, size: true, isActive: true },
          });

    return dto.lines.map((line) => {
      const product = productBySlug.get(line.slug);
      if (!product) {
        throw new DomainError(
          ErrorCodes.NOT_FOUND,
          `We no longer stock one of the items in your basket.`,
          HttpStatus.UNPROCESSABLE_ENTITY,
          { slug: line.slug },
        );
      }

      // A retail line names a pack size; a bulk line names a weight and is not variant-bound.
      const variant =
        line.mode === 'retail'
          ? variants.find(
              (candidate) =>
                candidate.productId === product.id &&
                candidate.size === line.size &&
                candidate.isActive,
            )
          : undefined;

      if (line.mode === 'retail' && !variant) {
        throw new DomainError(
          ErrorCodes.NOT_FOUND,
          `That pack size is no longer available.`,
          HttpStatus.UNPROCESSABLE_ENTITY,
          { slug: line.slug, size: line.size },
        );
      }

      return {
        productId: product.id,
        variantId: variant?.id ?? null,
        mode: line.mode === 'bulk' ? OrderChannelEnum.BULK : OrderChannelEnum.RETAIL,
        kg: line.kg === undefined ? null : String(line.kg),
        qty: line.qty,
      };
    });
  }

  /**
   * Serialises whole-basket writes to one cart.
   *
   * Both `replace` and `mergeInto` delete every `cart_items` row and re-insert. Without this lock, two
   * overlapping transactions each delete on a READ COMMITTED snapshot in which the other's inserts are
   * invisible, and then **both** sets of inserts survive. Measured before the fix: four concurrent
   * `PUT /cart` of a single ₹299 × 2 line left three copies and a subtotal of ₹1,794 in place of ₹598 —
   * a customer charged three times for one basket, with no error anywhere.
   *
   * Locking the parent `carts` row rather than the item rows is deliberate: the rows being protected are
   * the ones about to be deleted and created, so there is nothing stable to lock at that level. Taking
   * it immediately after `upsertCart` also means the row always exists by the time we ask, whether this
   * transaction created it or adopted a rival's.
   *
   * A whole-basket `PUT` stays last-writer-wins, which is the endpoint's contract. The lock decides only
   * that the writers take turns instead of interleaving into one basket.
   */
  private async lockCart(manager: EntityManager, cartId: string): Promise<void> {
    await manager.query('SELECT id FROM carts WHERE id = $1 FOR UPDATE', [cartId]);
  }

  private async upsertCart(
    manager: EntityManager,
    owner: { userId?: string; guestToken?: string },
  ): Promise<Cart> {
    const repository = manager.getRepository(Cart);
    const where = owner.userId ? { userId: owner.userId } : { guestToken: owner.guestToken };

    /**
     * Insert-or-ignore, then read. **Not** `findOne` followed by `save` when it returns nothing — that
     * is a check-then-insert race, and this is a reachable one rather than a theoretical one.
     *
     * Two writes arrive for the same owner before either has created the row: a customer
     * double-clicking Add to Cart as a guest with no cart yet, or `mergeInto`'s `upsertCart({ userId })`
     * landing beside an in-flight `PUT /cart` from the same session. Both `findOne` calls return null,
     * both insert, and the second violates `uq_carts_user` or `uq_carts_guest_token` — a 500 on a
     * customer's first attempt to put something in their basket.
     *
     * `ON CONFLICT DO NOTHING` closes it. Inside this transaction the losing insert blocks on the unique
     * index until the winner commits, then does nothing; the `findOne` that follows runs on a fresh
     * READ COMMITTED snapshot and sees the winner's row. Task 27's wishlist already does exactly this,
     * for exactly this reason — Task 18 simply predates the pattern.
     *
     * `ck_carts_owner_exclusive` requires exactly one owner, so the unset side is explicitly null rather
     * than omitted. An omitted column would default to null anyway, but stating it is what makes the
     * constraint's requirement visible at the write site.
     */
    await repository
      .createQueryBuilder()
      .insert()
      .values({ userId: owner.userId ?? null, guestToken: owner.guestToken ?? null })
      .orIgnore()
      .execute();

    const cart = await repository.findOne({ where });
    if (!cart) {
      // Neither our insert nor a concurrent one produced a row, which cannot happen unless the owner
      // predicate and the inserted columns disagree. Loud rather than a null the callers would deref.
      throw new Error(`Cart for ${JSON.stringify(owner)} was neither found nor created`);
    }
    return cart;
  }

  private async mustFind(manager: EntityManager, id: string): Promise<Cart> {
    const cart = await manager.getRepository(Cart).findOne({
      where: { id },
      relations: { items: { product: { pricingTiers: true }, variant: { inventory: true } } },
    });
    if (!cart) throw new Error(`Cart ${id} vanished inside its own transaction`);
    return cart;
  }
}
