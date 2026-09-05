import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { AdminAuditLogEntry, Paginated } from '@nutwala/shared';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { UserRole } from '../../src/entities/enums';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';
import { agent, expectSuccess, useIntegrationApp } from './helpers';

const AUDIT_LOGS = '/api/v1/admin/audit-logs';
const ADMIN_COUPONS = '/api/v1/admin/coupons';
const ADMIN_INVENTORY = '/api/v1/admin/inventory';
const LOGIN = '/api/v1/auth/login';
const CSRF_HEADER = 'X-CSRF-Token';

/**
 * `GET /admin/audit-logs` — spec §6.4's last row, brief §45's `AuditLogs`. Plan 9.4 Task 7.
 *
 * Every row asserted here is written by a **real admin write** through its own endpoint, never
 * inserted. A trail tested against rows the test wrote itself proves the reader works and says
 * nothing about whether the writers are wired up, which is the only interesting question.
 */
describe('admin audit logs', () => {
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

  const signIn = async (role: UserRole, overrides: Record<string, unknown> = {}) => {
    const user = await createTestUser(integration.dataSource, { role, ...overrides });
    const client = agent(integration.app);
    const login = await client
      .post(LOGIN)
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(200);
    return { client, user, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  };

  const asAdmin = (name = 'Test Admin') => signIn(UserRole.ADMIN, { name });
  type Admin = Awaited<ReturnType<typeof asAdmin>>;

  const makeCoupon = async (admin: Admin, code: string): Promise<void> => {
    await admin.client
      .post(ADMIN_COUPONS)
      .set(CSRF_HEADER, admin.csrf)
      .send({ code, type: 'percent', percentValue: 10 })
      .expect(201);
  };

  const read = async (admin: Admin, query = ''): Promise<Paginated<AdminAuditLogEntry>> =>
    expectSuccess<Paginated<AdminAuditLogEntry>>(
      await admin.client.get(`${AUDIT_LOGS}${query}`).expect(200),
    );

  describe('GET /admin/audit-logs', () => {
    it('is empty before anything has been done', async () => {
      const admin = await asAdmin();

      const page = await read(admin);

      expect(page).toMatchObject({ total: 0, page: 1, limit: 24 });
      expect(page.items).toEqual([]);
    });

    it('reports a real write with its actor’s name, entity and payload', async () => {
      const admin = await asAdmin('Priya Nair');
      await makeCoupon(admin, 'TRAIL1');

      const page = await read(admin);

      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({
        action: 'coupon.create',
        entity: 'coupon',
        // A coupon's identity in the trail is its **code**, which is what joins it to
        // `orders.couponCode`. `AuditAction.COUPON_CREATE` records that departure.
        entityId: 'TRAIL1',
        actorUserId: admin.user.id,
        actorName: 'Priya Nair',
        before: null,
      });
      expect(page.items[0]?.after).toMatchObject({ type: 'PERCENT' });
      expect(typeof page.items[0]?.createdAt).toBe('string');
      // The trail renders a name; it must not be carrying the account it came from.
      expect(page.items[0]).not.toHaveProperty('passwordHash');
    });

    it('is newest first', async () => {
      const admin = await asAdmin();
      await makeCoupon(admin, 'FIRST1');
      await makeCoupon(admin, 'SECOND1');
      await admin.client.delete(`${ADMIN_COUPONS}/FIRST1`).set(CSRF_HEADER, admin.csrf).expect(204);

      const page = await read(admin);

      expect(page.total).toBe(3);
      expect(page.items[0]).toMatchObject({ action: 'coupon.delete', entityId: 'FIRST1' });
    });

    it('filters by actor, entity, entityId and action', async () => {
      const priya = await asAdmin('Priya Nair');
      const arjun = await asAdmin('Arjun Rao');
      await makeCoupon(priya, 'PRIYA1');
      await makeCoupon(arjun, 'ARJUN1');
      await arjun.client
        .patch(`${ADMIN_COUPONS}/ARJUN1`)
        .set(CSRF_HEADER, arjun.csrf)
        .send({ percentValue: 20 })
        .expect(200);

      const byActor = await read(priya, `?actorUserId=${priya.user.id}`);
      expect(byActor.total).toBe(1);
      expect(byActor.items[0]?.entityId).toBe('PRIYA1');

      const byEntity = await read(priya, '?entity=coupon');
      expect(byEntity.total).toBe(3);

      const byEntityId = await read(priya, '?entityId=ARJUN1');
      expect(byEntityId.total).toBe(2);

      const byAction = await read(priya, '?action=coupon.update');
      expect(byAction.total).toBe(1);
      expect(byAction.items[0]?.entityId).toBe('ARJUN1');

      // An unknown value matches nothing rather than 400ing — the trail's vocabulary grows with
      // every write path that ships, and a closed list here would strand old rows.
      expect((await read(priya, '?entity=unicorn')).total).toBe(0);
      expect((await read(priya, '?action=coupon.teleport')).total).toBe(0);
    });

    it('bounds by date, reading a date-only value as a business day', async () => {
      const admin = await asAdmin();
      await makeCoupon(admin, 'DATED1');

      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'short',
      }).format(new Date());

      expect((await read(admin, `?from=${today}&to=${today}`)).total).toBe(1);
      expect((await read(admin, '?from=2020-01-01&to=2020-01-02')).total).toBe(0);
    });

    it('paginates with a total that survives a page past the end', async () => {
      const admin = await asAdmin();
      await makeCoupon(admin, 'PAGE1');
      await makeCoupon(admin, 'PAGE2');
      await makeCoupon(admin, 'PAGE3');

      const first = await read(admin, '?limit=2');
      expect(first.items).toHaveLength(2);
      expect(first.total).toBe(3);

      const second = await read(admin, '?limit=2&page=2');
      expect(second.items).toHaveLength(1);
      expect(second.total).toBe(3);

      const past = await read(admin, '?limit=2&page=9');
      expect(past.items).toHaveLength(0);
      // `getManyAndCount` counts over the same `where`, so a page past the end still reports 3.
      expect(past.total).toBe(3);

      // No row appears twice and none is lost — the `id` tiebreak on a shared `createdAt`.
      const ids = [...first.items, ...second.items].map((entry) => entry.id);
      expect(new Set(ids).size).toBe(3);
      await admin.client.get(`${AUDIT_LOGS}?limit=61`).expect(400);
    });

    /**
     * **The absence this endpoint most needs to be honest about.** Plan 9.2 decided the
     * `inventory_transactions` ledger *is* the audit trail for stock, so no `AuditAction` member
     * exists for a movement. An operator who opens this page looking for one and finds nothing must
     * not conclude the trail is broken — the service, the controller and the wire type all say so,
     * and this pins the behaviour they describe.
     */
    it('shows a threshold change but not the stock movement beside it', async () => {
      const admin = await asAdmin();
      const rows = await integration.dataSource.query<{ variantId: string }[]>(
        'SELECT variant_id AS "variantId" FROM inventory LIMIT 1',
      );
      const variantId = rows[0]?.variantId;
      if (variantId === undefined) throw new Error('seedCatalog wrote no inventory');

      // A real stock movement, through the endpoint that writes the ledger row.
      await admin.client
        .patch(`${ADMIN_INVENTORY}/${variantId}`)
        .set(CSRF_HEADER, admin.csrf)
        .send({ delta: -5, reason: 'Damaged in transit' })
        .expect(200);

      // A threshold change, which moves no stock.
      await admin.client
        .patch(`${ADMIN_INVENTORY}/${variantId}/threshold`)
        .set(CSRF_HEADER, admin.csrf)
        .send({ lowStockThreshold: 25 })
        .expect(200);

      const page = await read(admin, '?entity=inventory');

      expect(page.items.map((entry) => entry.action)).toEqual(['inventory.update']);
      expect(page.items[0]?.after).toMatchObject({ lowStockThreshold: 25 });

      // The movement is not absent from the world, only from this trail — it is in the ledger.
      const ledger = expectSuccess<{ items: { delta: number; reason: string }[] }>(
        await admin.client.get(`${ADMIN_INVENTORY}/${variantId}/transactions`).expect(200),
      );
      expect(ledger.items.map((entry) => entry.delta)).toContain(-5);
    });

    it('refuses a customer and an anonymous caller', async () => {
      const customer = await signIn(UserRole.CUSTOMER);
      await customer.client.get(AUDIT_LOGS).expect(403);
      await agent(integration.app).get(AUDIT_LOGS).expect(401);
    });
  });
});
