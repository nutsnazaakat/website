import type { Product, WishlistSlugs } from "@/contract";
import { http } from "@/lib/http";

/**
 * The wishlist over the real API.
 *
 * Both mutations return the new set of saved slugs, so a toggle needs no follow-up read and the reply
 * is what the provider reconciles its optimistic state against — the same shape as `PUT /cart`.
 *
 * `list` is the only call that answers with products, and only `/wishlist` needs it: every other page
 * renders hearts, which need membership and nothing else. `remove` takes no body and no
 * `AbortSignal`, because `http.delete` accepts neither.
 *
 * The slug goes through `encodeURIComponent` even though every seeded slug is `[a-z0-9-]`. It is a
 * path segment built from data, and a slug containing `/`, `?` or `#` would otherwise address a
 * different route entirely.
 */
export const wishlistApi = {
  list: (): Promise<Product[]> => http.get("/wishlist"),
  slugs: (): Promise<WishlistSlugs> => http.get("/wishlist/slugs"),
  add: (slug: string): Promise<WishlistSlugs> => http.post(`/wishlist/${encodeURIComponent(slug)}`),
  remove: (slug: string): Promise<WishlistSlugs> =>
    http.delete(`/wishlist/${encodeURIComponent(slug)}`),
};
