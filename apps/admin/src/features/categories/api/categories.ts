import type { AdminCategory, Seo } from "@/contract";
import { http } from "@/lib/http";

/**
 * `GET`, `POST` and `PATCH /admin/categories` — spec §6.4 lists exactly these three verbs.
 *
 * **There is no delete route and none should be added.** `AdminCategoriesService` records the
 * reasoning: `products.category_id` is `ON DELETE RESTRICT`, so a category holding products cannot
 * be deleted anyway, and `isPublished: false` through the PATCH is what "take it off the storefront"
 * actually means. The contract says the same thing from the other side — there is no
 * `AdminCategory` delete shape because there is no route.
 *
 * **The list is a bare array, not `Paginated<T>`**, unlike every other admin list in this app. Brief
 * §7 fixes the catalogue at twelve categories, so pagination would be ceremony over a dozen rows;
 * `GET /admin/pricing-tiers` is paginated for the opposite reason and its controller says so.
 * Nothing here should invent a page parameter — `forbidNonWhitelisted` would answer 400.
 */

/** Every category, unpublished included, in display order (`sortOrder`, ties broken on id). */
export function fetchCategories(signal?: AbortSignal): Promise<AdminCategory[]> {
  return http.get<AdminCategory[]>("/admin/categories", signal);
}

/**
 * The editable half of a category, derived from the contract shape rather than restated.
 *
 * **`isPublished` *is* settable here**, unlike on a product, and the asymmetry is deliberate rather
 * than an oversight: spec §6.4 gives products a publish/unpublish endpoint pair and gives categories
 * none, so this field is a category's only route to being published. Adding a
 * `POST /admin/categories/:id/publish` for symmetry would be inventing surface the spec does not
 * list.
 */
export interface CategoryInput extends Pick<
  AdminCategory,
  "slug" | "name" | "image" | "blurb" | "description"
> {
  /** Display order on the storefront rail. Ties break on id, so a duplicate is stable, not random. */
  sortOrder?: number;
  /** Defaults to **true** on create, matching the column: a category with no products is harmless. */
  isPublished?: boolean;
  seo?: Seo;
}

/** The body keys the server will accept, listed once — see `productBody` for why copying beats
 * spreading against a `forbidNonWhitelisted` endpoint. */
const CATEGORY_FIELDS = [
  "slug",
  "name",
  "image",
  "blurb",
  "description",
  "sortOrder",
  "isPublished",
  "seo",
] as const;

function categoryBody(input: Partial<CategoryInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of CATEGORY_FIELDS) {
    const value = input[key];
    if (value !== undefined) body[key] = value;
  }
  return body;
}

export function createCategory(input: CategoryInput): Promise<AdminCategory> {
  return http.post<AdminCategory>("/admin/categories", categoryBody(input));
}

/** `PATCH /admin/categories/:id` — an omitted field is left unchanged. Addressed by **uuid**. */
export function updateCategory(id: string, input: Partial<CategoryInput>): Promise<AdminCategory> {
  return http.patch<AdminCategory>(
    `/admin/categories/${encodeURIComponent(id)}`,
    categoryBody(input),
  );
}
