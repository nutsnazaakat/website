import type { AdminProduct, AdminVariant, Badge, Paginated, Seo } from "@/contract";
import { http } from "@/lib/http";
import { toQueryString } from "@/lib/query-string";

/**
 * The catalogue seam — `/admin/products`, its publish pair, and the three variant routes.
 *
 * **Addressed by uuid, not by slug.** Every handler on `AdminProductsController` and
 * `AdminVariantsController` carries a `ParseUUIDPipe`, so a slug in the path is a 400 rather than a
 * 404. That is the opposite of the orders seam, where `:orderNumber` is the natural key and there is
 * no uuid pipe anywhere near it — the two are not a pattern to unify, they are two different
 * primary keys and the route parameter names say which.
 *
 * **Money on the wire is rupees, in both directions.** `AdminVariant.price` and `.mrp` arrive as
 * `899` and `1045`, and `CreateVariantDto` reads a request body as the same boundary in reverse:
 * `@IsNumber({ maxDecimalPlaces: 2 })` and the service's single `toPaise`. So nothing here
 * multiplies or divides by a hundred, and calling the contract's `toRupees` on a response would be
 * the second division that makes ₹899 read as ₹8.99.
 */

/**
 * What `GET /admin/products` accepts, and nothing else — `AdminProductQueryDto`'s four fields.
 *
 * The backend's `ValidationPipe` runs with `forbidNonWhitelisted`, so an undeclared parameter is a
 * **400**, not an ignored filter.
 *
 * `published` is **tri-state and the omitted case is the point of the endpoint**: absent means both
 * drafts and live listings, which is what an admin catalogue is for. `true` narrows to published,
 * `false` to drafts. It is serialised as the strings `"true"`/`"false"`, which is what the DTO's
 * `@Transform` reads — `@Type(() => Boolean)` was measured to turn `"false"` into `true`, and the
 * DTO records it.
 *
 * `category` is the category **slug**, matching the storefront's vocabulary, even though every
 * write on this resource addresses a category by uuid.
 */
export interface ProductListQuery {
  q?: string;
  category?: string;
  published?: boolean;
  page?: number;
  limit?: number;
}

/** `AdminProductQueryDto`'s `@Min(1) @Max(60)`, and `AdminProductsService`'s `DEFAULT_LIMIT`. */
export const PRODUCTS_PAGE_SIZE = 24;
export const PRODUCTS_MAX_PAGE_SIZE = 60;

export function fetchProducts(
  query: ProductListQuery,
  signal?: AbortSignal,
): Promise<Paginated<AdminProduct>> {
  return http.get<Paginated<AdminProduct>>(`/admin/products${toQueryString({ ...query })}`, signal);
}

export function fetchProduct(id: string, signal?: AbortSignal): Promise<AdminProduct> {
  return http.get<AdminProduct>(`/admin/products/${encodeURIComponent(id)}`, signal);
}

/**
 * The editable half of a product, **derived from the contract shape rather than restated**.
 *
 * `Pick<AdminProduct, …>` so a field renamed in `types/catalog.ts` stops compiling here instead of
 * silently becoming a body key `forbidNonWhitelisted` answers 400 for. The four columns deliberately
 * absent from `CreateProductDto` are absent here for its reasons:
 *
 * - `rating` and `reviewCount` are denormalised aggregates of the `reviews` table, recomputed when
 *   a review is moderated. An operator typing them would put the database in permanent
 *   disagreement with itself.
 * - `isPublished` and `publishedAt` belong to the publish pair below. **A product always begins
 *   unpublished**, which is what keeps every live listing's `product.publish` audit row real.
 */
export interface ProductInput extends Pick<
  AdminProduct,
  | "name"
  | "slug"
  | "categoryId"
  | "subtitle"
  | "description"
  | "origin"
  | "grade"
  | "processing"
  | "shelfLife"
  | "storage"
  | "ingredients"
  | "hsn"
  | "gstRate"
> {
  /** Brief §16's minimum bulk order, in kilograms. Optional; the column defaults it. */
  moqKg?: number;
  /** Brief §47's "Quote Required". Checked before any pricing tier, so it wins over a priced slab. */
  quoteOnly?: boolean;
  badge?: Badge;
  seo?: Seo;
}

/**
 * The body keys the server will accept, listed once.
 *
 * A `Partial<ProductInput>` argument is not enough on its own: excess-property checking only fires
 * on object literals, so a caller handing over a wider object would send keys that
 * `forbidNonWhitelisted` turns into a 400 naming a field the operator never typed. Copying the
 * known keys is what makes that impossible rather than merely unlikely — the same reasoning
 * `changeOrderStatus` spells out for its three.
 */
const PRODUCT_FIELDS = [
  "name",
  "slug",
  "categoryId",
  "subtitle",
  "description",
  "origin",
  "grade",
  "processing",
  "shelfLife",
  "storage",
  "ingredients",
  "hsn",
  "gstRate",
  "moqKg",
  "quoteOnly",
  "badge",
  "seo",
] as const;

function productBody(input: Partial<ProductInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of PRODUCT_FIELDS) {
    const value = input[key];
    if (value !== undefined) body[key] = value;
  }
  return body;
}

/** `POST /admin/products` — 201, and the product comes back **unpublished** whatever was sent. */
export function createProduct(input: ProductInput): Promise<AdminProduct> {
  return http.post<AdminProduct>("/admin/products", productBody(input));
}

/** `PATCH /admin/products/:id` — an omitted field is left unchanged. */
export function updateProduct(id: string, input: Partial<ProductInput>): Promise<AdminProduct> {
  return http.patch<AdminProduct>(`/admin/products/${encodeURIComponent(id)}`, productBody(input));
}

/**
 * `DELETE /admin/products/:id` — **204, no body**, and a refusal is the interesting path.
 *
 * A product that has been ordered or that has stock-ledger history answers `409 ENTITY_IN_USE`
 * carrying which of the two it was. See `refusals.ts`: that is a normal case to render, not an
 * error to swallow, and unpublish is the non-destructive operation to offer instead.
 *
 * A successful delete cascades `product_variants`, `product_images`, `pricing_tiers`, `inventory`,
 * `cart_items` and `wishlist_items` — so it does silently empty the baskets holding the product.
 * That is the schema's existing choice and the screen says so before asking.
 */
export function deleteProduct(id: string): Promise<void> {
  return http.delete<void>(`/admin/products/${encodeURIComponent(id)}`);
}

/**
 * `POST /admin/products/:id/publish` and its twin — **200, not 201**, answering the whole product.
 *
 * Idempotent: publishing an already-published product answers its current state and writes nothing,
 * not even an audit row. `publishedAt` is stamped on the *first* publish only and is never cleared,
 * so an unpublish/republish cycle keeps the record of when the listing first existed.
 */
export function publishProduct(id: string): Promise<AdminProduct> {
  return http.post<AdminProduct>(`/admin/products/${encodeURIComponent(id)}/publish`);
}

export function unpublishProduct(id: string): Promise<AdminProduct> {
  return http.post<AdminProduct>(`/admin/products/${encodeURIComponent(id)}/unpublish`);
}

/**
 * A variant's editable fields, derived from `AdminVariant` for `ProductInput`'s reason.
 *
 * **`lowStockThreshold` is on the create shape and not on the update one**, and that is the server's
 * rule rather than a simplification: `UpdateVariantDto` is `PartialType(PickType(CreateVariantDto,
 * […]))` with the threshold deliberately excluded, because it lives on the `Inventory` row and
 * `InventoryService` is the only writer that table's ledger invariant tolerates. Changing it later
 * is `PATCH /admin/inventory/:variantId/threshold`, which is the inventory screen's control — so
 * the product screen must not render an input for it on an existing variant.
 *
 * `onHand` is not settable at all. A variant is created with zero stock and stock arrives through
 * the audited inventory path, because `SUM(inventory_transactions.delta) = inventory.onHand` per
 * variant is an invariant the backend asserts.
 */
export interface VariantInput extends Pick<
  AdminVariant,
  "sku" | "size" | "grams" | "channel" | "price" | "mrp"
> {
  /** Minimum order quantity in **packs**, unlike the product's `moqKg`. */
  moq?: number;
  isActive?: boolean;
  /** Settable **only here**, at creation. See the docblock above. */
  lowStockThreshold?: number;
}

/** What `UpdateVariantDto` accepts: everything above except the threshold, all optional. */
export type VariantUpdate = Partial<Omit<VariantInput, "lowStockThreshold">>;

const VARIANT_CREATE_FIELDS = [
  "sku",
  "size",
  "grams",
  "channel",
  "price",
  "mrp",
  "moq",
  "isActive",
  "lowStockThreshold",
] as const;

/** `UpdateVariantDto`'s `PickType` list, verbatim — the threshold is not on it. */
const VARIANT_UPDATE_FIELDS = [
  "sku",
  "size",
  "grams",
  "channel",
  "price",
  "mrp",
  "moq",
  "isActive",
] as const;

/** `POST /admin/products/:id/variants` — creates the variant and its inventory row in one
 * transaction. A duplicate SKU is a named 409 rather than a driver error. */
export function createVariant(productId: string, input: VariantInput): Promise<AdminVariant> {
  const body: Record<string, unknown> = {};
  for (const key of VARIANT_CREATE_FIELDS) {
    const value = input[key];
    if (value !== undefined) body[key] = value;
  }
  return http.post<AdminVariant>(`/admin/products/${encodeURIComponent(productId)}/variants`, body);
}

/** `PATCH /admin/variants/:id`. */
export function updateVariant(variantId: string, input: VariantUpdate): Promise<AdminVariant> {
  const body: Record<string, unknown> = {};
  for (const key of VARIANT_UPDATE_FIELDS) {
    const value = input[key];
    if (value !== undefined) body[key] = value;
  }
  return http.patch<AdminVariant>(`/admin/variants/${encodeURIComponent(variantId)}`, body);
}

/**
 * `DELETE /admin/variants/:id` — 204, and refused `409 ENTITY_IN_USE` in three separate cases:
 * the variant still holds stock, it has been ordered, or it has ledger history. Each carries its
 * own count, and the non-destructive operation to offer is **deactivation**, which is how a pack is
 * withdrawn without destroying its stock trail.
 */
export function deleteVariant(variantId: string): Promise<void> {
  return http.delete<void>(`/admin/variants/${encodeURIComponent(variantId)}`);
}
