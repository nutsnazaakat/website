import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { AdminSetting, PublicSettings } from '@nutwala/shared';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { UserRole } from '../../src/entities/enums';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';
import { agent, expectError, expectSuccess, useIntegrationApp } from './helpers';

const PUBLIC_SETTINGS = '/api/v1/settings';
const ADMIN_SETTINGS = '/api/v1/admin/settings';
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
 * `GET /settings` and `/admin/settings` — spec §6.1 and §6.4, brief §26 and §37. Plan 9.4 Task 5.
 *
 * The public route is the one `Setting.isPublic`'s docblock has described since Milestone 1 and
 * nobody built: until now that column was read by nothing outside the entity, the migration and the
 * seed. The absence test below is what makes it real rather than decorative — and it is one of
 * plan 9.4's three mutation checks for exactly that reason.
 */
describe('settings', () => {
  const integration = useIntegrationApp();

  beforeEach(() => {
    const throttler = integration.app.get<ThrottlerStorageService>(ThrottlerStorage);
    throttler.onApplicationShutdown();
    throttler.storage.clear();
  });

  beforeEach(async () => {
    await seedSettings(integration.dataSource);
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

  const put = async (admin: Admin, body: Record<string, unknown>, status = 200) =>
    admin.client.put(ADMIN_SETTINGS).set(CSRF_HEADER, admin.csrf).send(body).expect(status);

  const publicSettings = async (): Promise<PublicSettings> =>
    expectSuccess<PublicSettings>(await agent(integration.app).get(PUBLIC_SETTINGS).expect(200));

  /** Flips a seeded row to private, so the absence assertion has something real to be about. */
  const makePrivate = async (key: string): Promise<void> => {
    await integration.dataSource.query('UPDATE settings SET "isPublic" = false WHERE key = $1', [
      key,
    ]);
  };

  const auditRows = async (entityId: string): Promise<AuditRow[]> =>
    integration.dataSource.query<AuditRow[]>(
      `SELECT action, entity, "entityId", actor_user_id, before, after FROM audit_logs
        WHERE "entityId" = $1 ORDER BY "createdAt", action`,
      [entityId],
    );

  describe('GET /settings — the public subset spec §6.1 asked for', () => {
    it('answers an anonymous visitor with the seeded public rows, keyed by name', async () => {
      const settings = await publicSettings();

      // A map, not an array: a storefront wants `settings.whatsappNumber`.
      expect(settings.brandName).toBe('Nuts & Nazaakat');
      expect(settings.freeShippingThreshold).toBe(999);
      expect(settings.codEnabled).toBe(true);
      // Brief §26 and §37 forbid inventing these, so they seed empty and stay empty until an
      // admin fills them in. This endpoint is what makes filling them in reach the storefront.
      expect(settings.whatsappNumber).toBe('');
      expect(settings.gstin).toBe('');
      expect(settings.certifications).toEqual([]);
    });

    /**
     * **The absence test**, and plan 9.4's first mutation check. If `publicSettings()` stopped
     * filtering on `isPublic`, this is the assertion that fails.
     */
    it('omits a non-public row entirely, rather than masking its value', async () => {
      await makePrivate('gstin');

      const settings = await publicSettings();

      expect(settings).not.toHaveProperty('gstin');
      expect(Object.keys(settings)).not.toContain('gstin');
      // The other rows are untouched, so this is a filter rather than a broken read.
      expect(settings.brandName).toBe('Nuts & Nazaakat');
    });

    it('carries whatever an admin has just configured', async () => {
      const admin = await asAdmin();
      await put(admin, { settings: [{ key: 'whatsappNumber', value: '919876543210' }] });

      expect((await publicSettings()).whatsappNumber).toBe('919876543210');
    });

    /** `@Public()` per handler, and no `@Roles()` anywhere on a customer-facing route. */
    it('needs no session at all', async () => {
      await agent(integration.app).get(PUBLIC_SETTINGS).expect(200);
      const customer = await signIn(UserRole.CUSTOMER);
      await customer.client.get(PUBLIC_SETTINGS).expect(200);
    });
  });

  describe('GET /admin/settings', () => {
    it('returns every row, private ones included, with the flag and the trail', async () => {
      await makePrivate('gstin');
      const admin = await asAdmin();

      const rows = expectSuccess<AdminSetting[]>(
        await admin.client.get(ADMIN_SETTINGS).expect(200),
      );

      // Fifteen storefront settings plus `business.timezone`, which plan 9.4's Task 6 added as the
      // first private row in this table.
      expect(rows).toHaveLength(16);
      const gstin = rows.find((row) => row.key === 'gstin');
      expect(gstin).toMatchObject({ key: 'gstin', value: '', isPublic: false });
      expect(gstin?.updatedByUserId).toBeNull();
      // Ordered by key, so the console renders a stable list.
      expect(rows.map((row) => row.key)).toEqual([...rows.map((row) => row.key)].sort());
    });

    it('refuses a customer and an anonymous caller', async () => {
      const customer = await signIn(UserRole.CUSTOMER);
      await customer.client.get(ADMIN_SETTINGS).expect(403);
      await agent(integration.app).get(ADMIN_SETTINGS).expect(401);
    });
  });

  describe('PUT /admin/settings', () => {
    it('writes the keys named, stamps updatedByUserId, and audits one row per key', async () => {
      const admin = await asAdmin();

      const written = expectSuccess<AdminSetting[]>(
        await put(admin, {
          settings: [
            { key: 'whatsappNumber', value: '919876543210' },
            { key: 'supportEmail', value: 'hello@nutsandnazaakat.in' },
          ],
        }),
      );

      expect(written).toHaveLength(2);
      expect(written.map((row) => row.key)).toEqual(['supportEmail', 'whatsappNumber']);
      expect(written.every((row) => row.updatedByUserId === admin.user.id)).toBe(true);

      const rows = await auditRows('whatsappNumber');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('setting.update');
      expect(rows[0]?.entity).toBe('setting');
      expect(rows[0]?.actor_user_id).toBe(admin.user.id);
      expect(rows[0]?.before).toEqual({ value: '' });
      expect(rows[0]?.after).toEqual({ value: '919876543210' });

      expect(await auditRows('supportEmail')).toHaveLength(1);
      // Everything else is left alone — this is not a whole-table replace.
      expect((await publicSettings()).brandName).toBe('Nuts & Nazaakat');
    });

    it('takes the four JSON shapes the table actually holds', async () => {
      const admin = await asAdmin();

      const written = expectSuccess<AdminSetting[]>(
        await put(admin, {
          settings: [
            { key: 'brandName', value: 'Nuts and Nazaakat' },
            { key: 'freeShippingThreshold', value: 1499 },
            { key: 'codEnabled', value: false },
            { key: 'certifications', value: ['FSSAI', 'ISO 22000'] },
          ],
        }),
      );

      const byKey = new Map(written.map((row) => [row.key, row.value]));
      expect(byKey.get('brandName')).toBe('Nuts and Nazaakat');
      expect(byKey.get('freeShippingThreshold')).toBe(1499);
      expect(byKey.get('codEnabled')).toBe(false);
      expect(byKey.get('certifications')).toEqual(['FSSAI', 'ISO 22000']);
    });

    /** Plan 9.1's rule, applied per key rather than per request. */
    it('writes no audit row for a key whose value did not change', async () => {
      const admin = await asAdmin();

      await put(admin, {
        settings: [
          { key: 'brandName', value: 'Nuts & Nazaakat' },
          { key: 'whatsappNumber', value: '919876543210' },
        ],
      });

      expect(await auditRows('brandName')).toEqual([]);
      expect(await auditRows('whatsappNumber')).toHaveLength(1);
    });

    /** A jsonb array compares by value, not by reference — see the `JSON.stringify` in `replace`. */
    it('treats an identical array as unchanged', async () => {
      const admin = await asAdmin();

      await put(admin, { settings: [{ key: 'certifications', value: [] }] });

      expect(await auditRows('certifications')).toEqual([]);
    });

    /**
     * A key that does not exist is refused, rather than creating a row that looks saved in the
     * console and is read by nothing. There is no route that deletes a setting, so it would be
     * permanent.
     */
    it('404s for an unknown key, naming it, and writes nothing at all', async () => {
      const admin = await asAdmin();

      const body = expectError(
        await put(
          admin,
          {
            settings: [
              { key: 'whatsappNumber', value: '919876543210' },
              { key: 'whatsapNumber', value: '919876543210' },
            ],
          },
          404,
        ),
      );
      expect(body.code).toBe('NOT_FOUND');
      expect(body.details).toMatchObject({ keys: ['whatsapNumber'] });

      // The transaction rolled back, so the *valid* key in the same payload was not written either.
      expect((await publicSettings()).whatsappNumber).toBe('');
      expect(await auditRows('whatsappNumber')).toEqual([]);
    });

    it('refuses the same key twice in one payload', async () => {
      const admin = await asAdmin();

      const body = expectError(
        await put(
          admin,
          {
            settings: [
              { key: 'gstin', value: '29ABCDE1234F1Z5' },
              { key: 'gstin', value: '27ABCDE1234F1Z5' },
            ],
          },
          422,
        ),
      );
      expect(body.details).toMatchObject({ keys: ['gstin'] });
    });

    /**
     * `isPublic` is not on `ReplaceSettingsDto` and the pipe runs with `forbidNonWhitelisted`, so
     * an attempt to publish a private setting over HTTP is a 400 rather than a quiet success.
     */
    it('gives no way to change isPublic', async () => {
      await makePrivate('gstin');
      const admin = await asAdmin();

      await put(admin, { settings: [{ key: 'gstin', value: '', isPublic: true }] }, 400);

      expect(await publicSettings()).not.toHaveProperty('gstin');
    });

    it('refuses an empty payload and a value that is null', async () => {
      const admin = await asAdmin();
      await put(admin, { settings: [] }, 400);
      await put(admin, { settings: [{ key: 'gstin', value: null }] }, 400);
      // A missing `value` is caught by the same decorator, not silently stripped by `whitelist`.
      await put(admin, { settings: [{ key: 'gstin' }] }, 400);
    });

    it('refuses a customer', async () => {
      const customer = await signIn(UserRole.CUSTOMER);
      await customer.client
        .put(ADMIN_SETTINGS)
        .set(CSRF_HEADER, customer.csrf)
        .send({ settings: [{ key: 'gstin', value: 'mine now' }] })
        .expect(403);
    });
  });
});
