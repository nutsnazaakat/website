import type { BlogPost, BlogPostSummary } from "@/contract";
import { http } from "@/lib/http";
import { toQueryString } from "@/lib/query-string";
import type { BlogCategory } from "../types";

/**
 * The blog over the real API — spec §6.1's three `/content/posts` routes, brief §28.
 *
 * **This was the last mock-backed feature in the storefront.** Ten of the eleven `features/*​/api`
 * modules already read the server; this one still imported `@/mocks/posts`, so the admin console's
 * `/blog` screens wrote into `blog_posts`, the writes succeeded, the console listed them as
 * published — and the storefront rendered eight hardcoded posts regardless. An editor could publish
 * an article, see it saved, open the site, and not find it, with no error anywhere. The backend side
 * had been finished and unused since Milestone 3: `content.controller.ts`'s own docblock recorded
 * that nothing had ever consumed it.
 *
 * Four differences from the mock, all of them the server's behaviour rather than a choice made here:
 *
 * - **The lists answer `BlogPostSummary`, not `BlogPost`.** No `body`, because a listing of eight
 *   posts must not be eight full articles. `readingMinutes` *is* on the summary — the storefront
 *   prints "N min read" on list cards and on the related rail, and the server derives it from a body
 *   it has already loaded.
 * - **Ordering is the server's**, `publishedAt DESC, slug ASC`. The mock sorted client-side; that
 *   sort is gone rather than kept as a no-op, because two orderings that agree today drift silently.
 * - **`getPost` rejects for an unknown slug** where the mock threw `NotFoundError`. The server
 *   answers 404 and `http.ts` turns it into `ApiRequestError`. `blog/$slug.tsx` already tests
 *   `isError || !post`, so it needs no change.
 * - **`listRelatedPosts` rejects for an unknown slug** where the mock resolved to `[]`. That is
 *   deliberate on the server — `ContentService` explains that answering an empty array for a draft
 *   slug would confirm the draft exists to anyone who guessed it. Safe here: the rail is guarded by
 *   `related !== undefined && related.length > 0`, and a slug whose related read 404s is a slug
 *   whose post read 404s too, so the page is already rendering its not-found state.
 *
 * The `limit` parameter the mock took is gone: `/content/posts/:slug/related` accepts no query and
 * fixes the count at three server-side. Nothing passed it.
 */
export const contentApi = {
  /**
   * `category` is omitted from the query for `"all"` as well as for `undefined`.
   *
   * `PostQueryDto` validates it with `@IsIn(BLOG_CATEGORIES)`, so `?category=all` is a **400**, not
   * an unfiltered list. The sentinel stays in this signature because the hook and the route's URL
   * state both use it; it is translated here, at the seam, rather than at every call site.
   */
  listPosts: (category?: BlogCategory | "all"): Promise<BlogPostSummary[]> =>
    http.get(
      `/content/posts${toQueryString(
        category === undefined || category === "all" ? {} : { category },
      )}`,
    ),

  getPost: (slug: string): Promise<BlogPost> =>
    http.get(`/content/posts/${encodeURIComponent(slug)}`),

  listRelatedPosts: (slug: string): Promise<BlogPostSummary[]> =>
    http.get(`/content/posts/${encodeURIComponent(slug)}/related`),
};
