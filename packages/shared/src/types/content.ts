// shared/src/types/content.ts

/**
 * The blog's public wire shapes — brief §28, spec §6.1's `/content/posts` routes.
 *
 * A file of its own rather than a corner of `catalog.ts`: a post is not a product, and the
 * storefront's content feature already reads its own seam (`features/content/api/`). `AdminBlogPost`
 * in `admin.ts` *extends* `BlogPostSummary` for the reason spec §7.1 gives about every other pair in
 * this package — the admin console must not redeclare a shape the storefront already has, because
 * "a second definition is how the two drift while both still compile".
 */

/**
 * One post in the public list — `GET /content/posts`, optionally filtered by `?category`.
 *
 * **No `body`, deliberately:** a listing of eight posts must not be eight full articles.
 *
 * `readingMinutes` **is** here, and the reason it was once excluded turned out not to hold. That
 * reason was "a summary carrying it would have to load the body it exists to avoid" — but
 * `ContentService.list` issues `this.posts.find({ where, order })` with no `select`, so TypeORM
 * loads the whole row and the mapper discards the body it already has. Deriving the figure costs no
 * extra I/O, and the storefront's list cards and related rail both print "N min read"
 * (`routes/blog/index.tsx`, `routes/blog/$slug.tsx`), so omitting it renders `undefined min read`.
 *
 * If the blog ever grows past a page's worth — this list is also unpaginated, see
 * `docs/known-issues.md` item 6 — the fix is a word count computed in SQL, **not** dropping the
 * field and the reading time with it.
 */
export interface BlogPostSummary {
  slug: string;
  title: string;
  /**
   * One of `BLOG_CATEGORIES`, but typed `string` **deliberately**, and it was tried the other way.
   *
   * Narrowing this to `BlogCategory` reads better and matches the write path — `SavePostDto.category`
   * is `@IsIn(BLOG_CATEGORIES)` — but `blog_posts.category` is a `varchar(40)` that does not
   * constrain the value, so `blog-post.mapper.ts` could only satisfy the narrower type with an
   * unsound cast at the database boundary. This file's neighbours reason the same way about
   * `publishedAt`: "not asserted, it is checked".
   *
   * Exactly one consumer needs the union — the storefront's post breadcrumb links back to the
   * filtered list, whose search is `z.enum(BLOG_CATEGORIES)` — and one guard there costs less than a
   * lie told to every consumer.
   */
  category: string;
  excerpt: string;
  image: string;
  author: string;
  /**
   * Whole minutes, derived from `body` at read time and never stored — see `BlogPost` below for why
   * a stored column would be worse. Present on the summary so a list card can print it without
   * fetching each article.
   */
  readingMinutes: number;
  /**
   * When it went live, ISO-8601.
   *
   * Never null here, unlike `AdminBlogPost.publishedAt`, and that difference is the whole point of
   * having two shapes: an unpublished post never appears in this list, so a public consumer never
   * has to decide what a null publication date means.
   */
  publishedAt: string;
}

/**
 * `GET /content/posts/:slug` — the summary plus the article itself.
 *
 * `readingMinutes` is inherited from `BlogPostSummary` rather than declared here.
 * `blog-post.entity.ts`'s docblock gives the reason it is derived and never stored —
 * "`readingMinutes` stays derived from the body, never stored" — because a column holding it could
 * disagree with the text printed beside it the moment an editor changed one and not the other.
 */
export interface BlogPost extends BlogPostSummary {
  body: string;
  /** Brief §39's SEO block. Empty strings where the editor has filled nothing in. */
  seo: { title: string; description: string; ogImage: string };
}
