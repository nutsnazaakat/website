import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { AdminReview, Paginated, Review, ReviewSummary } from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedContent } from '../../src/database/seeds/content.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { UserRole } from '../../src/entities/enums';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';
import { agent, expectError, expectStatus, expectSuccess, useIntegrationApp } from './helpers';

const ADMIN_REVIEWS = '/api/v1/admin/reviews';
const LOGIN = '/api/v1/auth/login';
const CSRF_HEADER = 'X-CSRF-Token';
const SLUG = 'w320-cashews';
const PUBLIC_REVIEWS = `/api/v1/catalog/products/${SLUG}/reviews`;
const NO_SUCH_ID = '00000000-0000-4000-8000-000000000000';

interface AuditRow {
  action: string;
  entity: string;
  entityId: string;
  actor_user_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * `/admin/reviews` — spec §6.4, brief §27. Plan 9.4 Task 2.
 *
 * The assertions that matter here go **through the public catalogue route**, not through the
 * column: "approving makes the review visible on the storefront and rejecting does not" is the
 * behaviour anyone cares about, and a test that read `reviews.status` back would pass just as
 * happily if `ReviewsService.listForProduct` had stopped filtering.
 */
describe('admin reviews', () => {
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

  /** A real pending review, written the way a customer writes one rather than inserted. */
  const submit = async (overrides: Record<string, unknown> = {}): Promise<Review> => {
    const customer = await signIn(UserRole.CUSTOMER);
    const response = await customer.client
      .post(PUBLIC_REVIEWS)
      .set(CSRF_HEADER, customer.csrf)
      .send({
        author: 'Asha R.',
        rating: 2,
        body: 'Smaller kernels than I expected.',
        ...overrides,
      });
    expectStatus(response, 201);
    return expectSuccess<Review>(response);
  };

  const publicReviews = async (): Promise<Review[]> =>
    expectSuccess<Review[]>(await agent(integration.app).get(PUBLIC_REVIEWS).expect(200));

  const publicSummary = async (): Promise<ReviewSummary> =>
    expectSuccess<ReviewSummary>(
      await agent(integration.app).get(`${PUBLIC_REVIEWS}/summary`).expect(200),
    );

  const productAggregates = async (): Promise<{ ratingAvg: string; reviewCount: number }> => {
    const rows = await integration.dataSource.query<{ ratingAvg: string; reviewCount: number }[]>(
      'SELECT "ratingAvg", "reviewCount" FROM products WHERE slug = $1',
      [SLUG],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`seedCatalog wrote no ${SLUG} product`);
    return row;
  };

  const auditRows = async (entityId: string): Promise<AuditRow[]> =>
    integration.dataSource.query<AuditRow[]>(
      `SELECT action, entity, "entityId", actor_user_id, before, after FROM audit_logs
        WHERE "entityId" = $1 ORDER BY "createdAt", action`,
      [entityId],
    );

  const approve = async (admin: Admin, id: string, status = 200) =>
    admin.client.post(`${ADMIN_REVIEWS}/${id}/approve`).set(CSRF_HEADER, admin.csrf).expect(status);

  const reject = async (
    admin: Admin,
    id: string,
    body: Record<string, unknown> = {},
    status = 200,
  ) =>
    admin.client
      .post(`${ADMIN_REVIEWS}/${id}/reject`)
      .set(CSRF_HEADER, admin.csrf)
      .send(body)
      .expect(status);

  describe('GET /admin/reviews', () => {
    /** `content.seed.ts` says so in its own docblock: all 14 fixtures are approved. */
    it('opens on the pending queue, which seeds empty', async () => {
      const admin = await asAdmin();

      const queue = expectSuccess<Paginated<AdminReview>>(
        await admin.client.get(ADMIN_REVIEWS).expect(200),
      );
      expect(queue.total).toBe(0);

      const approved = expectSuccess<Paginated<AdminReview>>(
        await admin.client.get(`${ADMIN_REVIEWS}?status=approved`).expect(200),
      );
      expect(approved.total).toBe(14);
    });

    it('shows a freshly submitted review, with the moderation trail still empty', async () => {
      const submitted = await submit();
      const admin = await asAdmin();

      const queue = expectSuccess<Paginated<AdminReview>>(
        await admin.client.get(ADMIN_REVIEWS).expect(200),
      );

      expect(queue.total).toBe(1);
      expect(queue.items[0]).toMatchObject({
        id: submitted.id,
        status: 'pending',
        productSlug: SLUG,
        rating: 2,
        moderatedByUserId: null,
        moderatedAt: null,
        rejectionReason: null,
      });
      // The badge is server-derived and this author has no delivered order.
      expect(queue.items[0]?.verifiedPurchase).toBe(false);
    });

    it('narrows to one product by its snapshot slug', async () => {
      await submit();
      const admin = await asAdmin();

      const mine = expectSuccess<Paginated<AdminReview>>(
        await admin.client.get(`${ADMIN_REVIEWS}?productSlug=${SLUG}`).expect(200),
      );
      expect(mine.total).toBe(1);

      const elsewhere = expectSuccess<Paginated<AdminReview>>(
        await admin.client.get(`${ADMIN_REVIEWS}?productSlug=mamra-almonds`).expect(200),
      );
      expect(elsewhere.total).toBe(0);
    });

    it('refuses a customer and an anonymous caller', async () => {
      const customer = await signIn(UserRole.CUSTOMER);
      await customer.client.get(ADMIN_REVIEWS).expect(403);
      await agent(integration.app).get(ADMIN_REVIEWS).expect(401);
    });
  });

  describe('POST /admin/reviews/:id/approve', () => {
    /** The assertion the plan asks for, made where it is meaningful: on the storefront. */
    it('puts the review on the product page and moves the public rating', async () => {
      const submitted = await submit();
      const admin = await asAdmin();

      const beforeList = await publicReviews();
      expect(beforeList.map((review) => review.id)).not.toContain(submitted.id);
      const beforeSummary = await publicSummary();
      expect(beforeSummary.total).toBe(5);

      const approved = expectSuccess<AdminReview>(await approve(admin, submitted.id));
      expect(approved.status).toBe('approved');
      expect(approved.moderatedByUserId).toBe(admin.user.id);
      expect(approved.moderatedAt).not.toBeNull();

      const afterList = await publicReviews();
      expect(afterList.map((review) => review.id)).toContain(submitted.id);

      const afterSummary = await publicSummary();
      expect(afterSummary.total).toBe(6);
      // The two-star review pulls the average down; the denormalised column follows it.
      expect(afterSummary.average).toBeLessThan(beforeSummary.average);

      const aggregates = await productAggregates();
      expect(aggregates.reviewCount).toBe(6);
    });

    it('audits the approval inside the same transaction', async () => {
      const submitted = await submit();
      const admin = await asAdmin();
      await approve(admin, submitted.id);

      const rows = await auditRows(submitted.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('review.approve');
      expect(rows[0]?.entity).toBe('review');
      expect(rows[0]?.actor_user_id).toBe(admin.user.id);
      expect(rows[0]?.before).toEqual({ status: 'PENDING', rejectionReason: null });
      expect(rows[0]?.after).toEqual({ status: 'APPROVED', rejectionReason: null });
    });

    /** Plan 9.1's rule, and here it also protects `moderatedAt` from being rewritten. */
    it('writes no audit row on a second approve', async () => {
      const submitted = await submit();
      const admin = await asAdmin();

      const first = expectSuccess<AdminReview>(await approve(admin, submitted.id));
      const second = expectSuccess<AdminReview>(await approve(admin, submitted.id));

      expect(second.moderatedAt).toBe(first.moderatedAt);
      const rows = await auditRows(submitted.id);
      expect(rows.map((row) => row.action)).toEqual(['review.approve']);
    });

    it('404s for a review that does not exist, and 400s for a non-uuid', async () => {
      const admin = await asAdmin();
      await approve(admin, NO_SUCH_ID, 404);
      await approve(admin, 'not-a-uuid', 400);
    });
  });

  describe('POST /admin/reviews/:id/reject', () => {
    it('keeps the review off the product page', async () => {
      const submitted = await submit();
      const admin = await asAdmin();

      const rejected = expectSuccess<AdminReview>(
        await reject(admin, submitted.id, { reason: 'No detail about the product.' }),
      );
      expect(rejected.status).toBe('rejected');
      expect(rejected.rejectionReason).toBe('No detail about the product.');

      const list = await publicReviews();
      expect(list.map((review) => review.id)).not.toContain(submitted.id);
      expect((await publicSummary()).total).toBe(5);
    });

    /**
     * The direction a status flip alone would miss: a review that had been counted stops being
     * counted, so the public average has to move back.
     */
    it('takes an approved review back out of the public average', async () => {
      const submitted = await submit();
      const admin = await asAdmin();

      await approve(admin, submitted.id);
      expect((await publicSummary()).total).toBe(6);

      await reject(admin, submitted.id);

      expect((await publicSummary()).total).toBe(5);
      expect((await productAggregates()).reviewCount).toBe(5);
      expect((await publicReviews()).map((review) => review.id)).not.toContain(submitted.id);

      const rows = await auditRows(submitted.id);
      expect(rows.map((row) => row.action)).toEqual(['review.approve', 'review.reject']);
    });

    /** Approving after a rejection must not leave a rejection note that no longer applies. */
    it('clears the rejection reason when the review is later approved', async () => {
      const submitted = await submit();
      const admin = await asAdmin();

      await reject(admin, submitted.id, { reason: 'Looks like spam.' });
      const approved = expectSuccess<AdminReview>(await approve(admin, submitted.id));

      expect(approved.rejectionReason).toBeNull();
    });

    /** Status *and* reason are compared, so re-rejecting with a different note is a real change. */
    it('writes no audit row on an identical second reject, and one on a changed note', async () => {
      const submitted = await submit();
      const admin = await asAdmin();

      await reject(admin, submitted.id, { reason: 'Spam.' });
      await reject(admin, submitted.id, { reason: 'Spam.' });
      expect((await auditRows(submitted.id)).map((row) => row.action)).toEqual(['review.reject']);

      await reject(admin, submitted.id, { reason: 'Names a competitor.' });
      expect((await auditRows(submitted.id)).map((row) => row.action)).toEqual([
        'review.reject',
        'review.reject',
      ]);
    });

    it('takes no reason at all', async () => {
      const submitted = await submit();
      const admin = await asAdmin();

      const rejected = expectSuccess<AdminReview>(await reject(admin, submitted.id));
      expect(rejected.rejectionReason).toBeNull();
    });

    it('refuses a reason longer than the column', async () => {
      const submitted = await submit();
      const admin = await asAdmin();

      const body = expectError(await reject(admin, submitted.id, { reason: 'x'.repeat(201) }, 400));
      expect(body.statusCode).toBe(400);
    });

    it('refuses a customer', async () => {
      const submitted = await submit();
      const customer = await signIn(UserRole.CUSTOMER);
      await customer.client
        .post(`${ADMIN_REVIEWS}/${submitted.id}/reject`)
        .set(CSRF_HEADER, customer.csrf)
        .send({})
        .expect(403);
    });
  });

  /**
   * **Withdrawing a product must withdraw its reviews with it** — found by Milestone 10's security
   * review, and it is the *read* half of a leak whose write half was already closed.
   *
   * `ReviewsService.create` filters `{ slug, isPublished: true }` and its docblock gives the reason
   * in full: *"`GET /catalog/products/:slug` 404s for an unpublished slug, so this must too —
   * otherwise the write path confirms the existence of a product the read path denies, which is the
   * same information leak from the other side."* The two public reads were the other side, and they
   * did not filter. Unpublishing a product flips `products.isPublished` and touches no `reviews`
   * row, so every approved review stayed anonymously readable — author names, bodies, image URLs and
   * a live rating average for something the catalogue answers 404 for.
   *
   * **The answer is asserted to be identical to an unknown slug's, not merely empty**, and that is
   * the part that keeps the fix from trading one oracle for another. A 404 here would have been the
   * obvious symmetry with the catalogue — and wrong, because an unknown slug answers `200 []`, so
   * "404 means withdrawn, 200 means never existed" is the same existence oracle wearing the
   * opposite sign. Withdrawn, unknown, and published-with-no-reviews all answer alike.
   */
  describe('a withdrawn product publishes nothing', () => {
    const ADMIN_PRODUCTS = '/api/v1/admin/products';
    const UNKNOWN = '/api/v1/catalog/products/no-such-product-anywhere/reviews';

    const productId = async (slug: string): Promise<string> => {
      const rows = await integration.dataSource.query<{ id: string }[]>(
        'SELECT id FROM products WHERE slug = $1',
        [slug],
      );
      const row = rows[0];
      if (row === undefined) throw new Error(`seedCatalog wrote no ${slug} product`);
      return row.id;
    };

    /** An approved review on the seeded product, written and moderated the ordinary way. */
    const approvedReview = async (): Promise<Review> => {
      const submitted = await submit();
      const admin = await asAdmin();
      await approve(admin, submitted.id);
      return submitted;
    };

    it('hides an approved review once the product is unpublished, exactly as for an unknown slug', async () => {
      const submitted = await approvedReview();

      // The precondition, asserted rather than assumed: it is visible while the product is on sale.
      expect((await publicReviews()).map((review) => review.id)).toContain(submitted.id);

      const admin = await asAdmin();
      await admin.client
        .post(`${ADMIN_PRODUCTS}/${await productId(SLUG)}/unpublish`)
        .set(CSRF_HEADER, admin.csrf)
        .expect(200);

      // The catalogue now denies the product exists.
      await agent(integration.app).get(`/api/v1/catalog/products/${SLUG}`).expect(404);

      // So the reviews route must not describe it either — and must answer as it does for a slug
      // that was never a product at all.
      const withdrawn = await publicReviews();
      const unknown = expectSuccess<Review[]>(await agent(integration.app).get(UNKNOWN).expect(200));
      expect(withdrawn).toEqual([]);
      expect(withdrawn).toEqual(unknown);
    });

    it('zeroes the rating summary too, so no aggregate survives the withdrawal', async () => {
      await approvedReview();
      expect((await publicSummary()).total).toBeGreaterThan(0);

      const admin = await asAdmin();
      await admin.client
        .post(`${ADMIN_PRODUCTS}/${await productId(SLUG)}/unpublish`)
        .set(CSRF_HEADER, admin.csrf)
        .expect(200);

      const withdrawn = await publicSummary();
      const unknown = expectSuccess<ReviewSummary>(
        await agent(integration.app).get(`${UNKNOWN}/summary`).expect(200),
      );
      expect(withdrawn).toEqual(unknown);
      expect(withdrawn.total).toBe(0);
      expect(withdrawn.average).toBe(0);
    });

    /**
     * The mirror image, and the reason the two tests above are not simply "the endpoint returns
     * nothing": republishing has to bring the reviews back. A fix that filtered on the wrong column,
     * or dropped the rows, would satisfy both assertions above and fail this one.
     */
    it('brings them back when the product is published again', async () => {
      const submitted = await approvedReview();
      const admin = await asAdmin();
      const id = await productId(SLUG);

      await admin.client.post(`${ADMIN_PRODUCTS}/${id}/unpublish`).set(CSRF_HEADER, admin.csrf).expect(200);
      expect(await publicReviews()).toEqual([]);

      await admin.client.post(`${ADMIN_PRODUCTS}/${id}/publish`).set(CSRF_HEADER, admin.csrf).expect(200);
      expect((await publicReviews()).map((review) => review.id)).toContain(submitted.id);
      expect((await publicSummary()).total).toBeGreaterThan(0);
    });
  });
});
