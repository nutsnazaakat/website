import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { AdminDashboard, AdminOrderSummary, Paginated } from '@nutwala/shared';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { UserRole } from '../../src/entities/enums';
import { BUSINESS_TIMEZONE_KEY } from '../../src/modules/settings/business-timezone';
import { createTestOrder } from '../factories/order.factory';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';
import { agent, expectSuccess, useIntegrationApp } from './helpers';

const DASHBOARD = '/api/v1/admin/dashboard';
const ADMIN_ORDERS = '/api/v1/admin/orders';
const ADMIN_SETTINGS = '/api/v1/admin/settings';
const LOGIN = '/api/v1/auth/login';
const CSRF_HEADER = 'X-CSRF-Token';

/** IST is UTC+05:30 with no daylight saving, so this offset is a constant rather than a lookup. */
const IST_OFFSET = '+05:30';

/** The calendar date in a given zone for an instant — `en-CA` formats as `YYYY-MM-DD`. */
function dayIn(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, dateStyle: 'short' }).format(at);
}

/**
 * The business timezone — spec §5b, plan 9.4 Task 6.
 *
 * **The whole point of this file is that one order is asserted on two surfaces.** Spec §5b is
 * emphatic that the timezone "must be applied to every dated admin figure at once", because a
 * per-endpoint fix is how two figures start disagreeing. Its two known consumers are
 * `salesOverTime` in `GET /admin/dashboard` and the `?from`/`?to` filter on `GET /admin/orders`,
 * and plan 9.2 left them consistent on UTC deliberately so they could be moved together.
 *
 * So the fixture is a single order placed at **04:00 IST**, which is 22:30 UTC on the *previous*
 * day. Under the old UTC behaviour it landed on the previous day's dashboard bar and fell outside
 * `?from=<its IST date>` entirely. Both assertions below fail if either surface is left behind —
 * which is plan 9.4's second mutation check, stated as a test rather than as an intention.
 *
 * A test that only checked the setting was stored would prove nothing, so nothing here reads the
 * `settings` row directly except the test that changes it.
 */
describe('business timezone', () => {
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

  /**
   * 04:00 IST on the most recent full IST day before today, and the two calendar dates that instant
   * falls on.
   *
   * Computed from `now` rather than hard-coded, because `salesOverTime` only reaches back 30 days —
   * a fixed date would start passing and then quietly stop. Yesterday rather than today, so the
   * instant is unambiguously in the past however the suite is scheduled.
   */
  const earlyMorning = (): { at: Date; istDay: string; utcDay: string } => {
    const istToday = dayIn('Asia/Kolkata', new Date());
    // Midnight IST today, minus a day, re-read as an IST date: stepping back from an instant that
    // is already a known IST midnight cannot land on the wrong calendar day.
    const previousMidnight = new Date(Date.parse(`${istToday}T00:00:00${IST_OFFSET}`) - 86_400_000);
    const istDay = dayIn('Asia/Kolkata', previousMidnight);
    const at = new Date(`${istDay}T04:00:00${IST_OFFSET}`);
    return { at, istDay, utcDay: dayIn('UTC', at) };
  };

  const placeAt = async (at: Date): Promise<void> => {
    await createTestOrder(integration.dataSource, {
      status: 'processing',
      totalRupees: 2400,
      placedAt: at,
    });
  };

  const dashboard = async (): Promise<AdminDashboard> => {
    const admin = await asAdmin();
    return expectSuccess<AdminDashboard>(await admin.client.get(DASHBOARD).expect(200));
  };

  const ordersBetween = async (from: string, to: string): Promise<AdminOrderSummary[]> => {
    const admin = await asAdmin();
    const page = expectSuccess<Paginated<AdminOrderSummary>>(
      await admin.client.get(`${ADMIN_ORDERS}?from=${from}&to=${to}`).expect(200),
    );
    return page.items;
  };

  /**
   * Written straight to the row rather than through `PUT /admin/settings`, deliberately: one test
   * below sets a zone the API would be right to refuse if it ever validated, and these cases are
   * about what the *readers* do with whatever the column holds.
   */
  const setTimezone = async (value: string): Promise<void> => {
    await integration.dataSource.query('UPDATE settings SET value = $1 WHERE key = $2', [
      JSON.stringify(value),
      BUSINESS_TIMEZONE_KEY,
    ]);
  };

  it('seeds business.timezone as Asia/Kolkata, private', async () => {
    const rows = await integration.dataSource.query<{ value: string; isPublic: boolean }[]>(
      'SELECT value, "isPublic" FROM settings WHERE key = $1',
      [BUSINESS_TIMEZONE_KEY],
    );
    expect(rows[0]).toMatchObject({ value: 'Asia/Kolkata', isPublic: false });

    // Private, so it is absent from the storefront's `GET /settings` — the flag's whole job.
    const publicSettings = expectSuccess<Record<string, unknown>>(
      await agent(integration.app).get('/api/v1/settings').expect(200),
    );
    /**
     * `Object.keys(...)` rather than `expect(publicSettings).not.toHaveProperty(key)`, and the
     * difference is not stylistic: **Jest reads a dotted string as a property *path***, so
     * `toHaveProperty('business.timezone')` asks for `settings.business.timezone` — which is absent
     * whether or not the flat key `'business.timezone'` is present, and the assertion therefore
     * passes even when the private setting is being published.
     *
     * Found by plan 9.4's own mutation check: with the `isPublic` filter removed from
     * `publicSettings()`, `settings.integration.spec.ts` failed and this line did not. Recorded
     * because this key is the only dotted one in the table, so it is the only place the trap bites.
     */
    expect(Object.keys(publicSettings)).not.toContain(BUSINESS_TIMEZONE_KEY);
  });

  /**
   * Surface one. Under UTC grouping this order lands on `utcDay`, the day before — the exact
   * failure spec §5b describes.
   */
  it('puts a 04:00 IST order on the IST day’s bar, not the previous UTC day’s', async () => {
    const { at, istDay, utcDay } = earlyMorning();
    // The fixture is only meaningful if the two dates really differ.
    expect(utcDay).not.toBe(istDay);
    await placeAt(at);

    const { charts } = await dashboard();
    const days = charts.salesOverTime.map((point) => point.date);

    expect(days).toContain(istDay);
    expect(days).not.toContain(utcDay);
    expect(charts.salesOverTime.find((point) => point.date === istDay)).toMatchObject({
      sales: 2400,
      orders: 1,
    });
  });

  /**
   * Surface two, the same order and the same day. Under UTC bounds `?from=<istDay>` began at
   * 00:00Z on that date, which is 5.5 hours *after* this order's 22:30Z, so it fell outside a
   * filter naming its own day.
   */
  it('includes a 04:00 IST order in ?from=&to= naming that IST day', async () => {
    const { at, istDay, utcDay } = earlyMorning();
    await placeAt(at);

    expect(await ordersBetween(istDay, istDay)).toHaveLength(1);
    // And it is not double-counted into the previous day, which is where UTC put it.
    expect(await ordersBetween(utcDay, utcDay)).toHaveLength(0);
  });

  /** The last microsecond of an IST day is still inside that day — the `<` next-midnight bound. */
  it('covers the whole of a date-only day, both edges', async () => {
    const { istDay } = earlyMorning();
    await placeAt(new Date(`${istDay}T00:00:00${IST_OFFSET}`));
    await placeAt(new Date(`${istDay}T23:59:59.999${IST_OFFSET}`));

    expect(await ordersBetween(istDay, istDay)).toHaveLength(2);
  });

  /**
   * A full instant is **not** reinterpreted. A console that resolves its own ranges must keep
   * getting exactly the bound it sent.
   */
  it('leaves a full ISO instant exactly as sent', async () => {
    const { at, istDay } = earlyMorning();
    await placeAt(at);

    // 00:00Z on the IST day is after 22:30Z the previous day, so an instant bound excludes it —
    // which is the old UTC behaviour, and correct when the caller asked for an instant.
    const admin = await asAdmin();
    const page = expectSuccess<Paginated<AdminOrderSummary>>(
      await admin.client
        .get(`${ADMIN_ORDERS}?from=${istDay}T00:00:00.000Z&to=${istDay}T23:59:59.999Z`)
        .expect(200),
    );
    expect(page.items).toHaveLength(0);
  });

  /**
   * **The proof they are one setting rather than two coincidences.** Changing `business.timezone`
   * moves the dashboard bar and the order filter together, in the same direction, for the same
   * order.
   */
  it('moves both surfaces together when the setting changes', async () => {
    const { at, istDay, utcDay } = earlyMorning();
    await placeAt(at);

    await setTimezone('UTC');

    const { charts } = await dashboard();
    const days = charts.salesOverTime.map((point) => point.date);
    expect(days).toContain(utcDay);
    expect(days).not.toContain(istDay);

    expect(await ordersBetween(utcDay, utcDay)).toHaveLength(1);
    expect(await ordersBetween(istDay, istDay)).toHaveLength(0);
  });

  /** A row someone typed by hand must not turn every dated admin figure into a 500. */
  it('falls back to Asia/Kolkata when the setting holds something unusable', async () => {
    const { at, istDay } = earlyMorning();
    await placeAt(at);

    await setTimezone('Mars/Olympus_Mons');

    expect((await dashboard()).charts.salesOverTime.map((point) => point.date)).toContain(istDay);
    expect(await ordersBetween(istDay, istDay)).toHaveLength(1);
  });

  /** It is a normal setting, so `PUT /admin/settings` reaches it and the audit trail records it. */
  it('is editable through PUT /admin/settings, and audited', async () => {
    const admin = await asAdmin();

    await admin.client
      .put(ADMIN_SETTINGS)
      .set(CSRF_HEADER, admin.csrf)
      .send({ settings: [{ key: BUSINESS_TIMEZONE_KEY, value: 'Asia/Dubai' }] })
      .expect(200);

    const rows = await integration.dataSource.query<{ action: string; after: unknown }[]>(
      `SELECT action, after FROM audit_logs WHERE "entityId" = $1`,
      [BUSINESS_TIMEZONE_KEY],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('setting.update');
    expect(rows[0]?.after).toEqual({ value: 'Asia/Dubai' });
  });
});
