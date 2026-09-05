/**
 * What every wishlist write, and the membership read, answer with.
 *
 * Here rather than inline in the controller for the reason `types/cart.ts` gives about `CartLine`:
 * this is a **wire shape**, and both ends have to agree on it. Task 27 left it as an inline
 * `Promise<{ slugs: string[] }>` on three handlers, and Task 28's client repeated the same literal
 * in `features/wishlist/api` — four independent declarations of one contract, none of which would
 * notice the others being renamed to `saved`.
 *
 * Deliberately **not** merged into `types/cart.ts` even though the wishlist reuses the cart's guest
 * token: the two are separate endpoints with separate lifetimes, and one shared file would say they
 * are the same feature.
 *
 * Slugs and not `Product[]`: the heart only needs membership, and a 24-card page would otherwise
 * fetch 24 fully priced products to decide the colour of 24 icons. `GET /wishlist` is the route that
 * answers with products, for the one page that renders them.
 */
export interface WishlistSlugs {
  slugs: string[];
}
