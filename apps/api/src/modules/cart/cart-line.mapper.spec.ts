import type { CartItem } from '../../entities/commerce/cart-item.entity';
import { OrderChannelEnum } from '../../entities/enums';
import { cartLineId, toCartLine } from './cart-line.mapper';

const retailItem = (size = '250g', grams = 250, slug = 'premium-california-almonds'): CartItem =>
  ({
    id: '11111111-1111-1111-1111-111111111111',
    mode: OrderChannelEnum.RETAIL,
    kg: null,
    qty: 2,
    product: { slug },
    variant: { size, grams },
  }) as unknown as CartItem;

const bulkItem = (kg = '25.00', slug = 'premium-california-almonds'): CartItem =>
  ({
    id: '22222222-2222-2222-2222-222222222222',
    mode: OrderChannelEnum.BULK,
    kg,
    qty: 1,
    product: { slug },
    variant: null,
  }) as unknown as CartItem;

describe('cartLineId', () => {
  /**
   * The identity is the frontend's, not a new one. `CartProvider.tsx` already builds
   * `r:${slug}:${size}` and `b:${slug}:${kg}` and keys its own `upsert`, `remove` and `setQty` on
   * it, so a server that invented its own scheme would hand back lines the client could not address.
   *
   * Asserted as literals rather than against the template: a test that rebuilt the string the same
   * way the implementation does would agree with any scheme, including a wrong one.
   */
  it('spells a line the way the client already spells it', () => {
    expect(cartLineId({ slug: 'almonds', mode: 'retail', size: '250g' })).toBe('r:almonds:250g');
    expect(cartLineId({ slug: 'almonds', mode: 'bulk', kg: 25 })).toBe('b:almonds:25');
  });

  /**
   * The Task 18 lesson, one layer up. `lineKey` in `cart.service.ts` folds two lines into one when
   * their key matches, and this id is what the *client* folds on — so anything the id cannot
   * distinguish becomes one basket line in the browser, whatever the database holds.
   *
   * Every axis that makes two lines different has to move the string: the product, the pack size,
   * the weight, and retail versus bulk.
   */
  it('distinguishes every axis that makes two lines different', () => {
    const ids = [
      cartLineId({ slug: 'almonds', mode: 'retail', size: '250g' }),
      cartLineId({ slug: 'almonds', mode: 'retail', size: '500g' }),
      cartLineId({ slug: 'cashews', mode: 'retail', size: '250g' }),
      cartLineId({ slug: 'almonds', mode: 'bulk', kg: 10 }),
      cartLineId({ slug: 'almonds', mode: 'bulk', kg: 25 }),
    ];

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('toCartLine', () => {
  it('maps a stored retail line to the wire shape', () => {
    expect(toCartLine(retailItem())).toEqual({
      id: 'r:premium-california-almonds:250g',
      slug: 'premium-california-almonds',
      mode: 'retail',
      size: '250g',
      grams: 250,
      qty: 2,
    });
  });

  it('maps a stored bulk line, whose weight arrives from Postgres as a string', () => {
    expect(toCartLine(bulkItem())).toEqual({
      id: 'b:premium-california-almonds:25',
      slug: 'premium-california-almonds',
      mode: 'bulk',
      kg: 25,
      qty: 1,
    });
  });

  /**
   * `kg` is `numeric(8,2)`, so a whole weight arrives as `'25.00'` and must not reach the client as
   * the string `"25.00"` or the id as `b:slug:25.00` — the client builds `b:${slug}:${kg}` from a
   * *number*, so `25.00` would not match the line it already holds and the basket would show two.
   * A fractional weight has to survive the same conversion.
   */
  it('normalises a numeric weight to a number, whole or fractional', () => {
    expect(toCartLine(bulkItem('7.50'))).toMatchObject({
      kg: 7.5,
      id: 'b:premium-california-almonds:7.5',
    });
  });

  /**
   * The shared `CartLine` docblock promises "no price, name or image": prices are resolved live on
   * every read, and a cached price on the line is how a cart comes to disagree with the catalogue.
   * Asserted on the exact key set, because that promise is only kept by what is *absent*.
   *
   * It also pins the two conditional fields. A retail line must carry no `kg` and a bulk line no
   * `size`/`grams` — present-but-null would make `line.kg !== undefined` true for a retail line, and
   * the frontend branches on exactly that.
   */
  it('carries the wire contract and nothing else', () => {
    expect(Object.keys(toCartLine(retailItem())).sort()).toEqual([
      'grams',
      'id',
      'mode',
      'qty',
      'size',
      'slug',
    ]);
    expect(Object.keys(toCartLine(bulkItem())).sort()).toEqual(['id', 'kg', 'mode', 'qty', 'slug']);
  });
});
