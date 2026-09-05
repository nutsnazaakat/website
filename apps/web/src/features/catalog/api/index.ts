import type {
  CatalogFacets,
  Category,
  Combo,
  Paginated,
  Product,
  ProductFilters,
} from "@/contract";
import { http } from "@/lib/http";
import { toQueryString } from "@/lib/query-string";

/**
 * The catalogue over the real API.
 *
 * Every method that took the mock's in-memory array now issues one request. Two behaviours are
 * deliberately preserved from the mock so no consumer has to change how it handles them:
 *
 * - `getProduct` and `getCategory` reject for an unknown slug. The mock threw `NotFoundError`; the
 *   server answers 404 and `http.ts` turns that into `ApiRequestError`. Both routes already cope, but
 *   **by different means, so do not "fix" either**: `product.$slug.tsx` tests `isError || !product`
 *   and renders its not-found state, while `category.$slug.tsx` never checks the error at all — it
 *   reads `category?.name ?? slug` throughout and shows the slug with an empty product grid. That
 *   degradation is deliberate and reads better than a 404 page; adding an error boundary there would
 *   replace a working empty state with a dead end.
 * - `listRelated` resolves to an empty page for an unknown slug rather than rejecting, because a
 *   related-products rail is decoration and must not break a page that otherwise renders.
 *
 * The lists answer `Paginated<Product>`, not `Product[]`. A caller that wants a whole small set —
 * a slug-to-name lookup, say — must ask for a `limit` wide enough to hold it, because the server's
 * default page is 24 and the catalogue is larger than that.
 */
export const catalogApi = {
  listProducts: (filters: ProductFilters = {}): Promise<Paginated<Product>> =>
    http.get(`/catalog/products${toQueryString({ ...filters })}`),

  facets: (): Promise<CatalogFacets> => http.get("/catalog/products/facets"),

  getProduct: (slug: string): Promise<Product> =>
    http.get(`/catalog/products/${encodeURIComponent(slug)}`),

  listBestsellers: (limit = 8): Promise<Paginated<Product>> =>
    http.get(`/catalog/products/bestsellers${toQueryString({ limit })}`),

  listRelated: (slug: string, limit = 4): Promise<Paginated<Product>> =>
    http.get(`/catalog/products/${encodeURIComponent(slug)}/related${toQueryString({ limit })}`),

  listCategories: (): Promise<Category[]> => http.get("/catalog/categories"),

  getCategory: (slug: string): Promise<Category> =>
    http.get(`/catalog/categories/${encodeURIComponent(slug)}`),

  listCombos: (): Promise<Combo[]> => http.get("/catalog/combos"),
};
