import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { AdminBlogPost, BlogPost, BlogPostSummary, Paginated } from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedContent } from '../../src/database/seeds/content.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { UserRole } from '../../src/entities/enums';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';
import { agent, expectError, expectSuccess, useIntegrationApp } from './helpers';

const ADMIN_POSTS = '/api/v1/admin/posts';
const PUBLIC_POSTS = '/api/v1/content/posts';
const LOGIN = '/api/v1/auth/login';
const CSRF_HEADER = 'X-CSRF-Token';

interface AuditRow {
  action: string;
  entity: string;
  entityId: string;
  actor_user_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * `/admin/posts` and the public `/content/posts` — spec §6.4 and §6.1, brief §28 and §39.
 * Plan 9.4 Task 3.
 *
 * **The public routes are new here too.** Spec §6.1 lists three of them and no `content` controller
 * had ever existed, so `blog_posts` carried eight seeded posts that nothing could read. The plan
 * required this task to assert a draft appears in the admin list and *not* in "the public list";
 * there was none, so both halves ship together. That is the second §6.1 gap this plan turned up,
 * beside `GET /settings`.
 */
describe('blog posts', () => {
  const integration = useIntegrationApp();

  beforeEach(() => {
    const throttler = integration.app.get<ThrottlerStorageService>(ThrottlerStorage);
    throttler.onApplicationShutdown();
    throttler.storage.clear();
  });

  beforeEach(async () => {
    await seedSettings(integration.dataSource);
    await seedCatalog(integration.dataSource);
    await seedContent(integration.dataSource);
  });

  const signIn = async (role: UserRole) => {
    const user = await createTestUser(integration.dataSource, { role });
    const client = agent(integration.app);
    const login = await client
      .post(LOGIN)
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(200);
    return { client, user, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  };

  const asAdmin = () => signIn(UserRole.ADMIN);
  type Admin = Awaited<ReturnType<typeof asAdmin>>;

  const BODY = {
    slug: 'storing-kaju-in-summer',
    title: 'Storing Kaju in Summer',
    category: 'Storage Tips',
    excerpt: 'Warm cupboards are what turn good cashews rancid, not time.',
    image: 'https://images.example.com/kaju-storage.jpg',
    author: 'Nuts & Nazaakat',
    body: 'Cashews carry more oil than almonds do, so they go off faster in the heat. '.repeat(4),
  };

  const create = async (admin: Admin, overrides: Record<string, unknown> = {}, status = 201) =>
    admin.client
      .post(ADMIN_POSTS)
      .set(CSRF_HEADER, admin.csrf)
      .send({ ...BODY, ...overrides })
      .expect(status);

  const created = async (admin: Admin, overrides: Record<string, unknown> = {}) =>
    expectSuccess<AdminBlogPost>(await create(admin, overrides));

  const patch = async (admin: Admin, slug: string, body: Record<string, unknown>, status = 200) =>
    admin.client
      .patch(`${ADMIN_POSTS}/${slug}`)
      .set(CSRF_HEADER, admin.csrf)
      .send(body)
      .expect(status);

  const publicList = async (query = ''): Promise<BlogPostSummary[]> =>
    expectSuccess<BlogPostSummary[]>(
      await agent(integration.app).get(`${PUBLIC_POSTS}${query}`).expect(200),
    );

  const auditRows = async (entityId: string): Promise<AuditRow[]> =>
    integration.dataSource.query<AuditRow[]>(
      `SELECT action, entity, "entityId", actor_user_id, before, after FROM audit_logs
        WHERE "entityId" = $1 ORDER BY "createdAt", action`,
      [entityId],
    );

  describe('GET /content/posts — the public list spec §6.1 asked for', () => {
    it('lists the eight seeded posts, newest first, to an anonymous visitor', async () => {
      const posts = await publicList();

      expect(posts).toHaveLength(8);
      const dates = posts.map((post) => post.publishedAt);
      expect([...dates].sort().reverse()).toEqual(dates);
      // No body on a summary: eight posts must not be eight articles.
      expect(posts[0]).not.toHaveProperty('body');
    });

    it('filters by category, and refuses one outside brief §28’s six', async () => {
      const guides = await publicList('?category=Buying%20Guides');
      expect(guides.length).toBeGreaterThan(0);
      expect(guides.every((post) => post.category === 'Buying Guides')).toBe(true);

      await agent(integration.app).get(`${PUBLIC_POSTS}?category=Gossip`).expect(400);
    });

    it('serves one post with its body, a derived reading time and its SEO block', async () => {
      const post = expectSuccess<BlogPost>(
        await agent(integration.app)
          .get(`${PUBLIC_POSTS}/how-to-choose-the-right-almonds`)
          .expect(200),
      );

      expect(post.slug).toBe('how-to-choose-the-right-almonds');
      expect(post.body.length).toBeGreaterThan(100);
      // Derived from the body, never stored — `blog-post.entity.ts` says so.
      expect(post.readingMinutes).toBeGreaterThanOrEqual(1);
      // The seed writes `{}`; the wire fills all three fields so a consumer needs no branch.
      expect(post.seo).toEqual({ title: '', description: '', ogImage: '' });
    });

    it('offers related posts from the same category, excluding the post itself', async () => {
      const related = expectSuccess<BlogPostSummary[]>(
        await agent(integration.app)
          .get(`${PUBLIC_POSTS}/how-to-choose-the-right-almonds/related`)
          .expect(200),
      );

      expect(related.length).toBeLessThanOrEqual(3);
      expect(related.map((post) => post.slug)).not.toContain('how-to-choose-the-right-almonds');
      expect(related.every((post) => post.category === 'Buying Guides')).toBe(true);
    });

    it('404s for a slug that does not exist', async () => {
      await agent(integration.app).get(`${PUBLIC_POSTS}/no-such-post`).expect(404);
      await agent(integration.app).get(`${PUBLIC_POSTS}/no-such-post/related`).expect(404);
    });
  });

  describe('GET /admin/posts', () => {
    /**
     * The test the plan asks for, and the same one plan 9.1 wrote for products: a draft is visible
     * to an editor and invisible to everyone else.
     */
    it('includes an unpublished post the public list omits', async () => {
      const admin = await asAdmin();
      await created(admin);

      const adminList = expectSuccess<Paginated<AdminBlogPost>>(
        await admin.client.get(ADMIN_POSTS).expect(200),
      );
      expect(adminList.items.map((post) => post.slug)).toContain(BODY.slug);
      expect(adminList.total).toBe(9);

      const visitorList = await publicList();
      expect(visitorList.map((post) => post.slug)).not.toContain(BODY.slug);
      expect(visitorList).toHaveLength(8);

      // And the draft's own URL is a 404, not an empty page.
      await agent(integration.app).get(`${PUBLIC_POSTS}/${BODY.slug}`).expect(404);
      await agent(integration.app).get(`${PUBLIC_POSTS}/${BODY.slug}/related`).expect(404);
    });

    it('filters by publication state and category', async () => {
      const admin = await asAdmin();
      await created(admin);

      const drafts = expectSuccess<Paginated<AdminBlogPost>>(
        await admin.client.get(`${ADMIN_POSTS}?isPublished=false`).expect(200),
      );
      expect(drafts.items.map((post) => post.slug)).toEqual([BODY.slug]);

      const live = expectSuccess<Paginated<AdminBlogPost>>(
        await admin.client.get(`${ADMIN_POSTS}?isPublished=true`).expect(200),
      );
      expect(live.total).toBe(8);

      const storage = expectSuccess<Paginated<AdminBlogPost>>(
        await admin.client.get(`${ADMIN_POSTS}?category=Storage%20Tips`).expect(200),
      );
      expect(storage.items.every((post) => post.category === 'Storage Tips')).toBe(true);
    });

    it('refuses a customer and an anonymous caller', async () => {
      const customer = await signIn(UserRole.CUSTOMER);
      await customer.client.get(ADMIN_POSTS).expect(403);
      await agent(integration.app).get(ADMIN_POSTS).expect(401);
    });
  });

  describe('POST /admin/posts', () => {
    it('creates a draft by default and audits it', async () => {
      const admin = await asAdmin();

      const post = await created(admin);
      expect(post.isPublished).toBe(false);
      expect(post.publishedAt).toBeNull();
      expect(post.seo).toEqual({ title: '', description: '', ogImage: '' });

      const rows = await auditRows(BODY.slug);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('post.create');
      expect(rows[0]?.entity).toBe('post');
      expect(rows[0]?.actor_user_id).toBe(admin.user.id);
      // The body's length, not the body: a trail must not be larger than the table it describes.
      expect(rows[0]?.after).toMatchObject({ slug: BODY.slug, isPublished: false });
      expect(rows[0]?.after).toHaveProperty('bodyLength');
      expect(rows[0]?.after).not.toHaveProperty('body');
    });

    it('stamps publishedAt when created already published, and shows it publicly', async () => {
      const admin = await asAdmin();

      const post = await created(admin, {
        isPublished: true,
        seo: { title: 'Storing Kaju', description: 'Keep it cool.' },
      });
      expect(post.publishedAt).not.toBeNull();
      expect(post.seo).toEqual({
        title: 'Storing Kaju',
        description: 'Keep it cool.',
        ogImage: '',
      });

      expect((await publicList()).map((entry) => entry.slug)).toContain(BODY.slug);
    });

    it('takes brief §39’s SEO fields and refuses a category outside brief §28’s six', async () => {
      const admin = await asAdmin();
      await create(admin, { category: 'Hot Takes' }, 400);
      await create(admin, { slug: 'Not A Slug' }, 400);
    });

    it('refuses a duplicate slug with a named 409', async () => {
      const admin = await asAdmin();
      const body = expectError(
        await create(admin, { slug: 'how-to-choose-the-right-almonds' }, 409),
      );
      expect(body.code).toBe('IDENTIFIER_IN_USE');
      expect(body.details).toMatchObject({ field: 'slug' });
    });
  });

  describe('PATCH /admin/posts/:slug', () => {
    it('publishes a draft, stamping publishedAt once and never rewriting it', async () => {
      const admin = await asAdmin();
      await created(admin);

      const published = expectSuccess<AdminBlogPost>(
        await patch(admin, BODY.slug, { isPublished: true }),
      );
      expect(published.publishedAt).not.toBeNull();

      await patch(admin, BODY.slug, { isPublished: false });
      const republished = expectSuccess<AdminBlogPost>(
        await patch(admin, BODY.slug, { isPublished: true }),
      );

      // An unpublish/republish cycle is not a new post.
      expect(republished.publishedAt).toBe(published.publishedAt);
    });

    /**
     * **The judgment call, asserted.** A published post's slug may change, consistent with
     * `AdminProductsService.update`, which lets a published product's slug change today. The cost
     * is that the old URL 404s — there is no redirect table, and inventing one is a migration this
     * plan has no mandate for.
     */
    it('lets a published post’s slug change, and the old URL then 404s', async () => {
      const admin = await asAdmin();
      await created(admin, { isPublished: true });
      await agent(integration.app).get(`${PUBLIC_POSTS}/${BODY.slug}`).expect(200);

      const renamed = expectSuccess<AdminBlogPost>(
        await patch(admin, BODY.slug, { slug: 'storing-cashews-in-summer' }),
      );
      expect(renamed.slug).toBe('storing-cashews-in-summer');

      await agent(integration.app).get(`${PUBLIC_POSTS}/storing-cashews-in-summer`).expect(200);
      await agent(integration.app).get(`${PUBLIC_POSTS}/${BODY.slug}`).expect(404);

      /**
       * The rename is filed under the **new** slug, with `before.slug` as the only pointer back —
       * so one post's history stays in one place rather than scattering across every name it has
       * held. That pair is the whole reason a mutable identifier is auditable at all.
       */
      expect(await auditRows(BODY.slug)).toHaveLength(1);
      const after = await auditRows('storing-cashews-in-summer');
      expect(after.map((row) => row.action)).toEqual(['post.update']);
      expect(after[0]?.before).toMatchObject({ slug: BODY.slug });
      expect(after[0]?.after).toMatchObject({ slug: 'storing-cashews-in-summer' });
    });

    it('refuses a slug already taken by another post', async () => {
      const admin = await asAdmin();
      await created(admin);
      await patch(admin, BODY.slug, { slug: 'how-to-choose-the-right-almonds' }, 409);
      // Resending the post's own slug is not a conflict.
      await patch(admin, BODY.slug, { slug: BODY.slug });
    });

    /** Plan 9.1's rule: a write that changes nothing leaves no trace. */
    it('writes no audit row when nothing changes', async () => {
      const admin = await asAdmin();
      await created(admin);

      await patch(admin, BODY.slug, { title: BODY.title });

      expect((await auditRows(BODY.slug)).map((row) => row.action)).toEqual(['post.create']);
    });

    /**
     * A **valid** body, deliberately: the global `ValidationPipe` runs before the handler, so a
     * body that failed validation would answer 400 and this test would pass without ever reaching
     * the lookup it exists to check.
     */
    it('404s for a post that does not exist', async () => {
      const admin = await asAdmin();
      await patch(admin, 'no-such-post', { title: 'A Title' }, 404);
    });
  });

  describe('DELETE /admin/posts/:slug', () => {
    it('deletes a post, audits the whole row, and takes it off the public list', async () => {
      const admin = await asAdmin();
      await created(admin, { isPublished: true });
      expect((await publicList()).map((post) => post.slug)).toContain(BODY.slug);

      await admin.client
        .delete(`${ADMIN_POSTS}/${BODY.slug}`)
        .set(CSRF_HEADER, admin.csrf)
        .expect(204);

      expect((await publicList()).map((post) => post.slug)).not.toContain(BODY.slug);

      const rows = await auditRows(BODY.slug);
      expect(rows.map((row) => row.action)).toEqual(['post.create', 'post.delete']);
      expect(rows[1]?.after).toBeNull();
      expect(rows[1]?.before).toMatchObject({ slug: BODY.slug, title: BODY.title });
    });

    it('404s for a post that does not exist', async () => {
      const admin = await asAdmin();
      await admin.client
        .delete(`${ADMIN_POSTS}/no-such-post`)
        .set(CSRF_HEADER, admin.csrf)
        .expect(404);
    });

    it('refuses a customer', async () => {
      const customer = await signIn(UserRole.CUSTOMER);
      await customer.client
        .delete(`${ADMIN_POSTS}/how-to-choose-the-right-almonds`)
        .set(CSRF_HEADER, customer.csrf)
        .expect(403);
    });
  });
});
