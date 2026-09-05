import type { CartLine } from '@nutwala/shared';
import type { CartItem } from '../../entities/commerce/cart-item.entity';
import { OrderChannelEnum } from '../../entities/enums';

/** The least a line needs to be named — a stored row and a wire DTO both satisfy it. */
export interface CartLineIdentity {
  slug: string;
  mode: 'retail' | 'bulk';
  /** Retail only. */
  size?: string;
  /** Bulk only. */
  kg?: number | null;
}

/**
 * The client's name for a basket line.
 *
 * Not the `cart_items` primary key, and that is the point. `CartProvider.tsx` builds
 * `r:${slug}:${size}` and `b:${slug}:${kg}` for lines it holds optimistically — before any row
 * exists — and keys `upsert`, `remove`, `setQty` and `switchLineToBulk` on it. A server answering
 * with row uuids would hand back lines the client cannot address, and an optimistic line would
 * never reconcile with the saved one: the basket would show both.
 *
 * One definition, used by `toCartLine` for `GET /cart` **and** by `CartReadService.toValidatable`
 * for `POST /cart/validate`, so a verdict can be joined to the line it is about. Two derivations
 * would let the two responses name the same line differently, and `CartValidationLine.id` would
 * match nothing on the page it exists to annotate.
 */
export function cartLineId(line: CartLineIdentity): string {
  return line.mode === 'bulk'
    ? `b:${line.slug}:${line.kg ?? 0}`
    : `r:${line.slug}:${line.size ?? ''}`;
}

/**
 * A stored row as the client sees it.
 *
 * No price, no name, no image — `CartLine`'s contract, because prices are resolved live on every
 * read and a cached price on the line is how a cart comes to disagree with the catalogue.
 *
 * `kg` is `numeric(8,2)`, which `pg` hands back as a string (`'25.00'`), and it is converted here
 * rather than passed through: the wire type declares a number, and the client's own id is built from
 * a number, so `'25.00'` would both break the type and spell an id that matches no optimistic line.
 *
 * The two conditional fields are omitted rather than sent as null. `CartLine` declares them optional
 * and the frontend branches on `line.kg !== undefined`, so a null would read as a bulk line.
 */
export function toCartLine(item: CartItem): CartLine {
  const mode = item.mode === OrderChannelEnum.BULK ? 'bulk' : 'retail';
  const kg = item.kg === null ? null : Number(item.kg);

  return {
    id: cartLineId({ slug: item.product.slug, mode, size: item.variant?.size, kg }),
    slug: item.product.slug,
    mode,
    ...(item.variant ? { size: item.variant.size, grams: item.variant.grams } : {}),
    ...(kg === null ? {} : { kg }),
    qty: item.qty,
  };
}
