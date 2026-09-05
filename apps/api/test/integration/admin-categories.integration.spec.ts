import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { AdminCategory, Category, Paginated, Product } from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { UserRole } from '../../src/entities/enums';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';
import { agent, expectError, expectSuccess, useIntegrationApp } from './helpers';

const ADMIN_CATEGORIES = '/api/v1/admin/categories';
const CATALOG_CATEGORIES = '/api/v1/catalog/categories';
const CATALOG_PRODUCTS = '/api/v1/catalog/products';
const LOGIN = '/api/v1/auth/login';
const CSRF_HEADER = 'X-CSRF-Token';
const NO_SUCH_ID = '00000000-0000-4000-8000-000000000000';

interface AuditRow {
  action: string;
  entity: string;
  actor_user_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * `/admin/categories` — spec §6.4, brief §7. Plan 9.1 Task 8.
 *
 * **Three verbs, and no delete.** §6.4 lists `GET`, `POST` and `PATCH` for this resource and nothing
 * else, so none was added — see `AdminCategoriesService`'s docblock for why that is also right on the
 * data (`products.category_id` is `ON DELETE RESTRICT`, and every seeded category holds products).
 * The absence is asserted below rather than merely intended, because a route nobody declared and a
 * route somebody deleted look identical from the outside.
 */
describe('admin categories', () => {
  const integration = useIntegrationApp();

  beforeEach(() => {
    const throttler = integration.app.get<ThrottlerStorageService>(ThrottlerStorage);
    throttler.onApplicationShutdown();
    throttler.storage.clear();
  });

  beforeEach(async () => {
    await seedSettings(integration.dataSource);
    await seedCatalog(integration.dataSource);
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

  const categoryId = async (slug: string): Promise<string> => {
    const rows = await integration.dataSource.query<{ id: string }[]>(
      'SELECT id FROM categories WHERE slug = $1',
      [slug],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`seedCatalog wrote no ${slug} category`);
    return id;
  };

  const auditRows = async (entityId: string): Promise<AuditRow[]> =>
    integration.dataSource.query<AuditRow[]>(
      `SELECT action, entity, actor_user_id, before, after FROM audit_logs
        WHERE "entityId" = $1 ORDER BY "createdAt", action`,
      [entityId],
    );

  const BODY = {
    slug: 'nut-butters',
    name: 'Nut Butters',
    image: 'https://images.example.com/nut-butters.jpg',
    blurb: 'Stone-ground, nothing added',
    description: 'Stone-ground nut butters with no palm oil and no added sugar.',
  };

  const create = async (admin: Admin, overrides: Record<string, unknown> = {}) =>
    expectSuccess<AdminCategory>(
      await admin.client
        .post(ADMIN_CATEGORIES)
        .set(CSRF_HEADER, admin.csrf)
        .send({ ...BODY, ...overrides })
        .expect(201),
    );

  describe('GET /admin/categories', () => {
    it('lists brief §7’s twelve in display order, unpaginated', async () => {
      const admin = await asAdmin();

      const categories = expectSuccess<AdminCategory[]>(
        await admin.client.get(ADMIN_CATEGORIES).expect(200),
      );

      expect(categories).toHaveLength(12);
      expect(categories[0]?.slug).toBe('almonds');
      expect(categories.map((category) => category.sortOrder)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);
    });

    /** The admin counterpart of the products list: drafts are visible here and nowhere else. */
    it('includes an unpublished category the public list omits', async () => {
      const admin = await asAdmin();
      await create(admin, { isPublished: false });

      const adminList = expectSuccess<AdminCategory[]>(
        await admin.client.get(ADMIN_CATEGORIES).expect(200),
      );
      expect(adminList.map((category) => category.slug)).toContain('nut-butters');

      const publicList = expectSuccess<Category[]>(
        await agent(integration.app).get(CATALOG_CATEGORIES).expect(200),
      );
      expect(publicList.map((category) => category.slug)).not.toContain('nut-butters');
      await agent(integration.app).get(`${CATALOG_CATEGORIES}/nut-butters`).expect(404);
    });
  });

  describe('POST /admin/categories', () => {
    it('creates a category, published by default, and records who created it', async () => {
      const admin = await asAdmin();
      const created = await create(admin);

      expect(created).toMatchObject({
        slug: 'nut-butters',
        name: 'Nut Butters',
        // Defaults to true, unlike a product: §6.4 gives a category no publish/unpublish pair, so
        // this field is its only route to either state.
        isPublished: true,
        sortOrder: 0,
        seo: { title: '', description: '', ogImage: '' },
      });

      const publicList = expectSuccess<Category[]>(
        await agent(integration.app).get(CATALOG_CATEGORIES).expect(200),
      );
      expect(publicList.map((category) => category.slug)).toContain('nut-butters');

      const rows = await auditRows(created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'category.create',
        entity: 'category',
        actor_user_id: admin.user.id,
        before: null,
      });
      expect(rows[0]?.after).toMatchObject({ slug: 'nut-butters', isPublished: true });
    });

    it('refuses a slug another category already uses', async () => {
      const admin = await asAdmin();

      const response = await admin.client
        .post(ADMIN_CATEGORIES)
        .set(CSRF_HEADER, admin.csrf)
        .send({ ...BODY, slug: 'almonds' })
        .expect(409);

      const error = expectError(response);
      expect(error.code).toBe('IDENTIFIER_IN_USE');
      expect(error.details).toEqual({ field: 'slug', value: 'almonds' });
    });

    /** A new category is immediately usable as a product's `categoryId`. */
    it('can be used as the category of a new product straight away', async () => {
      const admin = await asAdmin();
      const created = await create(admin);

      await admin.client
        .post('/api/v1/admin/products')
        .set(CSRF_HEADER, admin.csrf)
        .send({
          name: 'Stone-Ground Almond Butter',
          slug: 'stone-ground-almond-butter',
          categoryId: created.id,
          subtitle: 'One ingredient. Nothing else.',
          description: 'Stone-ground roasted almonds.',
          origin: 'California, USA',
          grade: 'Premium',
          processing: 'Stone ground',
          shelfLife: '6 months from packing',
          storage: 'Refrigerate after opening.',
          ingredients: 'Almonds',
          hsn: '2008',
          gstRate: 12,
        })
        .expect(201);
    });
  });

  describe('PATCH /admin/categories/:id', () => {
    it('changes only what was sent and audits only what changed', async () => {
      const admin = await asAdmin();
      const id = await categoryId('makhana');

      const updated = expectSuccess<AdminCategory>(
        await admin.client
          .patch(`${ADMIN_CATEGORIES}/${id}`)
          .set(CSRF_HEADER, admin.csrf)
          .send({ blurb: 'Roasted fox nuts, Bihar grown', sortOrder: 2 })
          .expect(200),
      );

      expect(updated.blurb).toBe('Roasted fox nuts, Bihar grown');
      expect(updated.sortOrder).toBe(2);
      expect(updated.name).toBe('Makhana');

      const rows = await auditRows(id);
      expect(rows.map((row) => row.action)).toEqual(['category.update']);
      expect(rows[0]?.before).toEqual({ blurb: 'Roasted fox nuts', sortOrder: 7 });
      expect(rows[0]?.after).toEqual({
        blurb: 'Roasted fox nuts, Bihar grown',
        sortOrder: 2,
      });
    });

    it('writes no audit row for a patch that changes nothing', async () => {
      const admin = await asAdmin();
      const id = await categoryId('makhana');

      await admin.client
        .patch(`${ADMIN_CATEGORIES}/${id}`)
        .set(CSRF_HEADER, admin.csrf)
        .send({ name: 'Makhana' })
        .expect(200);

      expect(await auditRows(id)).toEqual([]);
    });

    /**
     * **Unpublishing a category hides the category, not its products** — measured rather than
     * assumed, and worth pinning because it is surprising. `CatalogService.baseQuery` filters
     * `product.isPublished`, never `category.isPublished`, so the eight almond products stay on
     * `/shop` and on their own pages while the almonds *tile* disappears from the categories rail.
     *
     * Not changed here: adding `category.isPublished = true` to the storefront's base query would
     * silently withdraw products through a field nobody expected to be a product filter, and the
     * operation an operator wants for that is unpublishing the products. Reported instead.
     */
    it('hides the category from the rail without withdrawing its products', async () => {
      const admin = await asAdmin();

      await admin.client
        .patch(`${ADMIN_CATEGORIES}/${await categoryId('almonds')}`)
        .set(CSRF_HEADER, admin.csrf)
        .send({ isPublished: false })
        .expect(200);

      const publicList = expectSuccess<Category[]>(
        await agent(integration.app).get(CATALOG_CATEGORIES).expect(200),
      );
      expect(publicList.map((category) => category.slug)).not.toContain('almonds');

      const products = expectSuccess<Paginated<Product>>(
        await agent(integration.app).get(`${CATALOG_PRODUCTS}?category=almonds`).expect(200),
      );
      expect(products.total).toBe(3);
      await agent(integration.app)
        .get(`${CATALOG_PRODUCTS}/premium-california-almonds`)
        .expect(200);
    });

    it('refuses a slug another category already uses, but accepts its own', async () => {
      const admin = await asAdmin();
      const id = await categoryId('makhana');

      await admin.client
        .patch(`${ADMIN_CATEGORIES}/${id}`)
        .set(CSRF_HEADER, admin.csrf)
        .send({ slug: 'almonds' })
        .expect(409);

      await admin.client
        .patch(`${ADMIN_CATEGORIES}/${id}`)
        .set(CSRF_HEADER, admin.csrf)
        .send({ slug: 'makhana' })
        .expect(200);

      expect(await auditRows(id)).toEqual([]);
    });

    it('answers 404 for an unknown id and 400 for one that is not a uuid', async () => {
      const admin = await asAdmin();

      await admin.client
        .patch(`${ADMIN_CATEGORIES}/${NO_SUCH_ID}`)
        .set(CSRF_HEADER, admin.csrf)
        .send({ name: 'Nope' })
        .expect(404);
      await admin.client
        .patch(`${ADMIN_CATEGORIES}/not-a-uuid`)
        .set(CSRF_HEADER, admin.csrf)
        .send({ name: 'Nope' })
        .expect(400);
    });
  });

  /**
   * The absence, asserted. Nest answers 404 for a path no handler matches, so this is what "spec
   * §6.4 lists no delete and none was added" looks like from outside — and it will fail loudly if
   * somebody adds one without revisiting the reasoning.
   */
  it('exposes no DELETE for a category', async () => {
    const admin = await asAdmin();

    await admin.client
      .delete(`${ADMIN_CATEGORIES}/${await categoryId('almonds')}`)
      .set(CSRF_HEADER, admin.csrf)
      .expect(404);
  });

  describe('authorisation', () => {
    it('refuses an anonymous caller with 401 and a customer with 403', async () => {
      await agent(integration.app).get(ADMIN_CATEGORIES).expect(401);

      const customer = await signIn(UserRole.CUSTOMER);
      await customer.client.get(ADMIN_CATEGORIES).expect(403);
      await customer.client
        .post(ADMIN_CATEGORIES)
        .set(CSRF_HEADER, customer.csrf)
        .send(BODY)
        .expect(403);
      await customer.client
        .patch(`${ADMIN_CATEGORIES}/${await categoryId('almonds')}`)
        .set(CSRF_HEADER, customer.csrf)
        .send({ name: 'Mine now' })
        .expect(403);
    });
  });
});
