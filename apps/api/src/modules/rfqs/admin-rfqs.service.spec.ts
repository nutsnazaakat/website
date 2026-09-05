import { HttpStatus } from '@nestjs/common';
import { toPaise } from '@nutwala/shared';
import type { Rfq } from '../../entities/b2b/rfq.entity';
import { RfqKind, UserRole } from '../../entities/enums';
import type { User } from '../../entities/identity/user.entity';
import { AuditAction, AuditEntity, type AuditLogInput } from '../admin/audit-log.service';
import { AdminRfqsService } from './admin-rfqs.service';
import type { RfqStatusService } from './rfq-status.service';

const RFQ_NUMBER = 'RFQ-2026-000123';
const ADMIN = 'f0000000-0000-4000-8000-00000000000c';

const rfq = (overrides: Partial<Rfq> = {}): Rfq =>
  ({
    id: 'rfq-1',
    rfqNumber: RFQ_NUMBER,
    userId: null,
    kind: RfqKind.BULK,
    businessName: 'Anand Sweets',
    contactPerson: 'Ravi Kumar',
    mobile: '9812345670',
    email: 'ravi@anandsweets.in',
    gstin: null,
    businessType: 'Sweet shop',
    pincode: '560058',
    packaging: 'Vacuum pack',
    frequency: 'Monthly',
    notes: null,
    status: 'new',
    assignedSalespersonId: null,
    expectedValuePaise: null,
    items: [],
    notesList: [],
    gifting: null,
    createdAt: new Date('2026-08-18T06:00:00.000Z'),
    updatedAt: new Date('2026-08-18T06:00:00.000Z'),
    ...overrides,
  }) as unknown as Rfq;

/** Records the statement the list builds. `admin-orders.service.spec.ts` carries the same double
 * for the same reason: which predicates, which order, which window and which relations are the
 * whole of the list's behaviour, and none of it shows in the rows a repository double returns. */
function queryBuilder(rows: Rfq[]) {
  const where: { clause: string; parameters: Record<string, unknown> }[] = [];
  const joins: string[] = [];
  const order: [string, string][] = [];
  const window: { skip?: number; take?: number } = {};
  const builder = {
    leftJoinAndSelect: (relation: string, alias: string) => {
      joins.push(`${relation} ${alias}`);
      return builder;
    },
    andWhere: (clause: string, parameters: Record<string, unknown>) => {
      where.push({ clause, parameters });
      return builder;
    },
    orderBy: (column: string, direction: string) => {
      order.push([column, direction]);
      return builder;
    },
    addOrderBy: (column: string, direction: string) => {
      order.push([column, direction]);
      return builder;
    },
    skip: (value: number) => {
      window.skip = value;
      return builder;
    },
    take: (value: number) => {
      window.take = value;
      return builder;
    },
    getManyAndCount: () => Promise.resolve<[Rfq[], number]>([rows, rows.length]),
  };
  return { builder, where, joins, order, window };
}

/**
 * The transaction's manager, recording what was written through it.
 *
 * `AuditLogService.record` takes the caller's open transaction and nothing else, so the assertion
 * that matters is not only *what* was recorded but *on which manager*: a mutation that wrapped the
 * audit call around the transaction rather than inside it would still write a row and satisfy every
 * assertion about its contents. Only Postgres can prove the rollback; this proves the wiring.
 */
function transactionManager(rfq: Rfq | null, salesperson: User | null) {
  const updates: { criteria: unknown; patch: unknown }[] = [];
  const saved: Record<string, unknown>[] = [];
  const manager = {
    getRepository: (entity: { name: string }) => ({
      findOne: () => Promise.resolve(entity.name === 'User' ? salesperson : rfq),
      update: (criteria: unknown, patch: unknown) => {
        updates.push({ criteria, patch });
        return Promise.resolve({ affected: 1 });
      },
      create: (row: Record<string, unknown>) => row,
      save: (row: Record<string, unknown>) =>
        Promise.resolve(saved.push(row) && { id: 'note-1', ...row }),
    }),
  };
  return { manager, updates, saved };
}

function harness(
  options: {
    listed?: Rfq[];
    found?: Rfq | null;
    salesperson?: User | null;
    transitionThrows?: Error;
  } = {},
) {
  const built = queryBuilder(options.listed ?? []);
  const findOne = jest.fn().mockResolvedValue(options.found ?? null);
  const find = jest.fn().mockResolvedValue([]);
  const transaction = transactionManager(options.found ?? null, options.salesperson ?? null);
  const dataSource = {
    getRepository: () => ({
      createQueryBuilder: () => built.builder,
      findOne,
      find,
    }),
    transaction: <T>(run: (manager: unknown) => Promise<T>) => run(transaction.manager),
  };
  const statuses = {
    transition: jest.fn().mockImplementation(() => {
      if (options.transitionThrows) return Promise.reject(options.transitionThrows);
      return Promise.resolve({
        rfqId: 'rfq-1',
        rfqNumber: RFQ_NUMBER,
        from: 'new',
        to: 'contacted',
      });
    }),
  };
  const audited: AuditLogInput[] = [];
  const auditManagers: unknown[] = [];
  const audit = {
    record: (givenManager: unknown, input: AuditLogInput) => {
      auditManagers.push(givenManager);
      audited.push(input);
      return Promise.resolve();
    },
  };

  return {
    service: new AdminRfqsService(
      dataSource as never,
      statuses as unknown as RfqStatusService,
      audit,
    ),
    built,
    findOne,
    find,
    statuses,
    audited,
    auditManagers,
    transaction,
  };
}

describe('AdminRfqsService.list', () => {
  it('joins the lines, because brief §34 makes them two of the row’s own columns', async () => {
    const context = harness();
    await context.service.list({});
    expect(context.built.joins).toEqual(['rfq.items item']);
  });

  it('filters by status and by kind through the column enum', async () => {
    const context = harness();
    await context.service.list({ status: 'quote-sent', kind: 'gifting' });

    expect(context.built.where).toEqual([
      { clause: 'rfq.status = :status', parameters: { status: 'quote-sent' } },
      { clause: 'rfq.kind = :kind', parameters: { kind: RfqKind.GIFTING } },
    ]);
  });

  /** The RFQ number is searchable because quoting it to the sales desk is the only recovery path a
   * prospect with no account has — `RfqsController` records that in as many words. */
  it('searches the RFQ number, the business, the contact and the email', async () => {
    const context = harness();
    await context.service.list({ q: ' RFQ-2026 ' });
    const clause = context.built.where.find((entry) => entry.clause.includes('ILIKE'));
    expect(clause?.clause).toContain('rfq.rfqNumber ILIKE :q');
    expect(clause?.clause).toContain('rfq.businessName ILIKE :q');
    expect(clause?.clause).toContain('rfq.contactPerson ILIKE :q');
    expect(clause?.clause).toContain('rfq.email ILIKE :q');
    expect(clause?.parameters).toEqual({ q: '%RFQ-2026%' });
  });

  it('ignores a blank search rather than matching every row against "%%"', async () => {
    const context = harness();
    await context.service.list({ q: '  ' });
    expect(context.built.where).toEqual([]);
  });

  /**
   * `@CreateDateColumn` defaults to `now()`, which is transaction-start time, so a batch written
   * together shares one timestamp exactly. `rfqNumber` carries `uq_rfqs_rfq_number`, which makes
   * it arbitrary but total — the property paging needs.
   */
  it('orders newest first with a total tiebreak', async () => {
    const context = harness();
    await context.service.list({});
    expect(context.built.order).toEqual([
      ['rfq.createdAt', 'DESC'],
      ['rfq.rfqNumber', 'DESC'],
    ]);
  });

  it('clamps the page window and reports what it used', async () => {
    const context = harness();
    const page = await context.service.list({ page: 4, limit: 999 });
    expect(context.built.window).toEqual({ skip: 180, take: 60 });
    expect(page).toMatchObject({ page: 4, limit: 60 });
  });

  it('reads no salespeople when no row names one', async () => {
    const context = harness({ listed: [rfq()] });
    await context.service.list({});
    expect(context.find).not.toHaveBeenCalled();
  });

  it('reads each named salesperson once, however many rows name them', async () => {
    const context = harness({
      listed: [
        rfq({ assignedSalespersonId: 'admin-1' }),
        rfq({ rfqNumber: 'RFQ-2026-000124', assignedSalespersonId: 'admin-1' }),
      ],
    });
    await context.service.list({});
    expect(context.find).toHaveBeenCalledTimes(1);
    expect(context.find).toHaveBeenCalledWith({ where: { id: expect.anything() as unknown } });
  });
});

describe('AdminRfqsService.get', () => {
  it('answers 404 naming the reference for an unknown RFQ number', async () => {
    const context = harness({ found: null });
    await expect(context.service.get('RFQ-2026-999999')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: HttpStatus.NOT_FOUND,
    });
  });

  /**
   * `notesList` is loaded **here and nowhere else**: `RfqsService.findOne` deliberately omits it,
   * because `rfq-note.entity.ts` says internal notes are never exposed on a customer-facing
   * endpoint. Newest first, because an operator picking up an enquiry reads the last thing said
   * about it.
   */
  it('loads the lines, the gifting detail and the note history newest first', async () => {
    const context = harness({ found: rfq() });
    await context.service.get(RFQ_NUMBER);

    expect(context.findOne).toHaveBeenCalledWith({
      where: { rfqNumber: RFQ_NUMBER },
      relations: { items: true, gifting: true, notesList: { authorUser: true } },
      order: { notesList: { createdAt: 'DESC', id: 'DESC' } },
    });
  });

  it('answers the detail shape', async () => {
    const context = harness({ found: rfq() });
    const detail = await context.service.get(RFQ_NUMBER);
    expect(detail).toMatchObject({ id: RFQ_NUMBER, status: 'new', internalNotes: [] });
  });
});

describe('AdminRfqsService.update', () => {
  /**
   * Everything about the move is `RfqStatusService`'s: the legality check against
   * `RFQ_TRANSITIONS`, the guarded `UPDATE`, the notification and the `rfq.status-change` audit
   * row. What this method contributes is the actor, the transaction to join, and the reply.
   */
  it('moves the status through RfqStatusService, on this transaction, with the audit request', async () => {
    const context = harness({ found: rfq() });

    await context.service.update(RFQ_NUMBER, { status: 'contacted', actorUserId: ADMIN });

    expect(context.statuses.transition).toHaveBeenCalledWith(RFQ_NUMBER, 'contacted', {
      manager: context.transaction.manager,
      audit: { actorUserId: ADMIN },
    });
  });

  it('writes nothing at all for a body that names no field', async () => {
    const context = harness({ found: rfq() });

    await context.service.update(RFQ_NUMBER, { actorUserId: ADMIN });

    expect(context.statuses.transition).not.toHaveBeenCalled();
    expect(context.transaction.updates).toEqual([]);
    expect(context.audited).toEqual([]);
  });

  /** Plan 9.1's rule: a write that changes nothing leaves no trace. */
  it('writes no audit row for a field set to the value it already holds', async () => {
    const context = harness({
      found: rfq({ assignedSalespersonId: ADMIN, expectedValuePaise: toPaise(500) }),
      salesperson: { id: ADMIN, role: UserRole.ADMIN } as unknown as User,
    });

    await context.service.update(RFQ_NUMBER, {
      assignedSalespersonId: ADMIN,
      expectedValue: 500,
      actorUserId: ADMIN,
    });

    expect(context.transaction.updates).toEqual([]);
    expect(context.audited).toEqual([]);
  });

  it('records the field change on this transaction’s manager, with paise as strings', async () => {
    const context = harness({ found: rfq() });

    await context.service.update(RFQ_NUMBER, { expectedValue: 84500, actorUserId: ADMIN });

    expect(context.transaction.updates).toEqual([
      { criteria: { id: 'rfq-1' }, patch: { expectedValuePaise: toPaise(84500) } },
    ]);
    expect(context.audited).toEqual([
      {
        actorUserId: ADMIN,
        action: AuditAction.RFQ_UPDATE,
        entityType: AuditEntity.RFQ,
        entityId: 'rfq-1',
        before: { expectedValuePaise: null },
        after: { expectedValuePaise: '8450000', rfqNumber: RFQ_NUMBER },
      },
    ]);
    expect(context.auditManagers).toEqual([context.transaction.manager]);
  });

  /**
   * `audit_logs.before`/`.after` are jsonb, and `JSON.stringify` **throws** on a bigint rather than
   * dropping it — so a raw paise value in the payload would fail the whole transaction at the
   * driver. Asserted directly, because the failure would look like a database problem.
   */
  it('produces an audit payload that survives JSON serialisation', async () => {
    const context = harness({ found: rfq({ expectedValuePaise: toPaise(100) }) });

    await context.service.update(RFQ_NUMBER, { expectedValue: 200, actorUserId: ADMIN });

    expect(() => JSON.stringify(context.audited[0])).not.toThrow();
  });

  it('clears the expected value when told null, and distinguishes that from omitting it', async () => {
    const cleared = harness({ found: rfq({ expectedValuePaise: toPaise(500) }) });
    await cleared.service.update(RFQ_NUMBER, { expectedValue: null, actorUserId: ADMIN });
    expect(cleared.transaction.updates).toEqual([
      { criteria: { id: 'rfq-1' }, patch: { expectedValuePaise: null } },
    ]);

    const untouched = harness({ found: rfq({ expectedValuePaise: toPaise(500) }) });
    await untouched.service.update(RFQ_NUMBER, { actorUserId: ADMIN });
    expect(untouched.transaction.updates).toEqual([]);
  });

  /**
   * `business.entity.ts` settled that a salesperson is "an admin user, not a separate staff table",
   * and the column is a bare `users(id)` reference — so nothing at the database level stops an
   * enquiry being assigned to a customer.
   */
  it('refuses a salesperson who is not an admin, with the same 404 an unknown id gets', async () => {
    const context = harness({ found: rfq(), salesperson: null });

    await expect(
      context.service.update(RFQ_NUMBER, {
        assignedSalespersonId: 'f0000000-0000-4000-8000-0000000000ff',
        actorUserId: ADMIN,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: HttpStatus.NOT_FOUND });

    expect(context.transaction.updates).toEqual([]);
    expect(context.audited).toEqual([]);
  });

  /** The transition goes first, so a refusal costs no write — `AdminOrdersService.createShipment`
   * orders its own work the same way for the same reason. */
  it('writes no field change when the status move is refused', async () => {
    const refusal = Object.assign(new Error('illegal'), { code: 'ILLEGAL_STATUS_TRANSITION' });
    const context = harness({ found: rfq(), transitionThrows: refusal });

    await expect(
      context.service.update(RFQ_NUMBER, {
        status: 'approved',
        expectedValue: 999,
        actorUserId: ADMIN,
      }),
    ).rejects.toThrow('illegal');

    expect(context.transaction.updates).toEqual([]);
    expect(context.audited).toEqual([]);
  });
});

describe('AdminRfqsService.addNote', () => {
  it('writes the note to rfq_notes and never touches rfqs.notes', async () => {
    const context = harness({ found: rfq({ notes: 'Please quote for jute sacks.' }) });

    await context.service.addNote(RFQ_NUMBER, { body: '  Rang the buyer.  ', actorUserId: ADMIN });

    expect(context.transaction.saved).toEqual([
      { rfqId: 'rfq-1', authorUserId: ADMIN, body: 'Rang the buyer.' },
    ]);
    // Not one `UPDATE` on `rfqs` — the prospect's own notes column is left exactly as it was.
    expect(context.transaction.updates).toEqual([]);
  });

  it('records the note on this transaction’s manager, carrying its id and not its body', async () => {
    const context = harness({ found: rfq() });

    await context.service.addNote(RFQ_NUMBER, {
      body: 'Buyer is price-sensitive; hold at 620/kg.',
      actorUserId: ADMIN,
    });

    expect(context.audited).toEqual([
      {
        actorUserId: ADMIN,
        action: AuditAction.RFQ_NOTE_ADD,
        entityType: AuditEntity.RFQ,
        entityId: 'rfq-1',
        after: { noteId: 'note-1', rfqNumber: RFQ_NUMBER },
      },
    ]);
    expect(JSON.stringify(context.audited)).not.toContain('price-sensitive');
    expect(context.auditManagers).toEqual([context.transaction.manager]);
  });

  /** `@MinLength(1)` cannot see through surrounding whitespace, and a note with no content still
   * appears in the history as though something was said. */
  it('refuses a body that is only whitespace', async () => {
    const context = harness({ found: rfq() });

    await expect(
      context.service.addNote(RFQ_NUMBER, { body: '   \n ', actorUserId: ADMIN }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: HttpStatus.BAD_REQUEST });

    expect(context.transaction.saved).toEqual([]);
  });

  it('answers 404 for an unknown RFQ number and writes nothing', async () => {
    const context = harness({ found: null });

    await expect(
      context.service.addNote('RFQ-2026-999999', { body: 'Called.', actorUserId: ADMIN }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: HttpStatus.NOT_FOUND });

    expect(context.transaction.saved).toEqual([]);
    expect(context.audited).toEqual([]);
  });
});
