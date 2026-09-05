import type { AdminBlogPost, BlogPost, BlogPostSummary } from '@nutwala/shared';
import type { BlogPost as BlogPostEntity } from '../../../entities/content/blog-post.entity';

/**
 * Words a reader gets through in a minute. The conventional figure for prose, and the only number
 * in this calculation that is a choice rather than arithmetic.
 */
const WORDS_PER_MINUTE = 200;

/**
 * Brief §28's reading estimate, derived from the body at read time.
 *
 * `blog-post.entity.ts` and `blog-posts.data.ts` both say a stored value was rejected — "a stored
 * value could disagree with the text beside it" — so this is the only place it exists. Rounded
 * **up**, and floored at one: a 40-word post that rounded to "0 min read" would read as an error,
 * and the estimate erring long is the kinder direction for a reader deciding whether to start.
 *
 * `split(/\s+/)` on a trimmed string, filtered, rather than `split(' ')`: the seeded bodies are
 * multi-paragraph text separated by newlines, and splitting on a literal space alone counts a
 * paragraph break as part of a word.
 */
export function readingMinutes(body: string): number {
  const words = body.trim().split(/\s+/u).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

/**
 * The SEO block with every field present.
 *
 * `blog_posts.seo` is a `jsonb` column defaulting to `{}` and typed with three optional fields, so
 * a post an editor never filled in has no keys at all. The wire shapes declare all three as
 * required strings, because a consumer rendering a `<meta>` tag wants `''` rather than a branch —
 * and because `AdminCategory.seo` already made the same choice for the same column shape.
 */
function seo(post: BlogPostEntity): { title: string; description: string; ogImage: string } {
  return {
    title: post.seo.title ?? '',
    description: post.seo.description ?? '',
    ogImage: post.seo.ogImage ?? '',
  };
}

/**
 * The six fields every blog shape carries, public and admin alike.
 *
 * Named rather than obtained by destructuring `publishedAt` off a summary, which is the shape this
 * would otherwise take: `const { publishedAt: _ignored, ...rest }` is a discard the linter reports
 * as an unused variable, and silencing that would need the `eslint-disable` this codebase does not
 * allow. The `Omit` is the same set stated positively, so the two mappers below share one definition
 * and a field added to either wire shape is a compile error here.
 *
 * `readingMinutes` is omitted alongside `publishedAt` because the two shapes answer it differently
 * for the same reason: the public summary derives it from the body, and `AdminBlogPost` does not
 * carry it at all.
 */
function common(
  post: BlogPostEntity,
): Omit<BlogPostSummary, 'publishedAt' | 'readingMinutes'> {
  return {
    slug: post.slug,
    title: post.title,
    category: post.category,
    excerpt: post.excerpt,
    image: post.image,
    author: post.author,
  };
}

/**
 * `BlogPost` to `BlogPostSummary` — the public list.
 *
 * **`publishedAt!` is not asserted, it is checked.** The column is nullable and the wire type is
 * not, which is only sound because the public queries filter `isPublished = true`; rather than
 * trust that from here, an unpublished post falling through carries an empty string, which is
 * visibly wrong rather than a crash in a consumer expecting a date. The list query is what actually
 * guarantees it, and `ContentService` says so.
 */
export function toBlogPostSummary(post: BlogPostEntity): BlogPostSummary {
  return {
    ...common(post),
    publishedAt: post.publishedAt?.toISOString() ?? '',
    readingMinutes: readingMinutes(post.body),
  };
}

/**
 * `BlogPost` to the public detail shape — the summary plus the article and its SEO block.
 *
 * `readingMinutes` is no longer set here: it arrives with the summary spread, from the same
 * `readingMinutes(post.body)` call, so setting it twice would be two chances to disagree.
 */
export function toBlogPost(post: BlogPostEntity): BlogPost {
  return {
    ...toBlogPostSummary(post),
    body: post.body,
    seo: seo(post),
  };
}

/**
 * `BlogPost` to `AdminBlogPost` — every field, drafts included.
 *
 * Shares `common` with the public summary, and then answers `publishedAt` differently: **null**,
 * because here a post that has never gone live is a case the query includes rather than one it
 * excludes. That single field is why `AdminBlogPost` extends `Omit<BlogPostSummary,
 * 'publishedAt'>` rather than `BlogPostSummary` outright.
 */
export function toAdminBlogPost(post: BlogPostEntity): AdminBlogPost {
  return {
    ...common(post),
    body: post.body,
    isPublished: post.isPublished,
    publishedAt: post.publishedAt?.toISOString() ?? null,
    seo: seo(post),
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}
