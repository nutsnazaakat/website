import { HttpStatus } from '@nestjs/common';
import { CustomerSegment, UserRole } from '../../entities/enums';
import type { Business } from '../../entities/identity/business.entity';
import type { User } from '../../entities/identity/user.entity';
import { AdminBusinessesService } from './admin-businesses.service';
import { OPEN_RFQ_STATUSES } from './business-stats.service';
import type { BusinessesService } from './businesses.service';

const BUSINESS_ID = 'b0000000-0000-4000-8000-00000000000b';
const USER_ID = 'f0000000-0000-4000-8000-00000000000a';

const business = (overrides: Partial<Business> = {}): Business =>
  ({
    id: BUSINESS_ID,
    userId: USER_ID,
    companyName: 'Anand Sweets',
    contactPerson: 'Ravi Kumar',
    mobile: '9812345670',
    gstin: null,
    businessType: 'Sweet shop',
    segment: CustomerSegment.DEFAULT,
    billingAddressId: null,
    shippingAddressId: null,
    assignedSalespersonId: null,
    createdAt: new Date('2026-02-01T09:00:00.000Z'),
    updatedAt: new Date('2026-02-01T09:00:00.000Z'),
    ...overrides,
  }) as unknown as Business;

const account = (overrides: Partial<User> = {}): User =>
  ({
    id: USER_ID,
    name: 'Ravi Kumar',
    email: 'ravi@anandsweets.in',
    phone: '9812345670',
    role: UserRole.BUSINESS,
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date('2026-02-01T09:00:00.000Z'),
    updatedAt: new Date('2026-02-01T09:00:00.000Z'),
    ...overrides,
  }) as unknown as User;

/** Records the statement the list builds — the predicates, the order and the window are the whole
 * of its behaviour, and none of it is visible in the rows a repository double hands back. */
function queryBuilder(rows: Business[]) {
  const where: { clause: string; parameters: Record<string, unknown> }[] = [];
  const order: [string, string][] = [];
  const window: { skip?: number; take?: number } = {};
  const builder = {
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
    getManyAndCount: () => Promise.resolve<[Business[], number]>([rows, rows.length]),
  };
  return { builder, where, order, window };
}

function harness(
  options: {
    listed?: Business[];
    found?: Business | null;
    users?: User[];
    rows?: Record<string, unknown[]>;
  } = {},
) {
  const built = queryBuilder(options.listed ?? []);
  const queries: { sql: string; parameters: unknown[] }[] = [];
  const businesses = {
    createQueryBuilder: jest.fn().mockReturnValue(built.builder),
    findOne: jest.fn().mockResolvedValue(options.found ?? null),
  };
  const users = { find: jest.fn().mockResolvedValue(options.users ?? [account()]) };
  const profiles = {
    getProfile: jest
      .fn()
      .mockImplementation((userId: string) =>
        Promise.resolve({ business: business({ userId }), billing: null, shipping: null }),
      ),
  };
  const dataSource = {
    query: (sql: string, parameters: unknown[]) => {
      queries.push({ sql, parameters });
      const key = sql.includes('FROM rfqs') ? 'rfqs' : 'orders';
      return Promise.resolve(options.rows?.[key] ?? []);
    },
  };
  return {
    service: new AdminBusinessesService(
      businesses as never,
      users as never,
      profiles as unknown as BusinessesService,
      dataSource as never,
    ),
    businesses,
    users,
    profiles,
    queries,
    built,
  };
}

describe('AdminBusinessesService.list', () => {
  it('filters by the wire segment through the column enum, never by the wire string', async () => {
    const context = harness();
    await context.service.list({ segment: 'horeca' });
    const clause = context.built.where.find(
      (entry) => entry.clause === 'business.segment = :segment',
    );
    expect(clause?.parameters).toEqual({ segment: CustomerSegment.HORECA });
  });

  it('searches company, contact and GSTIN with one parameter', async () => {
    const context = harness();
    await context.service.list({ q: ' sweet ' });
    const clause = context.built.where.find((entry) => entry.clause.includes('ILIKE'));
    expect(clause?.clause).toContain('business.companyName ILIKE :q');
    expect(clause?.clause).toContain('business.contactPerson ILIKE :q');
    expect(clause?.clause).toContain('business.gstin ILIKE :q');
    expect(clause?.parameters).toEqual({ q: '%sweet%' });
  });

  it('ignores a blank search rather than matching every row against "%%"', async () => {
    const context = harness();
    await context.service.list({ q: '  ' });
    expect(context.built.where.some((entry) => entry.clause.includes('ILIKE'))).toBe(false);
  });

  it('orders newest first with a total tiebreak', async () => {
    const context = harness();
    await context.service.list({});
    expect(context.built.order).toEqual([
      ['business.createdAt', 'DESC'],
      ['business.id', 'DESC'],
    ]);
  });

  it('clamps the page window and reports what it used', async () => {
    const context = harness();
    const page = await context.service.list({ page: 2, limit: 500 });
    expect(context.built.window).toEqual({ skip: 60, take: 60 });
    expect(page).toMatchObject({ page: 2, limit: 60 });
  });

  it('costs no aggregate round trip for an empty page', async () => {
    const context = harness();
    await context.service.list({});
    expect(context.queries).toEqual([]);
  });

  /**
   * `OPEN_RFQ_STATUSES` is imported from `BusinessStatsService` rather than restated, so the
   * operator's "open enquiries" figure and the one the business reads on its own dashboard cannot
   * come from two different lists.
   */
  it('counts RFQs by user_id and takes the open set from one place', async () => {
    const context = harness({ listed: [business()] });
    await context.service.list({});

    const rfqs = context.queries.find((entry) => entry.sql.includes('FROM rfqs'));
    expect(rfqs?.sql).toContain('r.user_id = ANY($1)');
    expect(rfqs?.sql).toContain('count(*) FILTER (WHERE r.status = ANY($2))::int AS "openRfqs"');
    expect(rfqs?.parameters[1]).toEqual(OPEN_RFQ_STATUSES);
    expect(OPEN_RFQ_STATUSES).toEqual(['new', 'contacted', 'quote-sent', 'negotiation']);
  });

  it('joins each row to its own aggregates', async () => {
    const context = harness({
      listed: [business()],
      rows: {
        orders: [
          {
            userId: USER_ID,
            orders: 6,
            spend: '4567800',
            lastOrderAt: new Date('2026-08-18T07:45:00.000Z'),
          },
        ],
        rfqs: [{ userId: USER_ID, rfqs: 5, openRfqs: 2 }],
      },
    });

    const page = await context.service.list({});
    expect(page.items[0]).toMatchObject({
      orders: 6,
      totalSpend: 45678,
      lastOrderAt: '2026-08-18T07:45:00.000Z',
      rfqs: 5,
      openRfqs: 2,
    });
  });

  /**
   * `BusinessesService.getProfile` is the one implementation of "a reference to a soft-deleted
   * address reads back as absent". Resolving the addresses here instead would be a second copy of
   * that rule, and the operator and the business would then see different answers.
   */
  it('resolves addresses through the service that owns the soft-delete rule', async () => {
    const context = harness({ listed: [business()] });
    await context.service.list({});
    expect(context.profiles.getProfile).toHaveBeenCalledWith(USER_ID);
  });

  it('reads no salesperson when no row names one', async () => {
    const context = harness({ listed: [business()] });
    await context.service.list({});
    expect(context.users.find).toHaveBeenCalledTimes(1);
  });
});

describe('AdminBusinessesService.get', () => {
  it('answers 404 for an unknown business', async () => {
    const context = harness({ found: null });
    await expect(context.service.get(BUSINESS_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: HttpStatus.NOT_FOUND,
    });
  });

  it('answers the detail shape, addresses included', async () => {
    const context = harness({ found: business() });
    const detail = await context.service.get(BUSINESS_ID);
    expect(detail).toMatchObject({ id: BUSINESS_ID, userId: USER_ID, companyName: 'Anand Sweets' });
    expect(detail.billingAddress).toBeNull();
    expect(detail.shippingAddress).toBeNull();
  });

  /** `businesses.user_id` is `ON DELETE CASCADE`, so a business without an account cannot exist —
   * meeting one is a real error, not a row to render with a missing email. */
  it('throws rather than inventing an email when the account is missing', async () => {
    const context = harness({ found: business(), users: [] });
    await expect(context.service.get(BUSINESS_ID)).rejects.toThrow(/has no account/);
  });
});
