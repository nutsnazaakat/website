import { ThrottlerStorage, type ThrottlerStorageService } from '@nestjs/throttler';
import type { Test } from 'supertest';
import { seedCatalog } from '../../src/database/seeds/catalog.seed';
import { seedSettings } from '../../src/database/seeds/settings.seed';
import { UserRole } from '../../src/entities/enums';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { createTestUser, TEST_PASSWORD } from '../factories/user.factory';
import { agent, expectError, expectSuccess, useIntegrationApp } from './helpers';

const BASE = '/api/v1/admin/inventory';
const CSRF_HEADER = 'X-CSRF-Token';
const NO_SUCH_VARIANT = '00000000-0000-4000-8000-000000000000';

interface AdjustmentBody {
  onHand: number;
  balanceAfter: number;
}

interface LedgerRow {
  delta: number;
  type: string;
  reason: string;
  balanceAfter: number;
  actor_user_id: string | null;
  order_id: string | null;
}

/**
 * The database half of Task 22, which is the half a double cannot reach.
 *
 * `inventory.service.spec.ts` pins the branch logic and the shape of the statement the service
 * builds. Three claims are not about shape at all and only Postgres can answer them:
 *
 * - a `:delta` parameter really does survive inside a raw `set()` expression, and really is reused
 *   across the `SET` and the `WHERE` — if it did not, the statement would not run at all;
 * - `onHand + delta >= reserved` means what it reads as, evaluated by the database in the same
 *   statement that writes;
 * - the column write and the ledger row commit together, so the invariant Plan 1 pinned
 *   (`SUM(inventory_transactions.delta) == inventory.onHand` per variant) survives an adjustment.
 *
 * `schema-invariants.integration.spec.ts` asserts that invariant against the *seeded* state only —
 * it never adjusts anything — so nothing before this file checked that it holds after a write.
 *
 * It is also the first end-to-end exercise of `@Roles()` anywhere in the codebase.
 */
describe('admin inventory adjustment', () => {
  const integration = useIntegrationApp();

  /**
   * Empties the rate limiter between tests. `useIntegrationApp` boots one application for the whole
   * file, so `ThrottlerGuard`'s in-memory storage is shared across it, and `/auth/login` is capped
   * at five attempts per fifteen minutes per IP with every supertest request arriving from
   * 127.0.0.1. `onApplicationShutdown()` cancels the pending per-hit decrement timers, which is not
   * optional — see the longer note in `auth.integration.spec.ts`.
   */
  beforeEach(() => {
    const throttler = integration.app.get<ThrottlerStorageService>(ThrottlerStorage);
    throttler.onApplicationShutdown();
    throttler.storage.clear();
  });

  beforeEach(async () => {
    await seedSettings(integration.dataSource);
    await seedCatalog(integration.dataSource);
  });

  /**
   * `seedCatalog` writes one opening `RECEIPT` row per variant, so every variant starts with the
   * ledger and the column already in agreement. That is what makes the invariant assertions below
   * exact equalities rather than deltas.
   */
  const aVariant = async (): Promise<string> => {
    const rows = await integration.dataSource.query<{ variant_id: string }[]>(
      'SELECT variant_id FROM inventory ORDER BY variant_id LIMIT 1',
    );
    const variantId = rows[0]?.variant_id;
    if (variantId === undefined) throw new Error('seedCatalog wrote no inventory rows');
    return variantId;
  };

  const stock = async (variantId: string): Promise<{ onHand: number; reserved: number }> => {
    const rows = await integration.dataSource.query<{ onHand: number; reserved: number }[]>(
      'SELECT "onHand", reserved FROM inventory WHERE variant_id = $1',
      [variantId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`No inventory row for ${variantId}`);
    return row;
  };

  const ledgerFor = async (variantId: string): Promise<LedgerRow[]> =>
    integration.dataSource.query<LedgerRow[]>(
      `SELECT delta, type::text AS type, reason, "balanceAfter", actor_user_id, order_id
         FROM inventory_transactions WHERE variant_id = $1 ORDER BY "createdAt", delta`,
      [variantId],
    );

  /** Rows where the denormalised column and the append-only ledger disagree. Must always be empty. */
  const drift = async (): Promise<unknown[]> =>
    integration.dataSource.query(`
      SELECT i.variant_id
        FROM inventory i
        LEFT JOIN inventory_transactions t ON t.variant_id = i.variant_id
       GROUP BY i.variant_id, i."onHand"
      HAVING i."onHand" <> COALESCE(SUM(t.delta), 0)::int
    `);

  /** A signed-in client, plus the CSRF token a state-changing request has to echo. */
  const signIn = async (role: UserRole) => {
    const user = await createTestUser(integration.dataSource, { role });
    const client = agent(integration.app);
    const login = await client
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(200);
    return { client, user, csrf: expectSuccess<{ csrfToken: string }>(login).csrfToken };
  };

  const asAdmin = () => signIn(UserRole.ADMIN);

  describe('a well-formed adjustment', () => {
    /**
     * The reachability test, and it earns its place twice over: it is the only thing that would
     * notice `InventoryModule` missing from `app.module.ts`'s imports — a 404, with every unit test
     * in the module still green — and a successful `UPDATE` is itself the proof that `:delta` binds
     * inside the raw `set()` expression. Left unbound, the finished SQL would carry a literal
     * `:delta` and Postgres would refuse the statement outright.
     */
    it('moves the column by the delta and answers with the new balance', async () => {
      const variantId = await aVariant();
      const before = await stock(variantId);
      const { client, csrf } = await asAdmin();

      const response = await client
        .patch(`${BASE}/${variantId}`)
        .set(CSRF_HEADER, csrf)
        .send({ delta: -7, reason: 'Damaged in transit — 7 packs discarded' })
        .expect(200);

      expect(expectSuccess<AdjustmentBody>(response)).toEqual({
        onHand: before.onHand - 7,
        balanceAfter: before.onHand - 7,
      });
      expect((await stock(variantId)).onHand).toBe(before.onHand - 7);
    });

    it('appends one ADJUSTMENT row naming the admin who made it', async () => {
      const variantId = await aVariant();
      const before = await stock(variantId);
      const { client, csrf, user } = await asAdmin();

      await client
        .patch(`${BASE}/${variantId}`)
        .set(CSRF_HEADER, csrf)
        .send({ delta: 15, reason: 'Restocked from the mill' })
        .expect(200);

      expect(await ledgerFor(variantId)).toEqual([
        expect.objectContaining({ type: 'RECEIPT', delta: before.onHand }),
        {
          delta: 15,
          type: 'ADJUSTMENT',
          reason: 'Restocked from the mill',
          balanceAfter: before.onHand + 15,
          actor_user_id: user.id,
          order_id: null,
        },
      ]);
    });

    /**
     * The invariant this whole task exists to preserve, asserted after a write rather than after a
     * seed. Two adjustments, not one: a single one is satisfied by a service that overwrites the
     * ledger instead of appending to it.
     */
    it('leaves the ledger and the column in agreement', async () => {
      const variantId = await aVariant();
      const { client, csrf } = await asAdmin();

      for (const delta of [-3, 11]) {
        await client
          .patch(`${BASE}/${variantId}`)
          .set(CSRF_HEADER, csrf)
          .send({ delta, reason: 'Stock count correction' })
          .expect(200);
      }

      expect(await drift()).toEqual([]);
    });

    /**
     * `updatedAt` is never written by the service. `@UpdateDateColumn` makes TypeORM append
     * `"updatedAt" = CURRENT_TIMESTAMP` to the statement itself, which is the database's clock
     * rather than whichever host served the request.
     */
    it('lets the database stamp updatedAt', async () => {
      const variantId = await aVariant();
      const [before] = await integration.dataSource.query<{ updatedAt: Date }[]>(
        'SELECT "updatedAt" FROM inventory WHERE variant_id = $1',
        [variantId],
      );
      const { client, csrf } = await asAdmin();

      await client
        .patch(`${BASE}/${variantId}`)
        .set(CSRF_HEADER, csrf)
        .send({ delta: 1, reason: 'Found one behind the shelf' })
        .expect(200);

      const [after] = await integration.dataSource.query<{ updatedAt: Date }[]>(
        'SELECT "updatedAt" FROM inventory WHERE variant_id = $1',
        [variantId],
      );
      expect(after?.updatedAt.getTime()).toBeGreaterThan(Number(before?.updatedAt.getTime()));
    });

    /**
     * `stock.low` fires on the *crossing*, not on every adjustment that leaves stock low — the
     * property `check-low-stock.spec.ts` states in isolation, proved here end to end over three
     * real adjustments through the endpoint.
     *
     * Every step goes through `PATCH`, including the one that sets the starting point, rather than
     * writing `onHand` directly: `reserve` below shows what a column write costs — a matching
     * ledger row, hand-written — and there is nothing to gain here, because reaching
     * `lowStockThreshold + 3` from the seeder's opening figure is itself a legal adjustment that
     * crosses nothing. `expect(rows).toHaveLength(1)` is therefore an assertion about all three.
     */
    it('queues stock.low exactly when the adjustment crosses the threshold, and only then', async () => {
      const variantId = await aVariant();
      const [row] = await integration.dataSource.query<{ lowStockThreshold: number }[]>(
        'SELECT "lowStockThreshold" FROM inventory WHERE variant_id = $1',
        [variantId],
      );
      const lowStockThreshold = Number(row?.lowStockThreshold);
      const { client, csrf } = await asAdmin();

      const adjust = (delta: number, reason: string): Test =>
        client.patch(`${BASE}/${variantId}`).set(CSRF_HEADER, csrf).send({ delta, reason });

      // Down to `lowStockThreshold + 3` — above the threshold, so this crosses nothing either.
      await adjust(lowStockThreshold + 3 - (await stock(variantId)).onHand, 'Stock count').expect(
        200,
      );
      // Stays above the threshold. No notification.
      await adjust(-1, 'small correction').expect(200);
      // Crosses it.
      await adjust(-3, 'bigger correction').expect(200);

      const rows = await integration.dataSource.query<{ payload: Record<string, unknown> }[]>(
        `SELECT payload FROM notifications WHERE template = 'stock.low' AND payload->>'variantId' = $1`,
        [variantId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toMatchObject({ variantId, onHand: lowStockThreshold - 1 });
      // And the fixture route did not cost the invariant this file exists to protect.
      expect(await drift()).toEqual([]);
    });
  });

  describe('when the adjustment would breach the reserved floor', () => {
    /**
     * The condition evaluated by Postgres, in the statement that writes. `reserved` is zero in
     * normal operation (adding to cart reserves nothing, spec §10.1), so it has to be set up here.
     *
     * Note what a failure of this test would look like without the `andWhere`:
     * `ck_inventory_non_negative` also enforces `onHand >= reserved`, so the database refuses the
     * write either way. The guard's job is to make that refusal a 409 carrying `OUT_OF_STOCK`
     * instead of a constraint violation surfacing as 500 "Internal server error" — a difference the
     * admin console has to be able to branch on.
     */
    const reserve = async (variantId: string, onHand: number, reserved: number): Promise<void> => {
      const opening = (await stock(variantId)).onHand;
      await integration.dataSource.query(
        'UPDATE inventory SET "onHand" = $2, reserved = $3 WHERE variant_id = $1',
        [variantId, onHand, reserved],
      );
      // The fixture moves the column, so it writes the matching ledger row too — otherwise every
      // `drift()` assertion in this describe would fail on the fixture rather than on the service.
      // The delta is computed from what was there, not from the seeder's opening figure: retail
      // packs open at 120 and bulk packs at 40, and `aVariant()` does not choose between them.
      await integration.dataSource.query(
        `INSERT INTO inventory_transactions (variant_id, delta, type, reason, "balanceAfter")
         VALUES ($1, $2, 'ADJUSTMENT', 'Fixture: set up a reserved floor', $3)`,
        [variantId, onHand - opening, onHand],
      );
    };

    it('refuses with 409 OUT_OF_STOCK rather than clamping', async () => {
      const variantId = await aVariant();
      await reserve(variantId, 10, 4);
      const { client, csrf } = await asAdmin();

      const response = await client
        .patch(`${BASE}/${variantId}`)
        .set(CSRF_HEADER, csrf)
        .send({ delta: -7, reason: 'Written off after the audit' })
        .expect(409);

      expect(expectError(response).code).toBe('OUT_OF_STOCK');
    });

    it('leaves the column and the ledger exactly as they were', async () => {
      const variantId = await aVariant();
      await reserve(variantId, 10, 4);
      const ledgerBefore = await ledgerFor(variantId);
      const { client, csrf } = await asAdmin();

      await client
        .patch(`${BASE}/${variantId}`)
        .set(CSRF_HEADER, csrf)
        .send({ delta: -7, reason: 'Written off after the audit' })
        .expect(409);

      expect((await stock(variantId)).onHand).toBe(10);
      expect(await ledgerFor(variantId)).toEqual(ledgerBefore);
    });

    it('allows an adjustment that lands exactly on the floor', async () => {
      const variantId = await aVariant();
      await reserve(variantId, 10, 4);
      const { client, csrf } = await asAdmin();

      await client
        .patch(`${BASE}/${variantId}`)
        .set(CSRF_HEADER, csrf)
        .send({ delta: -6, reason: 'Written off after the audit' })
        .expect(200);

      expect((await stock(variantId)).onHand).toBe(4);
      expect(await drift()).toEqual([]);
    });
  });

  /**
   * Zero rows affected has two causes and they get different answers. Reported as `OUT_OF_STOCK`,
   * an admin who mistyped an id was told their correction would oversell reserved orders — an
   * explanation about stock levels for a row that has none.
   */
  it('answers 404 NOT_FOUND for a variant that does not exist', async () => {
    const { client, csrf } = await asAdmin();

    const response = await client
      .patch(`${BASE}/${NO_SUCH_VARIANT}`)
      .set(CSRF_HEADER, csrf)
      .send({ delta: -1, reason: 'Mistyped the variant id' })
      .expect(404);

    expect(expectError(response).code).toBe('NOT_FOUND');
  });

  /**
   * The transaction boundary, proven by making the second write fail.
   *
   * `inventory_transactions.actor_user_id` is a foreign key to `users`, so an actor who does not
   * exist — an admin whose account was deleted while their token was still valid — fails the ledger
   * insert *after* the column has already been updated. Without one transaction around the pair,
   * the column keeps the change and the ledger never records it: the invariant breaks silently, and
   * the storefront then disagrees with its own audit trail.
   *
   * Driven through the service rather than HTTP, because the controller reads the actor from the
   * signed token and there is deliberately no way to send a bogus one over the wire.
   */
  it('rolls the column back when the ledger insert fails', async () => {
    const variantId = await aVariant();
    const before = await stock(variantId);
    const service = integration.app.get(InventoryService);

    await expect(
      service.adjust({
        variantId,
        delta: -9,
        reason: 'Actor no longer exists',
        actorUserId: NO_SUCH_VARIANT,
      }),
    ).rejects.toThrow();

    expect((await stock(variantId)).onHand).toBe(before.onHand);
    expect(await drift()).toEqual([]);
  });

  describe('authorization', () => {
    /**
     * The first end-to-end check of `@Roles()` in the codebase. `RolesGuard` is global and returns
     * `true` early for a route with no `@Roles()` metadata, so a controller that lost the decorator
     * would not fail closed — it would quietly accept every signed-in customer. This is what
     * notices.
     */
    it('refuses a signed-in customer with 403', async () => {
      const variantId = await aVariant();
      const before = await stock(variantId);
      const { client, csrf } = await signIn(UserRole.CUSTOMER);

      await client
        .patch(`${BASE}/${variantId}`)
        .set(CSRF_HEADER, csrf)
        .send({ delta: -1, reason: 'Helping myself to the stock ledger' })
        .expect(403);

      expect((await stock(variantId)).onHand).toBe(before.onHand);
    });

    it('refuses an anonymous request', async () => {
      const variantId = await aVariant();
      const before = await stock(variantId);

      // 403 rather than 401: `CsrfGuard` runs ahead of `JwtAuthGuard`, so a state-changing request
      // with no token is refused as unverifiable before the session lookup is spent.
      await agent(integration.app)
        .patch(`${BASE}/${variantId}`)
        .send({ delta: -1, reason: 'Anonymous meddling' })
        .expect(403);

      expect((await stock(variantId)).onHand).toBe(before.onHand);
    });
  });

  describe('validation', () => {
    it('rejects a delta of zero at the boundary', async () => {
      const variantId = await aVariant();
      const { client, csrf } = await asAdmin();

      const response = await client
        .patch(`${BASE}/${variantId}`)
        .set(CSRF_HEADER, csrf)
        .send({ delta: 0, reason: 'Changes nothing' })
        .expect(400);

      expect(expectError(response).details).toHaveProperty('delta');
    });

    it('rejects a fractional delta', async () => {
      const variantId = await aVariant();
      const { client, csrf } = await asAdmin();

      await client
        .patch(`${BASE}/${variantId}`)
        .set(CSRF_HEADER, csrf)
        .send({ delta: 2.5, reason: 'Half a pack' })
        .expect(400);
    });

    it('requires a reason', async () => {
      const variantId = await aVariant();
      const { client, csrf } = await asAdmin();

      const response = await client
        .patch(`${BASE}/${variantId}`)
        .set(CSRF_HEADER, csrf)
        .send({ delta: -1 })
        .expect(400);

      expect(expectError(response).details).toHaveProperty('reason');
    });

    /**
     * `MinLength(4)`, and it is pinned by nothing else — measured: with the decorator deleted, all
     * 24 unit tests and every other case in this file stay green, because "requires a reason" above
     * only exercises `@IsString()`. "ok" is not a reason, and Brief §32 wants the history to say why.
     */
    it('rejects a reason too short to explain anything', async () => {
      const variantId = await aVariant();
      const { client, csrf } = await asAdmin();

      const response = await client
        .patch(`${BASE}/${variantId}`)
        .set(CSRF_HEADER, csrf)
        .send({ delta: -1, reason: 'ok' })
        .expect(400);

      expect(expectError(response).details).toHaveProperty('reason');
    });

    /** `MaxLength(200)` matches the column, so an over-long reason is a named field error. */
    it('rejects a reason longer than the column', async () => {
      const variantId = await aVariant();
      const { client, csrf } = await asAdmin();

      await client
        .patch(`${BASE}/${variantId}`)
        .set(CSRF_HEADER, csrf)
        .send({ delta: -1, reason: 'x'.repeat(201) })
        .expect(400);
    });

    it('rejects a variant id that is not a uuid', async () => {
      const { client, csrf } = await asAdmin();

      await client
        .patch(`${BASE}/not-a-uuid`)
        .set(CSRF_HEADER, csrf)
        .send({ delta: -1, reason: 'Bad path parameter' })
        .expect(400);
    });

    /** `whitelist` plus `forbidNonWhitelisted` is spec §13's mass-assignment defence. */
    it('rejects a body trying to name its own actor', async () => {
      const variantId = await aVariant();
      const { client, csrf } = await asAdmin();

      await client
        .patch(`${BASE}/${variantId}`)
        .set(CSRF_HEADER, csrf)
        .send({ delta: -1, reason: 'Blaming someone else', actorUserId: NO_SUCH_VARIANT })
        .expect(400);
    });
  });
});
