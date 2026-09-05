import type { BlogPost, BlogPostSummary } from "@/contract";
import { BLOG_CATEGORIES } from "@/contract";
import { posts, type PostFixture } from "./content-posts.fixture";

/**
 * The three public blog endpoints, for the route tests.
 *
 * The ninth handler `installAuthStub` delegates to, and it exists for the reason the other eight do:
 * there is a single `globalThis.fetch`, so layering a second stub on top would make the tests depend
 * on installation order.
 *
 * New in Milestone 11 Task 2, because the blog stopped being mock-backed. Until then
 * `features/content/api` read `src/mocks/posts.ts` directly and no HTTP was involved, so the blog
 * route tests passed without any stub at all — which is exactly why they never noticed that the
 * storefront and the admin console were reading two different sources.
 *
 * Four behaviours it models deliberately, because each is one the client now has to get right:
 *
 * - **The lists answer summaries, not posts.** No `body`. A stub that returned the full article
 *   would let a list card read `post.body` and still pass here while rendering `undefined` against
 *   the real server.
 * - **`readingMinutes` is on the summary**, derived from the body the same way
 *   `blog-post.mapper.ts` derives it: 200 words a minute, rounded **up**, floored at one. The list
 *   cards and the related rail both print it.
 * - **`?category` is validated, not filtered loosely.** `PostQueryDto` is `@IsIn(BLOG_CATEGORIES)`,
 *   so an unknown value is a **400**. `contentApi.listPosts` must therefore omit the parameter for
 *   its `"all"` sentinel rather than pass it through, and this stub is what pins that: sending
 *   `?category=all` fails the test instead of quietly listing everything.
 * - **An unknown slug is a 404 on both the detail and the related route.** The server 404s the
 *   related read rather than answering `[]`, deliberately — `ContentService` explains that an empty
 *   array for a draft slug would confirm the draft exists to whoever guessed it.
 *
 * What it does **not** model is ordering by anything but the server's rule, `publishedAt DESC` with
 * `slug ASC` as the tiebreak. The fixture's dates are distinct, so the tiebreak never fires here;
 * it is written out anyway so a future fixture with two posts sharing a date does not silently
 * depend on array order.
 */

/** 200 words a minute, rounded up, floored at one — `blog-post.mapper.ts`'s rule exactly. */
const readingMinutes = (body: string): number =>
  Math.max(1, Math.ceil(body.trim().split(/\s+/u).filter(Boolean).length / 200));

const byNewest = (a: PostFixture, b: PostFixture): number =>
  b.publishedAt.localeCompare(a.publishedAt) || a.slug.localeCompare(b.slug);

const toSummary = (post: PostFixture): BlogPostSummary => ({
  slug: post.slug,
  title: post.title,
  category: post.category,
  excerpt: post.excerpt,
  image: post.image,
  author: post.author,
  publishedAt: post.publishedAt,
  readingMinutes: readingMinutes(post.body),
});

const toPost = (post: PostFixture): BlogPost => ({
  ...toSummary(post),
  body: post.body,
  // `blog_posts.seo` defaults to `{}`, and the wire shape declares all three as required strings so
  // a consumer rendering a `<meta>` tag gets `''` rather than a branch.
  seo: { title: "", description: "", ogImage: "" },
});

/** How many `/content/posts/:slug/related` carries — `RELATED_LIMIT` in `content.service.ts`. */
const RELATED_LIMIT = 3;

export function resetContentStub(): void {
  // Nothing to reset: the fixture is read-only and no blog route writes. Exported anyway so
  // `installAuthStub` can treat every stub identically, and so this file has somewhere obvious to
  // put arranged failures when a test needs one.
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ok = <T>(data: T): Response => json(200, { success: true, data });

function refused(message: string, status: number, path: string, method: string): Response {
  return json(status, {
    success: false,
    statusCode: status,
    timestamp: "2026-08-20T00:00:00.000Z",
    path,
    method,
    message,
    code: status === 404 ? "NOT_FOUND" : "VALIDATION_FAILED",
    errorId: "stub-error-id",
    requestId: "stub-request-id",
  });
}

/**
 * Answers a content request, or returns `undefined` when the URL is not one of them so the caller
 * can fall through to its own handling.
 */
export function handleContentRequest(url: string, method: string): Response | undefined {
  const rest = url.startsWith("/api/v1") ? url.slice("/api/v1".length) : url;
  const [path, query] = rest.split("?");
  if (!path.startsWith("/content/posts") || method !== "GET") return undefined;

  const category = new URLSearchParams(query ?? "").get("category");

  if (path === "/content/posts") {
    if (category !== null && !(BLOG_CATEGORIES as readonly string[]).includes(category)) {
      return refused("Validation failed", 400, url, method);
    }
    const matching = category === null ? posts : posts.filter((p) => p.category === category);
    return ok([...matching].sort(byNewest).map(toSummary));
  }

  const segments = path.slice("/content/posts/".length).split("/");
  const slug = decodeURIComponent(segments[0] ?? "");
  const found = posts.find((p) => p.slug === slug);

  if (segments.length === 1) {
    return found
      ? ok(toPost(found))
      : refused("That post may have been renamed or taken down.", 404, url, method);
  }

  if (segments[1] === "related") {
    if (!found) {
      return refused("That post may have been renamed or taken down.", 404, url, method);
    }
    // Same category first, topped up with the next newest, matching `ContentService.related`.
    const others = posts.filter((p) => p.slug !== slug);
    const sameCategory = others.filter((p) => p.category === found.category).sort(byNewest);
    const rest_ = others.filter((p) => p.category !== found.category).sort(byNewest);
    return ok([...sameCategory, ...rest_].slice(0, RELATED_LIMIT).map(toSummary));
  }

  return undefined;
}
