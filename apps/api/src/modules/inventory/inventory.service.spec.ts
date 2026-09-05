import { HttpStatus } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain-error';
import { Inventory } from '../../entities/catalog/inventory.entity';
import { InventoryTransaction } from '../../entities/catalog/inventory-transaction.entity';
import { InventoryTransactionType } from '../../entities/enums';
import { InventoryService } from './inventory.service';

const VARIANT = '11111111-1111-4111-8111-111111111111';
const MISSING = '99999999-9999-4999-8999-999999999999';
const ACTOR = '22222222-2222-4222-8222-222222222222';

interface StockRow {
  variantId: string;
  onHand: number;
  reserved: number;
  lowStockThreshold: number;
}

interface LedgerRow {
  variantId: string;
  delta: number;
  type: InventoryTransactionType;
  reason: string;
  balanceAfter: number;
  orderId: string | null;
  actorUserId: string | null;
}

/** What the service asked the database to do, recorded fragment by fragment. */
interface Statement {
  setExpressions: Record<string, string>;
  conditions: string[];
  parameters: Record<string, unknown>;
}

interface Harness {
  service: InventoryService;
  stock: StockRow[];
  ledger: LedgerRow[];
  statements: Statement[];
  /** Every database call in order, so a test can assert *when* something happened. */
  trace: string[];
  /**
   * Every `NotificationsService.queue` input, in order. Empty is the usual, correct answer.
   *
   * `lowStockThreshold` became a required field on `StockRow` when `adjust` gained the low-stock
   * hook, so every fixture in this file now names one. They all say `10`, and no pre-existing
   * test's quantities cross it — deliberately, because those tests are about the column, the
   * ledger and the SQL, and must not start asserting on notifications by accident.
   */
  queued: unknown[];
  /**
   * Every `AuditLogService.record` input, in order.
   *
   * A separate list from `ledger` because plan 9.2's threshold endpoint writes one and not the
   * other, and the whole point of that split is that a test can tell which happened.
   */
  audited: unknown[];
}

/**
 * A stand-in for the one `UPDATE` this service issues, and it is deliberately strict.
 *
 * It refuses any statement outside the shape `adjust` is documented to build, rather than quietly
 * agreeing with a weaker one — the same reasoning as `sessions.service.spec.ts`'s repository fake,
 * where a fake that ignored criteria it did not understand made a "one row only" test vacuous.
 *
 * Three refusals matter here, because each corresponds to a mutation that would otherwise pass
 * every test in this file:
 *
 * - **`delta` not bound as a parameter.** Interpolating it into the SQL string leaves nothing in
 *   `setParameters`, so the fake cannot even find the value to apply. That is the habit the plan
 *   calls out: not exploitable while `@IsInt()` guards the boundary, but this is the one file in
 *   the service that writes raw SQL fragments, and it is the file that gets copied.
 * - **`SET "onHand"` not referencing `:delta`.** Same defect, one clause over.
 * - **No condition mentioning `reserved`.** Dropping the guard makes the statement unconditional,
 *   which is precisely the oversell this endpoint exists to refuse.
 *
 * What it cannot prove is that Postgres agrees: whether a parameter really survives inside a raw
 * `set()` expression, and whether the condition means what it reads as, are claims about the
 * driver and the database. `test/integration/inventory.integration.spec.ts` carries those.
 */
function harness(
  rows: StockRow[] = [{ variantId: VARIANT, onHand: 120, reserved: 0, lowStockThreshold: 10 }],
): Harness {
  const stock = rows;
  const ledger: LedgerRow[] = [];
  const statements: Statement[] = [];
  const trace: string[] = [];
  let depth = 0;

  const inTransaction = (what: string): void => {
    if (depth === 0) throw new Error(`fake: ${what} happened outside the transaction`);
  };

  const applyUpdate = (statement: Statement): { affected: number } => {
    const { delta, variantId } = statement.parameters;
    if (typeof delta !== 'number') {
      throw new Error(
        'fake: the update did not bind `delta` as a parameter — it must go through ' +
          'setParameters(), never be interpolated into the SQL',
      );
    }
    if (typeof variantId !== 'string') {
      throw new Error('fake: the update did not bind `variantId` as a parameter');
    }

    const onHand = statement.setExpressions.onHand;
    if (onHand === undefined || !onHand.includes(':delta')) {
      throw new Error(`fake: SET "onHand" must reference the bound :delta, got ${String(onHand)}`);
    }
    if (!statement.conditions.some((condition) => condition.includes('reserved'))) {
      throw new Error(
        'fake: the update carried no condition mentioning `reserved`, so it would oversell ' +
          'stock that is already spoken for',
      );
    }

    const row = stock.find((candidate) => candidate.variantId === variantId);
    if (!row) return { affected: 0 };
    if (row.onHand + delta < row.reserved) return { affected: 0 };
    row.onHand += delta;
    return { affected: 1 };
  };

  const queryBuilder = (): unknown => {
    const statement: Statement = { setExpressions: {}, conditions: [], parameters: {} };
    const builder = {
      update: (target: unknown) => {
        if (target !== Inventory) throw new Error('fake: the update must target Inventory');
        return builder;
      },
      set: (values: Record<string, unknown>) => {
        for (const [column, value] of Object.entries(values)) {
          if (typeof value !== 'function') {
            throw new Error(`fake: SET ${column} must be a raw SQL expression, not a bare value`);
          }
          statement.setExpressions[column] = String((value as () => unknown)());
        }
        return builder;
      },
      where: (condition: string) => {
        statement.conditions.push(condition);
        return builder;
      },
      andWhere: (condition: string) => {
        statement.conditions.push(condition);
        return builder;
      },
      setParameters: (parameters: Record<string, unknown>) => {
        Object.assign(statement.parameters, parameters);
        return builder;
      },
      execute: () => {
        inTransaction('the stock update');
        statements.push(statement);
        trace.push('update');
        return Promise.resolve(applyUpdate(statement));
      },
    };
    return builder;
  };

  const inventoryRepository = {
    exists: ({ where }: { where: { variantId: string } }) => {
      trace.push('exists');
      return Promise.resolve(stock.some((row) => row.variantId === where.variantId));
    },
    findOneOrFail: ({ where }: { where: { variantId: string } }) => {
      trace.push('read');
      const row = stock.find((candidate) => candidate.variantId === where.variantId);
      return row
        ? Promise.resolve(row)
        : Promise.reject(new Error('fake: findOneOrFail matched no inventory row'));
    },
    findOne: ({ where }: { where: { variantId: string } }) => {
      trace.push('read');
      return Promise.resolve(stock.find((row) => row.variantId === where.variantId) ?? null);
    },
    /**
     * Strict in the same spirit as `applyUpdate`: it refuses a `save`-shaped call.
     *
     * `setThreshold` reads the row, then writes **only** `lowStockThreshold` through `update`. A
     * mutation to `save(inventory)` would type-check and pass any assertion about the resulting
     * threshold, while silently writing back the `onHand` and `reserved` the read had captured — so
     * a concurrent adjustment committed in between would be undone by a threshold edit. This fake
     * has no `save` at all, which turns that mutation into a failure here rather than a lost pack
     * in production.
     */
    update: (
      criteria: { variantId: string },
      values: Partial<Pick<StockRow, 'lowStockThreshold'>>,
    ) => {
      inTransaction('the threshold update');
      trace.push('threshold');
      const keys = Object.keys(values);
      if (keys.length !== 1 || keys[0] !== 'lowStockThreshold') {
        throw new Error(
          `fake: the threshold update must set only lowStockThreshold, got ${keys.join()}`,
        );
      }
      const row = stock.find((candidate) => candidate.variantId === criteria.variantId);
      if (!row) return Promise.resolve({ affected: 0 });
      row.lowStockThreshold = Number(values.lowStockThreshold);
      return Promise.resolve({ affected: 1 });
    },
  };

  const ledgerRepository = {
    insert: (row: LedgerRow) => {
      inTransaction('the ledger insert');
      ledger.push(row);
      trace.push('ledger');
      return Promise.resolve({ identifiers: [] });
    },
  };

  /**
   * `stockPosition`'s raw `SELECT`, answered from the fixture.
   *
   * The SQL itself is not interpreted — that is Postgres's job and
   * `test/integration/admin-inventory.integration.spec.ts`'s. What this does check is the one thing
   * a double can: that the read is issued **through the caller's manager**, so it sees the
   * uncommitted threshold written moments earlier. Through the `DataSource` it would not, and the
   * endpoint would answer with the old figure it had just replaced.
   */
  const positionQuery = (parameters: unknown[]): Promise<unknown[]> => {
    inTransaction('the stock position read');
    trace.push('position');
    const row = stock.find((candidate) => candidate.variantId === parameters[0]);
    if (!row) return Promise.resolve([]);
    return Promise.resolve([
      {
        variantId: row.variantId,
        sku: 'FAKE-1KG',
        size: '1kg',
        isActive: true,
        productId: 'product-1',
        productName: 'Fake Almonds',
        onHand: row.onHand,
        reserved: row.reserved,
        available: row.onHand - row.reserved,
        lowStockThreshold: row.lowStockThreshold,
        low: row.onHand - row.reserved <= row.lowStockThreshold,
        updatedAt: new Date('2026-08-27T00:00:00.000Z'),
      },
    ]);
  };

  const manager = {
    createQueryBuilder: () => queryBuilder(),
    query: (_sql: string, parameters: unknown[]) => positionQuery(parameters),
    getRepository: (entity: unknown): unknown => {
      if (entity === Inventory) return inventoryRepository;
      if (entity === InventoryTransaction) return ledgerRepository;
      throw new Error('fake: the service asked for a repository this module does not own');
    },
  };

  const dataSource = {
    transaction: async <T>(run: (entityManager: unknown) => Promise<T>): Promise<T> => {
      depth += 1;
      trace.push('begin');
      try {
        return await run(manager);
      } finally {
        depth -= 1;
        trace.push('commit');
      }
    },
  };

  const queued: unknown[] = [];
  const notifications = {
    queue: (_manager: unknown, input: unknown) => {
      queued.push(input);
      return Promise.resolve();
    },
  };

  /**
   * `AuditLogService.record` takes the caller's open transaction and has no error channel of its
   * own, so the only thing to fake is the recording — and the `inTransaction` guard, which is the
   * assertion that matters: an audit row committed separately from the change it describes "can
   * outlive a write that rolled back, claiming a change that never happened".
   */
  const audited: unknown[] = [];
  const audit = {
    record: (_manager: unknown, input: unknown) => {
      inTransaction('the audit write');
      trace.push('audit');
      audited.push(input);
      return Promise.resolve();
    },
  };

  return {
    // `audit` needs no cast: the double is structurally an `AuditLogService`, which is the whole
    // shape of that service — one method taking the caller's manager.
    service: new InventoryService(dataSource as never, notifications as never, audit),
    stock,
    ledger,
    statements,
    trace,
    queued,
    audited,
  };
}

const adjustment = (overrides: Partial<Parameters<InventoryService['adjust']>[0]> = {}) => ({
  variantId: VARIANT,
  delta: -5,
  reason: 'Damaged in transit — 5 packs discarded',
  actorUserId: ACTOR,
  ...overrides,
});

describe('InventoryService.adjust', () => {
  it('moves the column by the signed delta', async () => {
    const { service, stock } = harness();

    const result = await service.adjust(adjustment({ delta: -5 }));

    expect(result.onHand).toBe(115);
    expect(stock[0]?.onHand).toBe(115);
  });

  it('adds stock for a positive delta', async () => {
    const { service, stock } = harness();

    await service.adjust(adjustment({ delta: 40 }));

    expect(stock[0]?.onHand).toBe(160);
  });

  /**
   * The ledger row is the audit trail Brief §32 asks for, and every field on it is load-bearing:
   * a row with the wrong sign, no reason or no actor is worse than no row, because it reads as
   * authoritative.
   */
  it('records one ADJUSTMENT row carrying the delta, the reason and the admin', async () => {
    const { service, ledger } = harness();

    await service.adjust(adjustment({ delta: -5 }));

    expect(ledger).toEqual([
      {
        variantId: VARIANT,
        delta: -5,
        type: InventoryTransactionType.ADJUSTMENT,
        reason: 'Damaged in transit — 5 packs discarded',
        balanceAfter: 115,
        orderId: null,
        actorUserId: ACTOR,
      },
    ]);
  });

  /**
   * `balanceAfter` is the denormalised half of the invariant Plan 1 pinned
   * (`SUM(delta) == onHand`), so it has to be the column's value *after* the update rather than a
   * figure computed alongside it. Read at a different moment — before the update, or from the
   * caller's input — it would agree with the column only by luck.
   *
   * Two variants with different starting stock, because a single row cannot tell
   * `balanceAfter: row.onHand` apart from a hardcoded 115.
   */
  it('stamps balanceAfter with the column as it stands after the update', async () => {
    const { service, ledger } = harness([
      { variantId: VARIANT, onHand: 7, reserved: 0, lowStockThreshold: 10 },
      { variantId: MISSING, onHand: 500, reserved: 0, lowStockThreshold: 10 },
    ]);

    await service.adjust(adjustment({ delta: 3 }));
    await service.adjust(adjustment({ variantId: MISSING, delta: -100 }));

    expect(ledger.map((row) => row.balanceAfter)).toEqual([10, 400]);
  });

  it('binds the delta as a parameter rather than interpolating it into the SQL', async () => {
    const { service, statements } = harness();

    await service.adjust(adjustment({ delta: -5 }));

    expect(statements[0]?.parameters).toEqual({ delta: -5, variantId: VARIANT });
    expect(statements[0]?.setExpressions.onHand).toContain(':delta');
    expect(statements[0]?.setExpressions.onHand).not.toContain('-5');
  });

  /**
   * The condition is what removes the read-then-write gap: two admins adjusting the same variant
   * cannot drive it below what is reserved, because the check and the write are one statement.
   *
   * Asserted as a recorded fragment here and as real behaviour against Postgres in the integration
   * spec — a fragment assertion pins the shape, not the semantics.
   */
  it('guards the update with the reserved floor in the same statement', async () => {
    const { service, statements } = harness();

    await service.adjust(adjustment({ delta: -5 }));

    expect(statements[0]?.conditions).toEqual([
      'variant_id = :variantId',
      '"onHand" + :delta >= reserved',
    ]);
  });

  /**
   * Not `updatedAt`, and not `reserved` either. `@UpdateDateColumn` makes TypeORM add
   * `updatedAt = CURRENT_TIMESTAMP` itself — the database's clock rather than whichever host
   * happened to serve the request — and an adjustment has no business touching what is reserved.
   */
  it('touches only the on-hand column', async () => {
    const { service, statements } = harness();

    await service.adjust(adjustment());

    expect(Object.keys(statements[0]?.setExpressions ?? {})).toEqual(['onHand']);
  });

  it('does the column write and the ledger insert inside one transaction', async () => {
    const { service, trace } = harness();

    await service.adjust(adjustment());

    expect(trace).toEqual(['begin', 'update', 'read', 'ledger', 'commit']);
  });

  /**
   * The existence lookup is the price of telling 404 apart from 409, and it is only worth paying
   * when something has already gone wrong. On the ordinary path it is a second round trip per
   * adjustment for an answer the `UPDATE` already gave.
   */
  it('does not spend the existence lookup on the successful path', async () => {
    const { service, trace } = harness();

    await service.adjust(adjustment());

    expect(trace).not.toContain('exists');
  });

  describe('when the adjustment would oversell reserved stock', () => {
    const reservedHarness = () =>
      harness([{ variantId: VARIANT, onHand: 10, reserved: 4, lowStockThreshold: 10 }]);

    it('rejects it as a conflict rather than clamping', async () => {
      const { service } = reservedHarness();

      await expect(service.adjust(adjustment({ delta: -7 }))).rejects.toMatchObject({
        code: 'OUT_OF_STOCK',
        status: HttpStatus.CONFLICT,
      });
    });

    it('names the variant and the delta the admin asked for', async () => {
      const { service } = reservedHarness();

      const error = await service
        .adjust(adjustment({ delta: -7 }))
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).details).toEqual({ variantId: VARIANT, delta: -7 });
    });

    it('leaves the column and the ledger untouched', async () => {
      const { service, stock, ledger } = reservedHarness();

      await expect(service.adjust(adjustment({ delta: -7 }))).rejects.toThrow(DomainError);

      expect(stock[0]?.onHand).toBe(10);
      expect(ledger).toEqual([]);
    });

    /** Down to exactly the reserved figure is allowed; the floor is `>=`, not `>`. */
    it('allows an adjustment that lands exactly on the reserved floor', async () => {
      const { service, stock } = reservedHarness();

      await service.adjust(adjustment({ delta: -6 }));

      expect(stock[0]?.onHand).toBe(4);
    });
  });

  describe('when the variant does not exist', () => {
    /**
     * The failure an admin is most likely to cause is a mistyped id, and the two zero-row causes
     * need different answers. Reporting this as `OUT_OF_STOCK` told them their correction would
     * oversell reserved orders — an explanation about stock levels for a row that has none.
     */
    it('answers NOT_FOUND rather than a stock conflict', async () => {
      const { service } = harness();

      await expect(service.adjust(adjustment({ variantId: MISSING }))).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: HttpStatus.NOT_FOUND,
      });
    });

    it('names the variant it could not find', async () => {
      const { service } = harness();

      const error = await service
        .adjust(adjustment({ variantId: MISSING }))
        .catch((thrown: unknown) => thrown);

      expect((error as DomainError).details).toEqual({ variantId: MISSING });
    });

    it('writes no ledger row', async () => {
      const { service, ledger } = harness();

      await expect(service.adjust(adjustment({ variantId: MISSING }))).rejects.toThrow(DomainError);

      expect(ledger).toEqual([]);
    });
  });

  describe('a delta of zero', () => {
    it('is refused as a validation failure', async () => {
      const { service } = harness();

      await expect(service.adjust(adjustment({ delta: 0 }))).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
    });

    it('is refused before a transaction is opened', async () => {
      const { service, trace } = harness();

      await expect(service.adjust(adjustment({ delta: 0 }))).rejects.toThrow(DomainError);

      expect(trace).toEqual([]);
    });

    /**
     * A fraction below one unit truncates to zero, and it has to reach the same refusal.
     *
     * The plan's own ordering tested `input.delta === 0` *before* truncating, so `0.4` passed the
     * guard, became `0`, and was written to the ledger as a successful adjustment that changed
     * nothing — an audit row asserting a movement that did not happen, and a 200 telling the admin
     * their correction landed. Whether `Math.trunc` is defensive or load-bearing, the two have to
     * agree on what zero means.
     */
    it('is what a fractional delta below one unit becomes, and is refused too', async () => {
      const { service, ledger, stock } = harness();

      await expect(service.adjust(adjustment({ delta: 0.4 }))).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });

      expect(ledger).toEqual([]);
      expect(stock[0]?.onHand).toBe(120);
    });
  });

  /**
   * Stock is whole packs. `@IsInt()` makes this unreachable over HTTP, so it pins the service's own
   * contract for the callers that do not come through the controller — a fractional delta reaching
   * the column would put a non-integer into an `int` and take the request down with a driver error.
   */
  it('truncates a fractional delta towards zero in both the column and the ledger', async () => {
    const { service, stock, ledger } = harness();

    await service.adjust(adjustment({ delta: -2.9 }));

    expect(stock[0]?.onHand).toBe(118);
    expect(ledger[0]?.delta).toBe(-2);
  });
});

describe('InventoryService.adjust — low stock', () => {
  it('queues stock.low when an adjustment crosses the threshold downward', async () => {
    const { service, queued } = harness([
      { variantId: VARIANT, onHand: 12, reserved: 0, lowStockThreshold: 10 },
    ]);

    await service.adjust(adjustment({ delta: -5 }));

    expect(queued).toEqual([
      {
        userId: null,
        channel: 'EMAIL',
        template: 'stock.low',
        payload: { variantId: VARIANT, onHand: 7, lowStockThreshold: 10 },
      },
    ]);
  });

  it('queues nothing when the adjustment stays above the threshold', async () => {
    const { service, queued } = harness([
      { variantId: VARIANT, onHand: 30, reserved: 0, lowStockThreshold: 10 },
    ]);

    await service.adjust(adjustment({ delta: -5 }));

    expect(queued).toEqual([]);
  });

  it('queues nothing for a positive adjustment, even one that starts below the threshold', async () => {
    const { service, queued } = harness([
      { variantId: VARIANT, onHand: 4, reserved: 0, lowStockThreshold: 10 },
    ]);

    await service.adjust(adjustment({ delta: 40 }));

    expect(queued).toEqual([]);
  });
});

/**
 * `setThreshold` — plan 9.2's answer to the gap plan 9.1 carried forward.
 *
 * Three of the four claims below are about something **not** happening, which is why they are worth
 * unit tests as well as integration ones: no ledger row, no notification, and no audit row for a
 * call that changed nothing. An endpoint that did all three would pass every assertion about the
 * threshold it returns.
 */
describe('InventoryService.setThreshold', () => {
  const ACTOR_INPUT = { lowStockThreshold: 25, actorUserId: ACTOR };

  it('writes the new threshold and answers with the resulting position', async () => {
    const { service, stock } = harness();

    const result = await service.setThreshold(VARIANT, ACTOR_INPUT);

    expect(stock[0]?.lowStockThreshold).toBe(25);
    expect(result).toMatchObject({ variantId: VARIANT, lowStockThreshold: 25, onHand: 120 });
  });

  /**
   * `low` in the reply is computed from the threshold that was just written, not the one that was
   * read — which is only true because the position read goes through the caller's manager and
   * therefore sees the uncommitted update. The fake's `inTransaction` guard is the other half.
   */
  it('reports the position against the new threshold, not the old one', async () => {
    const { service } = harness([
      { variantId: VARIANT, onHand: 8, reserved: 0, lowStockThreshold: 5 },
    ]);

    const result = await service.setThreshold(VARIANT, {
      lowStockThreshold: 20,
      actorUserId: ACTOR,
    });

    expect(result).toMatchObject({ available: 8, lowStockThreshold: 20, low: true });
  });

  /**
   * The audit row, inside the transaction, carrying both sides. `trace` is asserted rather than just
   * the row's presence: the order is what says the write and its attribution share a transaction,
   * and a `record` call moved outside would fail the fake's `inTransaction` guard instead.
   */
  it('records one audit row inside the transaction, naming both thresholds', async () => {
    const { service, audited, trace } = harness();

    await service.setThreshold(VARIANT, ACTOR_INPUT);

    expect(audited).toEqual([
      {
        actorUserId: ACTOR,
        action: 'inventory.update',
        entityType: 'inventory',
        entityId: VARIANT,
        before: { lowStockThreshold: 10 },
        after: { lowStockThreshold: 25 },
      },
    ]);
    expect(trace).toEqual(['begin', 'read', 'threshold', 'audit', 'position', 'commit']);
  });

  /** No stock moved, so `inventory_transactions` gains nothing. Plan 9.2's whole reason for a separate route. */
  it('writes no ledger row, because no stock moved', async () => {
    const { service, ledger, statements } = harness();

    await service.setThreshold(VARIANT, ACTOR_INPUT);

    expect(ledger).toEqual([]);
    expect(statements).toEqual([]);
  });

  /**
   * **The decision, pinned.** A threshold raised past `available` makes the variant low by spec §12's
   * card rule and queues nothing, because `stock.low` is an event about stock moving and no stock
   * moved. `InventoryService.setThreshold`'s docblock carries the full reasoning; this is what would
   * fail if someone wired `checkLowStock` into the threshold path with a `delta` of zero.
   */
  it('queues no stock.low even when the new threshold makes the variant low', async () => {
    const { service, queued } = harness([
      { variantId: VARIANT, onHand: 8, reserved: 0, lowStockThreshold: 5 },
    ]);

    const result = await service.setThreshold(VARIANT, {
      lowStockThreshold: 30,
      actorUserId: ACTOR,
    });

    expect(result.low).toBe(true);
    expect(queued).toEqual([]);
  });

  /** Plan 9.1's rule: a write that changes nothing writes no audit row, idempotent calls included. */
  it('writes nothing at all when the threshold is already the requested value', async () => {
    const { service, audited, trace } = harness();

    const result = await service.setThreshold(VARIANT, {
      lowStockThreshold: 10,
      actorUserId: ACTOR,
    });

    expect(result.lowStockThreshold).toBe(10);
    expect(audited).toEqual([]);
    expect(trace).toEqual(['begin', 'read', 'position', 'commit']);
  });

  it('refuses a variant that does not exist with NOT_FOUND', async () => {
    const { service, audited } = harness();

    await expect(service.setThreshold(MISSING, ACTOR_INPUT)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: HttpStatus.NOT_FOUND,
    });
    expect(audited).toEqual([]);
  });
});
