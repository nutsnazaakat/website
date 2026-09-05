// backend/src/modules/admin/audit-log.service.spec.ts
import { AuditLog } from '../../entities/ops/audit-log.entity';
import { AuditAction, AuditEntity, AuditLogService, type AuditLogInput } from './audit-log.service';

/** `'ok'`, or the error the write should fail with — asynchronously, then synchronously. */
type WriteAnswer = 'ok' | { rejectsWith: Error } | { throwsWith: Error };

function harness(writeAnswer: WriteAnswer = 'ok') {
  const written: Record<string, unknown>[] = [];
  const repositoriesAskedFor: unknown[] = [];
  const transaction = jest.fn();
  let connectionReads = 0;

  const manager = {
    getRepository: (target: unknown) => {
      repositoriesAskedFor.push(target);
      return {
        save: (row: Record<string, unknown>) => {
          if (writeAnswer !== 'ok' && 'throwsWith' in writeAnswer) throw writeAnswer.throwsWith;
          if (writeAnswer !== 'ok') return Promise.reject(writeAnswer.rejectsWith);
          written.push(row);
          return Promise.resolve({ ...row, id: 'audit-1' });
        },
      };
    },
    // Nothing legitimate reaches for either of these. They exist so the test can prove it.
    transaction,
    get connection() {
      connectionReads += 1;
      return { transaction };
    },
  };

  return {
    service: new AuditLogService(),
    manager,
    written,
    repositoriesAskedFor,
    transaction,
    connectionReads: () => connectionReads,
  };
}

const INPUT: AuditLogInput = {
  actorUserId: 'admin-1',
  action: AuditAction.PRODUCT_UPDATE,
  entityType: AuditEntity.PRODUCT,
  entityId: 'product-1',
  before: { mrpPaise: 129900 },
  after: { mrpPaise: 119900 },
};

describe('AuditLogService.record', () => {
  it('writes one audit_logs row through the manager it was handed', async () => {
    const { service, manager, written, repositoriesAskedFor } = harness();

    await service.record(manager as never, INPUT);

    expect(repositoriesAskedFor).toEqual([AuditLog]);
    expect(written).toEqual([
      {
        actorUserId: 'admin-1',
        action: 'product.update',
        // The input says `entityType`; the column is `entity`. This is the mapping.
        entity: 'product',
        entityId: 'product-1',
        before: { mrpPaise: 129900 },
        after: { mrpPaise: 119900 },
        ip: null,
        userAgent: null,
      },
    ]);
  });

  it('stores an omitted before/after as null rather than leaving the column undefined', async () => {
    const { service, manager, written } = harness();

    await service.record(manager as never, {
      actorUserId: 'admin-1',
      action: AuditAction.PRODUCT_CREATE,
      entityType: AuditEntity.PRODUCT,
      entityId: 'product-2',
    });

    expect(written[0]).toEqual(
      expect.objectContaining({ before: null, after: null, action: 'product.create' }),
    );
  });

  /**
   * The contract, and the only reason this service takes a `manager` at all.
   *
   * An audit row committed separately from the change it describes can outlive a rolled-back write
   * or be lost while the write survives, and both are worse than no audit trail because both get
   * trusted. `NotificationsService.queue` states the identical reasoning for the identical shape.
   *
   * Two things are asserted, because either one alone is escapable. The behavioural half: neither
   * `manager.transaction` nor `manager.connection` is touched, so the write lands in whatever
   * transaction the caller already had open. The structural half: the service has no constructor
   * argument, so it holds no `DataSource` and no repository and therefore has nothing to open a
   * transaction *with* — injecting one is what a later edit reaching for a convenience overload
   * would have to do first, and that is what this catches.
   */
  it('uses the caller transaction and never opens one of its own', async () => {
    const { service, manager, transaction, connectionReads } = harness();

    await service.record(manager as never, INPUT);

    expect(transaction).not.toHaveBeenCalled();
    expect(connectionReads()).toBe(0);
    expect(AuditLogService.length).toBe(0);
  });

  /**
   * The one deliberate divergence from `NotificationsService.queue`, which catches a driver failure
   * and records `FAILED` so a broken notification cannot undo a real order.
   *
   * Audit must not do that. An admin mutation whose audit row failed to write is a mutation nobody
   * can attribute afterwards, and swallowing the error here would commit exactly that — the change
   * applied, no trace of who made it, and a green response telling the operator it went fine. So
   * the rejection propagates and takes the caller's transaction with it.
   */
  it('propagates a rejected write instead of swallowing it', async () => {
    const failure = new Error('null value in column "actor_user_id" violates not-null constraint');
    const { service, manager } = harness({ rejectsWith: failure });

    await expect(service.record(manager as never, INPUT)).rejects.toBe(failure);
  });

  it('propagates a write that throws synchronously as a rejection', async () => {
    const failure = new Error('connection terminated unexpectedly');
    const { service, manager } = harness({ throwsWith: failure });

    await expect(service.record(manager as never, INPUT)).rejects.toBe(failure);
  });
});
