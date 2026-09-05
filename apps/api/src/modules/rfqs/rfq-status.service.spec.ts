// backend/src/modules/rfqs/rfq-status.service.spec.ts
import { HttpStatus } from '@nestjs/common';
import { AuditAction, AuditEntity, type AuditLogInput } from '../admin/audit-log.service';
import { RfqStatusService } from './rfq-status.service';

const RFQ_NUMBER = 'RFQ-2026-100000';
const ADMIN = 'admin-1';

interface RfqPatch {
  status?: string;
}

function harness(rfq: { status: string; userId?: string | null; updateAffected?: number }) {
  const recorded: {
    queued: unknown[];
    patch: RfqPatch | null;
    audited: AuditLogInput[];
    auditManagers: unknown[];
    opened: number;
  } = { queued: [], patch: null, audited: [], auditManagers: [], opened: 0 };

  const manager = {
    getRepository: () => ({
      findOne: (options: { where?: { rfqNumber?: string } }) =>
        Promise.resolve(
          options.where?.rfqNumber === RFQ_NUMBER
            ? { id: 'rfq-1', rfqNumber: RFQ_NUMBER, status: rfq.status, userId: rfq.userId ?? null }
            : null,
        ),
      update: (_criteria: unknown, patch: RfqPatch) => {
        recorded.patch = patch;
        return Promise.resolve({ affected: rfq.updateAffected ?? 1 });
      },
    }),
  };

  const dataSource = {
    transaction: <T>(run: (m: unknown) => Promise<T>) => {
      recorded.opened += 1;
      return run(manager);
    },
  };
  const notifications = {
    queue: (_manager: unknown, input: unknown) => {
      recorded.queued.push(input);
      return Promise.resolve();
    },
  };
  /**
   * Records the manager it was handed as well as the input.
   *
   * `AuditLogService.record` takes the caller's open transaction and nothing else, so the assertion
   * that matters is not only *what* was recorded but *on which manager* — a mutation that wrapped
   * the audit call around `transition` instead of inside it would still write a row and satisfy
   * every assertion about its contents. `admin-orders.service.spec.ts` records the same reasoning.
   */
  const audit = {
    record: (givenManager: unknown, input: AuditLogInput) => {
      recorded.auditManagers.push(givenManager);
      recorded.audited.push(input);
      return Promise.resolve();
    },
  };

  return {
    service: new RfqStatusService(dataSource as never, notifications as never, audit),
    recorded,
    manager,
  };
}

describe('RfqStatusService.transition', () => {
  it('moves a new RFQ to contacted and queues rfq.status-changed', async () => {
    const { service, recorded } = harness({ status: 'new', userId: 'user-1' });

    const result = await service.transition(RFQ_NUMBER, 'contacted');

    expect(result).toEqual({ rfqId: 'rfq-1', rfqNumber: RFQ_NUMBER, from: 'new', to: 'contacted' });
    expect(recorded.patch).toEqual({ status: 'contacted' });
    expect(recorded.queued).toEqual([
      {
        userId: 'user-1',
        channel: 'EMAIL',
        template: 'rfq.status-changed',
        payload: { rfqNumber: RFQ_NUMBER, from: 'new', to: 'contacted' },
      },
    ]);
  });

  it('carries a null userId through to the notification for a prospect with no account', async () => {
    const { service, recorded } = harness({ status: 'new', userId: null });

    await service.transition(RFQ_NUMBER, 'rejected');

    expect(recorded.queued).toEqual([expect.objectContaining({ userId: null })]);
  });

  it('refuses an illegal transition with 422, and queues nothing', async () => {
    const { service, recorded } = harness({ status: 'new' });

    await expect(service.transition(RFQ_NUMBER, 'approved')).rejects.toMatchObject({
      code: 'ILLEGAL_STATUS_TRANSITION',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
    expect(recorded.queued).toEqual([]);
    expect(recorded.patch).toBeNull();
  });

  it('names the statuses that were available instead', async () => {
    const { service } = harness({ status: 'quote-sent' });

    const error = await service.transition(RFQ_NUMBER, 'new').catch((thrown: unknown) => thrown);

    expect((error as { details?: unknown }).details).toEqual({
      rfqNumber: RFQ_NUMBER,
      from: 'quote-sent',
      to: 'new',
      allowed: ['negotiation', 'approved', 'rejected'],
    });
  });

  it('refuses a terminal RFQ moving anywhere at all', async () => {
    const { service } = harness({ status: 'converted' });

    await expect(service.transition(RFQ_NUMBER, 'contacted')).rejects.toMatchObject({
      code: 'ILLEGAL_STATUS_TRANSITION',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
  });

  it('refuses a no-op transition to the status the RFQ already holds', async () => {
    const { service } = harness({ status: 'contacted' });

    await expect(service.transition(RFQ_NUMBER, 'contacted')).rejects.toMatchObject({
      code: 'ILLEGAL_STATUS_TRANSITION',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
  });

  it('answers 404 for an rfqNumber it does not recognise', async () => {
    const { service } = harness({ status: 'new' });

    await expect(service.transition('RFQ-2026-999999', 'contacted')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: HttpStatus.NOT_FOUND,
    });
  });

  it('answers 409 when the row moved under the caller between the read and the write', async () => {
    const { service } = harness({ status: 'new', updateAffected: 0 });

    await expect(service.transition(RFQ_NUMBER, 'contacted')).rejects.toMatchObject({
      code: 'ILLEGAL_STATUS_TRANSITION',
      status: HttpStatus.CONFLICT,
    });
  });
});

/**
 * The two options plan 9.3 added, mirroring what plan 9.2 did to `OrderStatusService` — and the
 * reason both exist is atomicity, which a unit double can only prove the *wiring* of.
 * `admin-rfqs.integration.spec.ts` proves the rollback against a real transaction.
 */
describe('RfqStatusService.transition options', () => {
  it('writes no audit row when none is asked for', async () => {
    const { service, recorded } = harness({ status: 'new' });

    await service.transition(RFQ_NUMBER, 'contacted');

    expect(recorded.audited).toEqual([]);
  });

  it('records the move on the transition’s own manager, never on another', async () => {
    const { service, recorded, manager } = harness({ status: 'new' });

    await service.transition(RFQ_NUMBER, 'contacted', { audit: { actorUserId: ADMIN } });

    expect(recorded.audited).toEqual([
      {
        actorUserId: ADMIN,
        action: AuditAction.RFQ_STATUS_CHANGE,
        entityType: AuditEntity.RFQ,
        entityId: 'rfq-1',
        before: { status: 'new' },
        after: { status: 'contacted', rfqNumber: RFQ_NUMBER },
      },
    ]);
    expect(recorded.auditManagers).toEqual([manager]);
  });

  it('writes no audit row for a refused transition', async () => {
    const { service, recorded } = harness({ status: 'new' });

    await expect(
      service.transition(RFQ_NUMBER, 'approved', { audit: { actorUserId: ADMIN } }),
    ).rejects.toMatchObject({ code: 'ILLEGAL_STATUS_TRANSITION' });

    expect(recorded.audited).toEqual([]);
    expect(recorded.patch).toBeNull();
  });

  it('writes no audit row when the row moved under the caller', async () => {
    const { service, recorded } = harness({ status: 'new', updateAffected: 0 });

    await expect(
      service.transition(RFQ_NUMBER, 'contacted', { audit: { actorUserId: ADMIN } }),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });

    expect(recorded.audited).toEqual([]);
  });

  /**
   * The caller that passes `manager` owns the transaction, so opening a second one here would put
   * the status write outside the caller's rollback — which is the whole failure the option exists
   * to prevent.
   */
  it('joins a caller’s transaction instead of opening its own', async () => {
    const { service, recorded, manager } = harness({ status: 'new' });

    await service.transition(RFQ_NUMBER, 'contacted', {
      manager: manager as never,
      audit: { actorUserId: ADMIN },
    });

    expect(recorded.opened).toBe(0);
    expect(recorded.patch).toEqual({ status: 'contacted' });
    expect(recorded.auditManagers).toEqual([manager]);
  });

  it('opens its own transaction when no manager is given', async () => {
    const { service, recorded } = harness({ status: 'new' });

    await service.transition(RFQ_NUMBER, 'contacted');

    expect(recorded.opened).toBe(1);
  });
});
