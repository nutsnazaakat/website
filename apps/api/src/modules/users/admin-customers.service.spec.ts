import { HttpStatus } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain-error';
import { UserRole } from '../../entities/enums';
import type { Address } from '../../entities/identity/address.entity';
import type { Business } from '../../entities/identity/business.entity';
import type { User } from '../../entities/identity/user.entity';
import { AdminCustomersService } from './admin-customers.service';

const CUSTOMER_ID = 'f0000000-0000-4000-8000-00000000000a';

const row = (overrides: Partial<User> = {}): User =>
  ({
    id: CUSTOMER_ID,
    name: 'Asha Rao',
    email: 'asha@demo.in',
    phone: '9876543210',
    role: UserRole.CUSTOMER,
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date('2026-01-04T09:12:00.000Z'),
    updatedAt: new Date('2026-01-04T09:12:00.000Z'),
    ...overrides,
  }) as unknown as User;

/**
 * A query builder that records what was asked of it.
 *
 * The list's whole behaviour is the statement it builds — which predicates, which order, which
 * window — and none of that is visible in the rows a repository double hands back.
 * `admin-orders.service.spec.ts` carries the same double for the same reason: a dropped
 * `addOrderBy` or a filter wired to the wrong column fails here rather than only against Postgres.
 */
function queryBuilder(rows: User[]) {
  const where: { clause: string; parameters: Record<string, unknown> }[] = [];
  const order: [string, string][] = [];
  const window: { skip?: number; take?: number } = {};
  const builder = {
    where: (clause: string, parameters: Record<string, unknown>) => {
      where.push({ clause, parameters });
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
    getManyAndCount: () => Promise.resolve<[User[], number]>([rows, rows.length]),
  };
  return { builder, where, order, window };
}

interface TotalsRow {
  userId: string;
  orders: number;
  spend: string;
  lastOrderAt: Date | null;
}

function harness(
  options: {
    listed?: User[];
    found?: User | null;
    totals?: TotalsRow[];
    addresses?: Address[];
    business?: Business | null;
  } = {},
) {
  const built = queryBuilder(options.listed ?? []);
  const queries: { sql: string; parameters: unknown[] }[] = [];
  const users = {
    createQueryBuilder: jest.fn().mockReturnValue(built.builder),
    findOne: jest.fn().mockResolvedValue(options.found ?? null),
  };
  const businesses = { findOne: jest.fn().mockResolvedValue(options.business ?? null) };
  const addresses = { find: jest.fn().mockResolvedValue(options.addresses ?? []) };
  const dataSource = {
    query: (sql: string, parameters: unknown[]) => {
      queries.push({ sql, parameters });
      return Promise.resolve(options.totals ?? []);
    },
  };
  return {
    service: new AdminCustomersService(
      users as never,
      businesses as never,
      addresses as never,
      dataSource as never,
    ),
    users,
    businesses,
    addresses,
    queries,
    built,
  };
}

describe('AdminCustomersService.list', () => {
  /**
   * The filter that keeps this list agreeing with `GET /admin/dashboard`'s `customers` card, which
   * counts `role <> 'ADMIN'`. Asserted on the built statement rather than on the rows, because a
   * repository double would hand back whatever it was given whichever predicate was applied.
   */
  it('excludes admins from every page', async () => {
    const context = harness();
    await context.service.list({});
    expect(context.built.where[0]?.clause).toContain('user.role != :admin');
    expect(context.built.where[0]?.parameters).toEqual({ admin: UserRole.ADMIN });
  });

  it('filters by the wire role through the column enum, never by the wire string', async () => {
    const context = harness();
    await context.service.list({ role: 'b2b' });
    const clause = context.built.where.find((entry) => entry.clause === 'user.role = :role');
    expect(clause?.parameters).toEqual({ role: UserRole.BUSINESS });
  });

  it('searches name, email and phone with one parameter', async () => {
    const context = harness();
    await context.service.list({ q: '  asha ' });
    const clause = context.built.where.find((entry) => entry.clause.includes('ILIKE'));
    expect(clause?.clause).toContain('user.name ILIKE :q');
    expect(clause?.clause).toContain('user.email ILIKE :q');
    expect(clause?.clause).toContain('user.phone ILIKE :q');
    expect(clause?.parameters).toEqual({ q: '%asha%' });
  });

  it('ignores a blank search rather than matching every row against "%%"', async () => {
    const context = harness();
    await context.service.list({ q: '   ' });
    expect(context.built.where.some((entry) => entry.clause.includes('ILIKE'))).toBe(false);
  });

  /**
   * `users.createdAt` is not unique — the seeder writes its accounts in one transaction and
   * Postgres's `now()` is transaction-start time — so an unstable tiebreak over `LIMIT`/`OFFSET`
   * returns the same customer on two pages and loses another entirely.
   */
  it('orders newest first with a total tiebreak', async () => {
    const context = harness();
    await context.service.list({});
    expect(context.built.order).toEqual([
      ['user.createdAt', 'DESC'],
      ['user.id', 'DESC'],
    ]);
  });

  it('clamps the page window and reports what it used', async () => {
    const context = harness();
    const page = await context.service.list({ page: 3, limit: 500 });
    expect(context.built.window).toEqual({ skip: 120, take: 60 });
    expect(page).toMatchObject({ page: 3, limit: 60 });
  });

  it('costs no aggregate round trip for an empty page', async () => {
    const context = harness();
    await context.service.list({});
    expect(context.queries).toEqual([]);
  });

  it('joins each row to its own totals and converts paise once', async () => {
    const context = harness({
      listed: [row()],
      totals: [
        {
          userId: CUSTOMER_ID,
          orders: 4,
          spend: '1234567',
          lastOrderAt: new Date('2026-08-19T11:30:00.000Z'),
        },
      ],
    });
    const page = await context.service.list({});
    expect(page.items[0]).toMatchObject({
      orders: 4,
      totalSpend: 12345.67,
      lastOrderAt: '2026-08-19T11:30:00.000Z',
    });
  });

  /**
   * Revenue excludes `cancelled` and `refunded`; the count does not. Both halves are asserted
   * against the statement, because the pair is the thing the dashboard and the customer's own
   * account page both have to agree with.
   */
  it('excludes cancelled and refunded from spend only', async () => {
    const context = harness({ listed: [row()] });
    await context.service.list({});
    const [aggregate] = context.queries;
    expect(aggregate?.sql).toContain('FILTER (WHERE o.status <> ALL($2))');
    expect(aggregate?.sql).toContain('count(*)::int AS orders');
    expect(aggregate?.parameters[1]).toEqual(['cancelled', 'refunded']);
  });

  it('answers zero for a listed customer the aggregate returned no row for', async () => {
    const context = harness({ listed: [row()], totals: [] });
    const page = await context.service.list({});
    expect(page.items[0]).toMatchObject({ orders: 0, totalSpend: 0, lastOrderAt: null });
  });
});

describe('AdminCustomersService.get', () => {
  it('answers 404 for an unknown id', async () => {
    const context = harness({ found: null });
    await expect(context.service.get(CUSTOMER_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: HttpStatus.NOT_FOUND,
    });
  });

  /**
   * An admin's own uuid must answer exactly what an unknown uuid answers — a distinguishable
   * refusal would make this endpoint an oracle for which uuids are operator accounts.
   */
  it('answers the same 404 for an admin account, not a 403', async () => {
    const unknown = harness({ found: null });
    const admin = harness({ found: row({ role: UserRole.ADMIN }) });

    const refusals = await Promise.all([
      unknown.service.get(CUSTOMER_ID).catch((error: unknown) => error),
      admin.service.get(CUSTOMER_ID).catch((error: unknown) => error),
    ]);

    const [first, second] = refusals;
    expect(first).toBeInstanceOf(DomainError);
    expect(second).toBeInstanceOf(DomainError);
    expect((second as DomainError).getResponse()).toEqual((first as DomainError).getResponse());
    expect((second as DomainError).getStatus()).toBe((first as DomainError).getStatus());
  });

  it('reads only the live address book, defaults first', async () => {
    const context = harness({ found: row() });
    await context.service.get(CUSTOMER_ID);
    expect(context.addresses.find).toHaveBeenCalledWith({
      where: { userId: CUSTOMER_ID, deletedAt: expect.anything() as unknown },
      order: { isDefault: 'DESC', createdAt: 'ASC' },
    });
  });

  it('carries the business record for a b2b account', async () => {
    const context = harness({
      found: row({ role: UserRole.BUSINESS }),
      business: { id: 'biz-1', companyName: 'Sweet Centre' } as unknown as Business,
    });
    const detail = await context.service.get(CUSTOMER_ID);
    expect(detail.business?.companyName).toBe('Sweet Centre');
  });
});
