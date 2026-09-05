import type { AdminBlogPost, BlogCategory, Paginated } from "@/contract";
import { BLOG_CATEGORIES } from "@/contract";
import { http } from "@/lib/http";
import { toQueryString } from "@/lib/query-string";

/**
 * The blog seam — brief §28's six categories and §39's SEO block.
 * `GET`/`POST /admin/posts`, `PATCH`/`DELETE /admin/posts/:slug`.
 *
 * **Addressed by slug**, which is also the SEO-visible part of the public URL, which is why
 * changing it on a published post breaks a live link — see `blog/index.tsx`, where that warning
 * lives because that is where the operator is about to do it.
 *
 * **The admin list includes drafts; the public one does not.** `GET /content/posts` filters
 * `isPublished`, and `BlogPostSummary.publishedAt` is non-null there for exactly that reason. This
 * shape's `publishedAt` is nullable because a draft has never gone live.
 *
 * **There is no `GET /admin/posts/:slug`.** The controller has a list, a create, a patch and a
 * delete, and nothing that reads one post as an admin — the public route only serves published
 * ones. So the editor works from the rows already loaded rather than deep-linking to a fetch that
 * does not exist. Recorded here because it is the reason the screen is shaped the way it is.
 */

const CATEGORY_LOOKUP: ReadonlySet<string> = new Set<string>(BLOG_CATEGORIES);

export function isBlogCategory(value: unknown): value is BlogCategory {
  return typeof value === "string" && CATEGORY_LOOKUP.has(value);
}

export function parseBlogCategory(value: unknown): BlogCategory | undefined {
  return isBlogCategory(value) ? value : undefined;
}

export interface PostListQuery {
  category?: BlogCategory;
  isPublished?: boolean;
  page?: number;
  limit?: number;
}

/** `AdminPostQueryDto`'s `@Min(1) @Max(60)`. */
export const POSTS_PAGE_SIZE = 24;

export function fetchPosts(
  query: PostListQuery,
  signal?: AbortSignal,
): Promise<Paginated<AdminBlogPost>> {
  return http.get<Paginated<AdminBlogPost>>(`/admin/posts${toQueryString({ ...query })}`, signal);
}

/**
 * Brief §39's SEO block: title, meta description, OG image. The slug is the fourth field and lives
 * on the post itself rather than in here, because it is the row's identity as well as its URL.
 */
export interface PostSeoInput {
  title?: string;
  description?: string;
  ogImage?: string;
}

export interface PostInput {
  slug: string;
  title: string;
  category: BlogCategory;
  excerpt: string;
  image: string;
  author: string;
  body: string;
  isPublished?: boolean;
  seo?: PostSeoInput;
}

/** Created unpublished unless `isPublished` is sent — `AdminPostsService.create`. */
export function createPost(input: PostInput): Promise<AdminBlogPost> {
  return http.post<AdminBlogPost>("/admin/posts", input);
}

/**
 * `PATCH /admin/posts/:slug` — an omitted field is left unchanged.
 *
 * `slug` **is** patchable, and a taken slug is refused `409 IDENTIFIER_IN_USE`. Publishing stamps
 * `publishedAt` on the first publication only; unpublishing never clears it.
 */
export function updatePost(slug: string, input: Partial<PostInput>): Promise<AdminBlogPost> {
  return http.patch<AdminBlogPost>(`/admin/posts/${encodeURIComponent(slug)}`, input);
}

/**
 * `DELETE /admin/posts/:slug` — a hard delete, **unconditional**.
 *
 * Unlike a product or a coupon there is no `ENTITY_IN_USE` refusal to render, because nothing in
 * the schema references a post: no foreign key points at `blog_posts`, and "related posts" is a
 * same-category query rather than a stored link. So this one really does just delete, which is why
 * the screen asks before calling it.
 */
export function deletePost(slug: string): Promise<void> {
  return http.delete<void>(`/admin/posts/${encodeURIComponent(slug)}`);
}
