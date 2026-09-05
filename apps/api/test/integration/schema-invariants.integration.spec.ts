import { DataSource } from 'typeorm';
import { cleanDatabase, closeTestDataSource, connectTestDataSource } from './helpers';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { seedUsers } from '../../src/database/seeds/users.seed';

describe('schema invariants', () => {
  let dataSource: DataSource;

  // The container itself is started once in `globalSetup`, not here. `connectTestDataSource`
  // only opens a connection to it — a spec that starts its own container is the bug the harness
  // was restructured to remove, which is why `startTestDatabase` is not exported to specs.
  beforeAll(async () => {
    dataSource = await connectTestDataSource();
  }, 120_000);

  afterAll(async () => {
    // Closes this spec's connection. The container is torn down by `globalTeardown`.
    await closeTestDataSource();
  });

  beforeEach(async () => {
    await cleanDatabase(dataSource);
    await seedSettings(dataSource);
    await seedUsers(dataSource);
    await seedCatalog(dataSource);
  });

  it('seeds the expected catalog volume', async () => {
    // `noUncheckedIndexedAccess` makes `rows[0]` (and destructuring the first element) come back
    // `T | undefined`, so it is read through `?.` rather than destructured — the same pattern
    // `PostgresVersionAssertionService` uses for the same reason. An actually-missing row still
    // fails the assertion below (`Number(undefined)` is `NaN`), which is where that failure
    // belongs.
    const productRows = await dataSource.query<{ count: string }[]>(
      'SELECT count(*)::int AS count FROM products',
    );
    const variantRows = await dataSource.query<{ count: string }[]>(
      'SELECT count(*)::int AS count FROM product_variants',
    );
    const inventoryRows = await dataSource.query<{ count: string }[]>(
      'SELECT count(*)::int AS count FROM inventory',
    );

    expect(Number(productRows[0]?.count)).toBe(27);
    expect(Number(variantRows[0]?.count)).toBe(216);
    // Every variant must have exactly one inventory row, or a stock read returns undefined
    // and the sold-out rule silently stops applying to that pack.
    expect(Number(inventoryRows[0]?.count)).toBe(216);
  });

  it('gives every variant an inventory row', async () => {
    const orphans = await dataSource.query<{ id: string }[]>(`
      SELECT v.id FROM product_variants v
      LEFT JOIN inventory i ON i.variant_id = v.id
      WHERE i.variant_id IS NULL
    `);
    expect(orphans).toEqual([]);
  });

  it('keeps the inventory ledger consistent with on-hand stock', async () => {
    // Spec §17 item 7. `onHand` is denormalised and the ledger is append-only, so this is the
    // assertion that they can never silently disagree.
    //
    // It is an exact equality because the seeder writes an opening RECEIPT row for the
    // starting 120 (Task 20 step 2b). Seeding stock without a ledger entry would force this
    // test — and every later one — to know that magic number.
    const drift = await dataSource.query<
      { variant_id: string; on_hand: number; ledger: number }[]
    >(`
      SELECT i.variant_id,
             i."onHand" AS on_hand,
             COALESCE(SUM(t.delta), 0)::int AS ledger
        FROM inventory i
        LEFT JOIN inventory_transactions t ON t.variant_id = i.variant_id
       GROUP BY i.variant_id, i."onHand"
      HAVING i."onHand" <> COALESCE(SUM(t.delta), 0)::int
    `);
    expect(drift).toEqual([]);
  });

  it('records an opening ledger row for every variant', async () => {
    const rows = await dataSource.query<{ count: string }[]>(
      `SELECT count(*)::int AS count FROM inventory_transactions WHERE type = 'RECEIPT'`,
    );
    expect(Number(rows[0]?.count)).toBe(216);
  });

  it('refuses to drive stock negative', async () => {
    const rows = await dataSource.query<{ variant_id: string }[]>(
      'SELECT variant_id FROM inventory LIMIT 1',
    );
    await expect(
      dataSource.query('UPDATE inventory SET "onHand" = -1 WHERE variant_id = $1', [
        rows[0]?.variant_id,
      ]),
    ).rejects.toThrow(/ck_inventory_non_negative/);
  });

  it('refuses an out-of-range review rating', async () => {
    const rows = await dataSource.query<{ id: string; slug: string }[]>(
      'SELECT id, slug FROM products LIMIT 1',
    );
    const product = rows[0];
    await expect(
      dataSource.query(
        // `reviews.productSlug` is non-nullable (see the second migration), so a raw insert must
        // supply it alongside `product_id` even though this test is only exercising the rating
        // check constraint.
        `INSERT INTO reviews (product_id, "productSlug", author, rating, body, status)
         VALUES ($1, $2, 'Tester', 6, 'too many stars', 'PENDING')`,
        [product?.id, product?.slug],
      ),
    ).rejects.toThrow(/ck_reviews_rating/);
  });

  it('refuses an unknown order status', async () => {
    await expect(
      dataSource.query(`
        INSERT INTO orders ("orderNumber", channel, status, "paymentMethod",
                            "subtotalPaise", "gstPaise", "totalPaise",
                            "addressSnapshot", "placedAt", "estimatedDelivery")
        VALUES ('NN-2026-999999', 'RETAIL', 'teleported', 'COD', 0, 0, 0,
                '{}'::jsonb, now(), now())
      `),
    ).rejects.toThrow(/ck_orders_status/);
  });

  it('treats email uniqueness case-insensitively', async () => {
    await expect(
      dataSource.query(`
        INSERT INTO users (name, email, phone, "passwordHash", role)
        VALUES ('Duplicate', 'B2C@DEMO.IN', '9999999999', 'x', 'CUSTOMER')
      `),
    ).rejects.toThrow(/uq_users_email/);
  });

  it('allows only one default address per user', async () => {
    const rows = await dataSource.query<{ user_id: string }[]>(
      'SELECT user_id FROM addresses WHERE "isDefault" = true LIMIT 1',
    );
    await expect(
      dataSource.query(
        `INSERT INTO addresses (user_id, label, "fullName", phone, email, line1, city, state,
                                pincode, "isDefault")
         VALUES ($1, 'Second', 'Someone', '9876543210', 'a@b.test', 'Line', 'City', 'Delhi',
                 '110001', true)`,
        [rows[0]?.user_id],
      ),
    ).rejects.toThrow(/uq_addresses_one_default_per_user/);
  });

  it('seeds no certification claim, per brief §25 and §26', async () => {
    const rows = await dataSource.query<{ key: string; value: unknown }[]>(
      `SELECT key, value FROM settings WHERE key IN ('certifications', 'fssaiLicence', 'gstin')`,
    );
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    expect(byKey.certifications).toEqual([]);
    expect(byKey.fssaiLicence).toBe('');
    expect(byKey.gstin).toBe('');
  });

  it("gives the seeded business a DEFAULT segment, so this milestone changes nobody's prices", async () => {
    // Task 1 of the B2B plan: `businesses.segment` is `NOT NULL DEFAULT 'DEFAULT'`, added by a
    // migration on a populated table. The one seeded business row must come out `DEFAULT` — the
    // measured fact the whole milestone's safety argument rests on.
    const rows = await dataSource.query<{ segment: string }[]>(
      `SELECT segment FROM businesses WHERE "companyName" = 'Anand Sweets & Namkeen'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.segment).toBe('DEFAULT');
  });

  it('refuses a business billing or shipping address that does not exist', async () => {
    // `billing_address_id`/`shipping_address_id` were bare `uuid` columns with no constraint
    // until Task 1. A bogus id must now be refused by name, not silently stored.
    const [business] = await dataSource.query<{ id: string }[]>(
      `SELECT id FROM businesses WHERE "companyName" = 'Anand Sweets & Namkeen'`,
    );
    await expect(
      dataSource.query(
        `UPDATE businesses SET billing_address_id = '00000000-0000-0000-0000-000000000000' WHERE id = $1`,
        [business?.id],
      ),
    ).rejects.toThrow(/fk_businesses_billing_address/);
    await expect(
      dataSource.query(
        `UPDATE businesses SET shipping_address_id = '00000000-0000-0000-0000-000000000000' WHERE id = $1`,
        [business?.id],
      ),
    ).rejects.toThrow(/fk_businesses_shipping_address/);
  });

  it('clears a business address reference on delete rather than blocking it', async () => {
    // `ON DELETE SET NULL`, not `RESTRICT`: an address book entry is the customer's to remove,
    // and a business record must never be the thing that blocks it — see Task 1's migration.
    const [business] = await dataSource.query<
      {
        id: string;
        billing_address_id: string;
        shipping_address_id: string;
      }[]
    >(
      `SELECT id, billing_address_id, shipping_address_id FROM businesses
        WHERE "companyName" = 'Anand Sweets & Namkeen'`,
    );
    expect(business?.billing_address_id).toBeTruthy();
    expect(business?.billing_address_id).toBe(business?.shipping_address_id);

    await dataSource.query(`DELETE FROM addresses WHERE id = $1`, [business?.billing_address_id]);

    const [after] = await dataSource.query<
      { billing_address_id: string | null; shipping_address_id: string | null }[]
    >(`SELECT billing_address_id, shipping_address_id FROM businesses WHERE id = $1`, [
      business?.id,
    ]);
    expect(after?.billing_address_id).toBeNull();
    expect(after?.shipping_address_id).toBeNull();
  });
});
