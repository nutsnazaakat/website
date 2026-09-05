import type { BlogPost, BlogPostSummary } from '@nutwala/shared';
import { BlogPost as BlogPostEntity } from '../../src/entities/content/blog-post.entity';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedContent } from '../../src/database/seeds/content.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { seedUsers } from '../../src/database/seeds/users.seed';
import { expectError, expectSuccess, request, useIntegrationApp } from './helpers';

const BASE = '/api/v1/content';

/**
 * The public blog — spec §6.1's three `/content/posts` routes.
 *
 * **These routes had no integration coverage at all** until the storefront started reading them in
 * Milestone 11 Task 2. They had three controller unit tests and an `admin-posts` integration file
 * next door, which is how they stayed shipped-and-unconsumed since Milestone 3: nothing exercised
 * the actual HTTP contract, so nothing noticed that `features/content/api` was reading
 * `src/mocks/posts.ts` instead.
 *
 * `readingMinutes` on the *summary* is the assertion this file exists for most. It was absent from
 * `BlogPostSummary` until that task, and the storefront's list cards and related rail both print
 * it — so the wiring would have rendered "undefined min read" twice over, and no test anywhere
 * would have failed.
 */
describe('content', () => {
  const integration = useIntegrationApp();

  beforeEach(async () => {
    await seedSettings(integration.dataSource);
    await seedUsers(integration.dataSource);
    // `seedContent` resolves product ids for its reviews, so the catalogue has to exist first.
    await seedCatalog(integration.dataSource);
    await seedContent(integration.dataSource);
  });

  /**
   * The reading-time rule, restated rather than imported from `blog-post.mapper.ts`.
   *
   * Importing `readingMinutes` would compare the implementation against itself — a helper changed to
   * 400 words a minute would move the mapper *and* this expectation together, and the assertion
   * could not fail. `catalog.integration.spec.ts` records the same reasoning about `variantSoldOut`.
   *
   * The rule: 200 words a minute, rounded **up**, floored at one.
   */
  const expectedMinutes = (body: string): number =>
    Math.max(1, Math.ceil(body.trim().split(/\s+/u).filter(Boolean).length / 200));

  /** A draft, for the `isPublished` filter — every seeded post is published, so one has to be made. */
  const insertDraft = async (slug: string, category = 'Recipes'): Promise<void> => {
    await integration.dataSource.getRepository(BlogPostEntity).insert({
      slug,
      title: 'A draft nobody outside the console may see',
      category,
      excerpt: 'Unpublished.',
      image: 'https://placehold.co/800x600',
      author: 'Nuts & Nazaakat',
      body: 'A short unpublished body.',
      isPublished: false,
      publishedAt: null,
      seo: {},
    });
  };

  describe('GET /posts', () => {
    it('is public — the journal must render for a visitor with no session', async () => {
      const response = await request(integration.app).get(`${BASE}/posts`).expect(200);
      expect(expectSuccess<BlogPostSummary[]>(response)).toHaveLength(8);
    });

    it('orders newest first', async () => {
      const posts = expectSuccess<BlogPostSummary[]>(
        await request(integration.app).get(`${BASE}/posts`).expect(200),
      );

      expect(posts[0]?.slug).toBe('makhana-chaat-in-ten-minutes');
      expect(posts.at(-1)?.slug).toBe('soaked-vs-raw-almonds');

      const dates = posts.map((post) => post.publishedAt);
      expect([...dates].sort((a, b) => b.localeCompare(a))).toEqual(dates);
    });

    /**
     * The summary's two halves, and both matter to a caller.
     *
     * No `body`: a listing of eight posts must not be eight full articles, and a client that could
     * read `post.body` off a list item would work here and render nothing against a paginated
     * future. `readingMinutes` present: the storefront prints it on every card.
     */
    it('carries readingMinutes but not the body', async () => {
      const posts = expectSuccess<BlogPostSummary[]>(
        await request(integration.app).get(`${BASE}/posts`).expect(200),
      );

      for (const post of posts) {
        expect(post).not.toHaveProperty('body');
        expect(post.readingMinutes).toBeGreaterThan(0);
      }
    });

    it("agrees with the detail route's readingMinutes for the same post", async () => {
      const posts = expectSuccess<BlogPostSummary[]>(
        await request(integration.app).get(`${BASE}/posts`).expect(200),
      );
      const summary = posts.find((post) => post.slug === 'w320-vs-w240-cashews');

      const detail = expectSuccess<BlogPost>(
        await request(integration.app).get(`${BASE}/posts/w320-vs-w240-cashews`).expect(200),
      );

      expect(summary?.readingMinutes).toBe(detail.readingMinutes);
      // And against the rule itself, not merely against the other route.
      expect(detail.readingMinutes).toBe(expectedMinutes(detail.body));
    });

    it('filters by category', async () => {
      const posts = expectSuccess<BlogPostSummary[]>(
        await request(integration.app).get(`${BASE}/posts?category=Storage%20Tips`).expect(200),
      );

      expect(posts).toHaveLength(1);
      expect(posts[0]?.slug).toBe('how-to-store-dry-fruits-at-home');
    });

    /**
     * **A 400, not an empty list**, and the storefront depends on the difference.
     *
     * `PostQueryDto` is `@IsIn(BLOG_CATEGORIES)`. The client's `listPosts` carries an `"all"`
     * sentinel for its unfiltered view, so it must *omit* the parameter rather than pass the
     * sentinel through — `?category=all` would be this 400 on every visit to `/blog`.
     */
    it('refuses a category outside BLOG_CATEGORIES rather than listing nothing', async () => {
      const response = await request(integration.app).get(`${BASE}/posts?category=all`).expect(400);
      expect(expectError(response).success).toBe(false);
    });

    it('omits an unpublished post', async () => {
      await insertDraft('a-draft-post');

      const posts = expectSuccess<BlogPostSummary[]>(
        await request(integration.app).get(`${BASE}/posts`).expect(200),
      );

      expect(posts).toHaveLength(8);
      expect(posts.some((post) => post.slug === 'a-draft-post')).toBe(false);
    });
  });

  describe('GET /posts/:slug', () => {
    it('carries the article, its reading time and the SEO block', async () => {
      const post = expectSuccess<BlogPost>(
        await request(integration.app)
          .get(`${BASE}/posts/how-to-choose-the-right-almonds`)
          .expect(200),
      );

      expect(post.title).toBe('How to Choose the Right Almonds');
      expect(post.category).toBe('Buying Guides');
      expect(post.body.length).toBeGreaterThan(0);
      expect(post.readingMinutes).toBe(expectedMinutes(post.body));
      /*
       * All three keys present as strings even though `blog_posts.seo` is `{}` for every seeded
       * post: the wire shape declares them required so a consumer rendering a `<meta>` tag gets
       * `''` rather than a branch.
       */
      expect(post.seo).toEqual({ title: '', description: '', ogImage: '' });
    });

    it('404s an unknown slug', async () => {
      await request(integration.app).get(`${BASE}/posts/no-such-post`).expect(404);
    });

    it('404s a draft rather than serving it to anyone who guessed the slug', async () => {
      await insertDraft('a-draft-post');
      await request(integration.app).get(`${BASE}/posts/a-draft-post`).expect(404);
    });
  });

  describe('GET /posts/:slug/related', () => {
    it('carries three posts and never the one asked for', async () => {
      const related = expectSuccess<BlogPostSummary[]>(
        await request(integration.app)
          .get(`${BASE}/posts/w320-vs-w240-cashews/related`)
          .expect(200),
      );

      expect(related).toHaveLength(3);
      expect(related.some((post) => post.slug === 'w320-vs-w240-cashews')).toBe(false);
    });

    /**
     * Same category first. `w320-vs-w240-cashews` is "Dry Fruit Guides", and exactly one other
     * seeded post shares it — so the first item is that post and the remaining two are the next
     * newest from elsewhere, which is what makes this assertion about ordering rather than about
     * set membership.
     */
    it('leads with the same category, then tops up with the newest', async () => {
      const related = expectSuccess<BlogPostSummary[]>(
        await request(integration.app)
          .get(`${BASE}/posts/w320-vs-w240-cashews/related`)
          .expect(200),
      );

      expect(related[0]?.slug).toBe('anjeer-dates-raisins-which-to-pick');
      expect(related[0]?.category).toBe('Dry Fruit Guides');
      expect(related.slice(1).every((post) => post.category !== 'Dry Fruit Guides')).toBe(true);
    });

    /**
     * The case the top-up exists for, and the one that was broken.
     *
     * `makhana-chaat-in-ten-minutes` is the only seeded post in "Recipes", so a same-category-only
     * query answers **zero** and the storefront's "Keep reading" rail vanishes — its guard is
     * `related !== undefined && related.length > 0`. Four of the eight seeded posts are in this
     * position. Measured against the previous implementation: this returned an empty array.
     */
    it('fills the rail for a post that is the only one in its category', async () => {
      const related = expectSuccess<BlogPostSummary[]>(
        await request(integration.app)
          .get(`${BASE}/posts/makhana-chaat-in-ten-minutes/related`)
          .expect(200),
      );

      expect(related).toHaveLength(3);
      expect(related.some((post) => post.slug === 'makhana-chaat-in-ten-minutes')).toBe(false);
      // Newest first among the top-ups, since none shares the category.
      expect(related[0]?.slug).toBe('how-to-choose-the-right-almonds');
    });

    it('never repeats a post', async () => {
      const related = expectSuccess<BlogPostSummary[]>(
        await request(integration.app)
          .get(`${BASE}/posts/w320-vs-w240-cashews/related`)
          .expect(200),
      );

      expect(new Set(related.map((post) => post.slug)).size).toBe(related.length);
    });

    it('carries readingMinutes, because the related rail prints it', async () => {
      const related = expectSuccess<BlogPostSummary[]>(
        await request(integration.app)
          .get(`${BASE}/posts/w320-vs-w240-cashews/related`)
          .expect(200),
      );

      for (const post of related) {
        expect(post.readingMinutes).toBeGreaterThan(0);
        expect(post).not.toHaveProperty('body');
      }
    });

    /**
     * **404, not `[]`.** `ContentService` records why: answering an empty array for a draft slug
     * would confirm the draft exists to whoever guessed it, which is the same leak from the other
     * side. The storefront copes — its rail is guarded by `related !== undefined && length > 0`.
     */
    it('404s an unknown slug and a draft alike', async () => {
      await insertDraft('a-draft-post');
      await request(integration.app).get(`${BASE}/posts/no-such-post/related`).expect(404);
      await request(integration.app).get(`${BASE}/posts/a-draft-post/related`).expect(404);
    });
  });
});
