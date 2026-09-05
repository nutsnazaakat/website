import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { AdminCoupon, Paginated } from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedCoupons } from '../../src/database/seeds/coupons.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { UserRole } from '../../src/entities/enums';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';
import { agent, expectError, expectSuccess, useIntegrationApp } from './helpers';

const ADMIN_COUPONS = '/api/v1/admin/coupons';
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
 * `/admin/coupons` — spec §6.4, brief §36. Plan 9.4 Task 1.
 *
 * Two decisions this suite exists to pin, both of which the plan left open:
 *
 * 1. **The identifier is `:code`.** Asserted through the routes rather than merely intended —
 *    `PATCH /admin/coupons/<uuid>` must 404, because the uuid is not a handle for a coupon
 *    anywhere in this system.
 * 2. **Deleting a redeemed coupon is refused.** The plan supposed there might be nothing to guard,
 *    on the grounds that `orders.couponCode` is a snapshot string. It is — but
 *    `coupon_redemptions.coupon_id` is `ON DELETE RESTRICT`, so there is a real reference and this
 *    is the `409 ENTITY_IN_USE` spec §5a requires.
 */
describe('admin coupons', () => {
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

  const BODY = { code: 'DIWALI25', type: 'percent', percentValue: 25 };

  const create = async (admin: Admin, overrides: Record<string, unknown> = {}, status = 201) =>
    admin.client
      .post(ADMIN_COUPONS)
      .set(CSRF_HEADER, admin.csrf)
      .send({ ...BODY, ...overrides })
      .expect(status);

  const created = async (admin: Admin, overrides: Record<string, unknown> = {}) =>
    expectSuccess<AdminCoupon>(await create(admin, overrides));

  const categoryId = async (slug: string): Promise<string> => {
    const rows = await integration.dataSource.query<{ id: string }[]>(
      'SELECT id FROM categories WHERE slug = $1',
      [slug],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`seedCatalog wrote no ${slug} category`);
    return id;
  };

  const couponId = async (code: string): Promise<string> => {
    const rows = await integration.dataSource.query<{ id: string }[]>(
      'SELECT id FROM coupons WHERE code = $1',
      [code],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`no coupon ${code}`);
    return id;
  };

  /** `coupon_redemptions.order_id` carries no foreign key, so a redemption needs no real order. */
  const redeem = async (code: string, userId: string | null): Promise<void> => {
    await integration.dataSource.query(
      `INSERT INTO coupon_redemptions (coupon_id, user_id, order_id, "discountPaise")
       VALUES ($1, $2, uuid_generate_v4(), 2500)`,
      [await couponId(code), userId],
    );
  };

  const auditRows = async (entityId: string): Promise<AuditRow[]> =>
    integration.dataSource.query<AuditRow[]>(
      `SELECT action, entity, "entityId", actor_user_id, before, after FROM audit_logs
        WHERE "entityId" = $1 ORDER BY "createdAt", action`,
      [entityId],
    );

  describe('GET /admin/coupons', () => {
    it('lists the seeded campaigns with their redemption counts', async () => {
      await seedCoupons(integration.dataSource);
      const admin = await asAdmin();
      await redeem('ALMOND15', null);

      const page = expectSuccess<Paginated<AdminCoupon>>(
        await admin.client.get(ADMIN_COUPONS).expect(200),
      );

      expect(page.total).toBe(3);
      const codes = page.items.map((coupon) => coupon.code);
      expect(codes).toEqual(expect.arrayContaining(['WELCOME10', 'BULK500', 'ALMOND15']));

      const almond = page.items.find((coupon) => coupon.code === 'ALMOND15');
      expect(almond?.timesRedeemed).toBe(1);
      expect(almond?.appliesTo).toBe('category');
      expect(almond?.usageLimit).toBe(100);
      // Money in rupees on the wire, per spec §8, and a percentage is not money.
      expect(almond?.percentValue).toBe(15);
      expect(almond?.flatValue).toBeNull();

      const bulk = page.items.find((coupon) => coupon.code === 'BULK500');
      expect(bulk?.flatValue).toBe(500);
      expect(bulk?.minOrderValue).toBe(10_000);
      expect(bulk?.channel).toBe('bulk');
      expect(bulk?.timesRedeemed).toBe(0);
    });

    it('filters on isActive without treating an unknown value as false', async () => {
      const admin = await asAdmin();
      await created(admin, { code: 'LIVE1' });
      await created(admin, { code: 'DEAD1', isActive: false });

      const active = expectSuccess<Paginated<AdminCoupon>>(
        await admin.client.get(`${ADMIN_COUPONS}?isActive=true`).expect(200),
      );
      expect(active.items.map((coupon) => coupon.code)).toEqual(['LIVE1']);

      const inactive = expectSuccess<Paginated<AdminCoupon>>(
        await admin.client.get(`${ADMIN_COUPONS}?isActive=false`).expect(200),
      );
      expect(inactive.items.map((coupon) => coupon.code)).toEqual(['DEAD1']);

      // `?isActive=yes` must not silently mean "false" — see `toQueryBoolean`.
      await admin.client.get(`${ADMIN_COUPONS}?isActive=yes`).expect(400);
    });

    it('refuses a customer and an anonymous caller', async () => {
      const customer = await signIn(UserRole.CUSTOMER);
      await customer.client.get(ADMIN_COUPONS).expect(403);
      await agent(integration.app).get(ADMIN_COUPONS).expect(401);
    });
  });

  describe('POST /admin/coupons', () => {
    it('creates a coupon, uppercases the code, and audits the create', async () => {
      const admin = await asAdmin();

      const coupon = expectSuccess<AdminCoupon>(await create(admin, { code: 'diwali25' }));

      expect(coupon.code).toBe('DIWALI25');
      expect(coupon.type).toBe('percent');
      expect(coupon.percentValue).toBe(25);
      expect(coupon.timesRedeemed).toBe(0);
      // The column defaults, surfaced rather than assumed.
      expect(coupon.isActive).toBe(true);
      expect(coupon.appliesTo).toBe('all');
      expect(coupon.channel).toBe('all');

      const rows = await auditRows('DIWALI25');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('coupon.create');
      expect(rows[0]?.entity).toBe('coupon');
      expect(rows[0]?.actor_user_id).toBe(admin.user.id);
      expect(rows[0]?.before).toBeNull();
      expect(rows[0]?.after).toMatchObject({ type: 'PERCENT', percentValue: '25.00' });
    });

    it('takes every one of brief §36’s levers', async () => {
      const admin = await asAdmin();
      const almonds = await categoryId('almonds');

      const coupon = await created(admin, {
        code: 'ALLLEVERS',
        type: 'flat',
        percentValue: undefined,
        flatValue: 250,
        minOrderValue: 2000,
        appliesTo: 'category',
        categoryId: almonds,
        channel: 'retail',
        firstOrderOnly: true,
        usageLimit: 50,
        usageLimitPerUser: 2,
        startsAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '2026-11-01T00:00:00.000Z',
      });

      expect(coupon).toMatchObject({
        type: 'flat',
        flatValue: 250,
        percentValue: null,
        minOrderValue: 2000,
        appliesTo: 'category',
        categoryId: almonds,
        channel: 'retail',
        firstOrderOnly: true,
        usageLimit: 50,
        usageLimitPerUser: 2,
        startsAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '2026-11-01T00:00:00.000Z',
      });
    });

    it('refuses a duplicate code with a named 409', async () => {
      const admin = await asAdmin();
      await created(admin);

      const body = expectError(await create(admin, { code: 'diwali25' }, 409));
      expect(body.code).toBe('IDENTIFIER_IN_USE');
      expect(body.details).toMatchObject({ field: 'code' });
    });

    /**
     * `ck_coupons_value_exclusive` would catch each of these at the database — as a 500 naming a
     * constraint. The point of the service check is that the operator is told which field to send.
     */
    it('refuses a row that contradicts itself rather than letting the check constraint 500', async () => {
      const admin = await asAdmin();

      const noValue = expectError(await create(admin, { percentValue: undefined }, 422));
      expect(noValue.code).toBe('VALIDATION_FAILED');
      expect(noValue.details).toMatchObject({ field: 'percentValue' });

      const both = expectError(await create(admin, { flatValue: 100 }, 422));
      expect(both.details).toMatchObject({ field: 'percentValue' });

      const flatWithoutValue = expectError(
        await create(admin, { type: 'flat', percentValue: undefined }, 422),
      );
      expect(flatWithoutValue.details).toMatchObject({ field: 'flatValue' });
    });

    /** The validation `coupon.service.ts`'s `eligibleSubtotal` explicitly delegates to this path. */
    it('refuses a category-scoped coupon with no category, and a category on an unscoped one', async () => {
      const admin = await asAdmin();

      const scoped = expectError(await create(admin, { appliesTo: 'category' }, 422));
      expect(scoped.details).toMatchObject({ field: 'categoryId' });

      const unscoped = expectError(
        await create(admin, { categoryId: await categoryId('almonds') }, 422),
      );
      expect(unscoped.details).toMatchObject({ field: 'categoryId' });

      const missing = expectError(
        await create(
          admin,
          { appliesTo: 'category', categoryId: '00000000-0000-4000-8000-000000000000' },
          422,
        ),
      );
      expect(missing.details).toMatchObject({ field: 'categoryId' });
    });

    /** `applyFlat` takes no cap, so a stored one would be displayed and then ignored. */
    it('refuses maxDiscount on a flat coupon', async () => {
      const admin = await asAdmin();
      const body = expectError(
        await create(
          admin,
          { type: 'flat', percentValue: undefined, flatValue: 100, maxDiscount: 50 },
          422,
        ),
      );
      expect(body.details).toMatchObject({ field: 'maxDiscount' });
    });

    /** A window that never opens: `preview` would answer `COUPON_INVALID` forever, with no signal. */
    it('refuses an expiry at or before the start', async () => {
      const admin = await asAdmin();
      await create(
        admin,
        { startsAt: '2026-11-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z' },
        422,
      );
    });

    /**
     * **Allowed, deliberately.** `CouponService.preview` answers `COUPON_EXPIRED` for it, which is
     * its own error code precisely because it is actionable — nothing is mis-handled. Back-dating
     * an expiry is a legitimate way to end a campaign at a stated moment, and the same rule holds
     * on create and update so there is no asymmetry to be surprised by.
     */
    it('allows an expiry in the past, because the redemption path handles it correctly', async () => {
      const admin = await asAdmin();
      const coupon = await created(admin, { expiresAt: '2020-01-01T00:00:00.000Z' });
      expect(coupon.expiresAt).toBe('2020-01-01T00:00:00.000Z');
    });
  });

  describe('PATCH /admin/coupons/:code', () => {
    const patch = async (admin: Admin, code: string, body: Record<string, unknown>, status = 200) =>
      admin.client
        .patch(`${ADMIN_COUPONS}/${code}`)
        .set(CSRF_HEADER, admin.csrf)
        .send(body)
        .expect(status);

    it('updates by code, case-insensitively, and audits only what changed', async () => {
      const admin = await asAdmin();
      await created(admin);

      const updated = expectSuccess<AdminCoupon>(
        await patch(admin, 'diwali25', { percentValue: 30, isActive: false }),
      );
      expect(updated.percentValue).toBe(30);
      expect(updated.isActive).toBe(false);

      const rows = await auditRows('DIWALI25');
      expect(rows.map((row) => row.action)).toEqual(['coupon.create', 'coupon.update']);
      expect(rows[1]?.before).toEqual({ percentValue: '25.00', isActive: true });
      expect(rows[1]?.after).toEqual({ percentValue: '30.00', isActive: false });
    });

    /** Plan 9.1's rule: a write that changes nothing leaves no trace. */
    it('writes no audit row when nothing changes', async () => {
      const admin = await asAdmin();
      await created(admin);

      await patch(admin, 'DIWALI25', { percentValue: 25 });

      const rows = await auditRows('DIWALI25');
      expect(rows.map((row) => row.action)).toEqual(['coupon.create']);
    });

    /** An explicit `null` clears a nullable column; an omitted key leaves it alone. */
    it('tells an explicit null from an omitted field', async () => {
      const admin = await asAdmin();
      await created(admin, { maxDiscount: 200, minOrderValue: 500 });

      const cleared = expectSuccess<AdminCoupon>(
        await patch(admin, 'DIWALI25', {
          maxDiscount: null,
        }),
      );
      expect(cleared.maxDiscount).toBeNull();
      expect(cleared.minOrderValue).toBe(500);
    });

    /**
     * The identifier decision, asserted rather than assumed: a coupon has a uuid and it is not a
     * handle for one.
     */
    it('is addressed by code, so a uuid is not found', async () => {
      const admin = await asAdmin();
      await created(admin);

      await patch(admin, await couponId('DIWALI25'), { percentValue: 30 }, 404);
    });

    /** `code` is not on `UpdateCouponDto`, and the pipe runs with `forbidNonWhitelisted`. */
    it('refuses an attempt to rename the code', async () => {
      const admin = await asAdmin();
      await created(admin);

      await patch(admin, 'DIWALI25', { code: 'DIWALI26' }, 400);
    });

    it('refuses a usage limit below the number of redemptions already taken', async () => {
      const admin = await asAdmin();
      await created(admin, { usageLimit: 10 });
      await redeem('DIWALI25', null);
      await redeem('DIWALI25', null);

      const body = expectError(await patch(admin, 'DIWALI25', { usageLimit: 1 }, 422));
      expect(body.details).toMatchObject({ usageLimit: 1, timesRedeemed: 2 });

      // Equal to current usage is allowed: it caps the campaign where it stands.
      await patch(admin, 'DIWALI25', { usageLimit: 2 });
    });

    it('carries the type change and its value together', async () => {
      const admin = await asAdmin();
      await created(admin);

      // Half a change is refused, because the row it would write breaks the check constraint.
      await patch(admin, 'DIWALI25', { type: 'flat' }, 422);

      const flat = expectSuccess<AdminCoupon>(
        await patch(admin, 'DIWALI25', { type: 'flat', percentValue: null, flatValue: 300 }),
      );
      expect(flat).toMatchObject({ type: 'flat', flatValue: 300, percentValue: null });
    });

    it('404s for a coupon that does not exist', async () => {
      const admin = await asAdmin();
      await patch(admin, 'NOSUCHCODE', { percentValue: 5 }, 404);
    });
  });

  describe('DELETE /admin/coupons/:code', () => {
    const remove = async (admin: Admin, code: string, status: number) =>
      admin.client.delete(`${ADMIN_COUPONS}/${code}`).set(CSRF_HEADER, admin.csrf).expect(status);

    it('deletes an unredeemed coupon and audits the delete', async () => {
      const admin = await asAdmin();
      await created(admin);

      await remove(admin, 'diwali25', 204);

      const rows = await auditRows('DIWALI25');
      expect(rows.map((row) => row.action)).toEqual(['coupon.create', 'coupon.delete']);
      // The whole row in `before`, because nothing else will ever hold it.
      expect(rows[1]?.after).toBeNull();
      expect(rows[1]?.before).toMatchObject({ type: 'PERCENT', percentValue: '25.00' });

      const survivors = await integration.dataSource.query<{ count: string }[]>(
        `SELECT count(*) AS count FROM coupons WHERE code = 'DIWALI25'`,
      );
      expect(survivors[0]?.count).toBe('0');
    });

    /**
     * **The guard the plan supposed might not be needed.** `orders.couponCode` really is a snapshot
     * with no foreign key — but `coupon_redemptions.coupon_id` is `ON DELETE RESTRICT`, and its own
     * docblock says why: a used coupon's redemption history must outlive it.
     */
    it('refuses to delete a redeemed coupon, with 409 ENTITY_IN_USE and the count', async () => {
      const admin = await asAdmin();
      await created(admin);
      await redeem('DIWALI25', admin.user.id);

      const body = expectError(await remove(admin, 'DIWALI25', 409));
      expect(body.code).toBe('ENTITY_IN_USE');
      expect(body.details).toMatchObject({ code: 'DIWALI25', redemptions: 1 });

      // Refused, so nothing was written — not the delete, and not an audit row claiming one.
      const rows = await auditRows('DIWALI25');
      expect(rows.map((row) => row.action)).toEqual(['coupon.create']);
      const survivors = await integration.dataSource.query<{ count: string }[]>(
        `SELECT count(*) AS count FROM coupons WHERE code = 'DIWALI25'`,
      );
      expect(survivors[0]?.count).toBe('1');
    });

    it('404s for a coupon that does not exist', async () => {
      const admin = await asAdmin();
      await remove(admin, 'NOSUCHCODE', 404);
    });

    it('refuses a customer', async () => {
      const admin = await asAdmin();
      await created(admin);
      const customer = await signIn(UserRole.CUSTOMER);
      await customer.client
        .delete(`${ADMIN_COUPONS}/DIWALI25`)
        .set(CSRF_HEADER, customer.csrf)
        .expect(403);
    });
  });
});
