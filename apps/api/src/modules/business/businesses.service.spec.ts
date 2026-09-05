import { FindOperator } from 'typeorm';
import { CustomerSegment } from '../../entities/enums';
import { DomainError } from '../../common/errors/domain-error';
import { BusinessesService } from './businesses.service';

const RAKESH = 'f0000000-0000-4000-8000-00000000000a';
const PRIYA = 'f0000000-0000-4000-8000-00000000000b';

const RAKESH_BUSINESS_ID = 'b1000000-0000-4000-8000-000000000001';
const PRIYA_BUSINESS_ID = 'b2000000-0000-4000-8000-000000000002';

/** Rakesh's live address. */
const RAKESH_ADDRESS_ID = 'a1000000-0000-4000-8000-000000000001';
/** Rakesh's own address, but soft-deleted — the stale-reference case. */
const RAKESH_DELETED_ADDRESS_ID = 'a2000000-0000-4000-8000-000000000002';
/** Priya's address — a stranger's, from Rakesh's point of view. */
const PRIYA_ADDRESS_ID = 'a3000000-0000-4000-8000-000000000003';

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

/**
 * The same interpretation `addresses.service.spec.ts`'s harness uses, extended with the `In()`
 * operator: TypeORM drops an `undefined` criterion rather than compiling it to anything
 * (`SelectQueryBuilder.js:2496-2504`), so the harness drops it too — a criterion that vanished
 * this way answers with every row, exactly as it would against Postgres.
 */
const matches = (row: Row, where: Where): boolean =>
  Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) return true;
    if (expected instanceof FindOperator) {
      if (expected.type === 'isNull') return row[key] === null;
      if (expected.type === 'in') return (expected.value as unknown[]).includes(row[key]);
      throw new Error(`harness: cannot interpret a ${expected.type} operator on "${key}"`);
    }
    if (!(key in row)) throw new Error(`harness: unsupported criterion "${key}"`);
    return row[key] === expected;
  });

function harness() {
  const businesses: Row[] = [
    {
      id: RAKESH_BUSINESS_ID,
      userId: RAKESH,
      companyName: 'Anand Sweets & Namkeen',
      contactPerson: 'Rakesh Anand',
      mobile: '9845012345',
      gstin: '29ABCDE1234F1Z5',
      businessType: 'Sweet shop',
      segment: CustomerSegment.DEFAULT,
      billingAddressId: RAKESH_ADDRESS_ID,
      shippingAddressId: null,
      assignedSalespersonId: null,
    },
    {
      id: PRIYA_BUSINESS_ID,
      userId: PRIYA,
      companyName: 'Crumb & Co Bakery',
      contactPerson: 'Priya Menon',
      mobile: '',
      gstin: null,
      businessType: 'Bakery',
      segment: CustomerSegment.DEFAULT,
      billingAddressId: null,
      shippingAddressId: null,
      assignedSalespersonId: null,
    },
  ];

  const addresses: Row[] = [
    {
      id: RAKESH_ADDRESS_ID,
      userId: RAKESH,
      label: 'Warehouse',
      fullName: 'Rakesh Anand',
      phone: '9845012345',
      email: 'purchase@anandsweets.example',
      line1: '12 Industrial Estate',
      line2: null,
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560004',
      isDefault: true,
      deletedAt: null,
    },
    {
      id: RAKESH_DELETED_ADDRESS_ID,
      userId: RAKESH,
      label: 'Old warehouse',
      fullName: 'Rakesh Anand',
      phone: '9845012345',
      email: 'purchase@anandsweets.example',
      line1: '4 Old Estate',
      line2: null,
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560005',
      isDefault: false,
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    {
      id: PRIYA_ADDRESS_ID,
      userId: PRIYA,
      label: 'Bakery',
      fullName: 'Priya Menon',
      phone: '9820098200',
      email: 'priya@crumbandco.example',
      line1: '9 Baker Street',
      line2: null,
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400050',
      isDefault: true,
      deletedAt: null,
    },
  ];

  const select = (table: Row[], options: { where?: Where }): Row[] =>
    table.filter((row) => matches(row, options.where ?? {})).map((row) => ({ ...row }));

  const businessesRepo = {
    findOne: (options: { where?: Where }) =>
      Promise.resolve(select(businesses, options)[0] ?? null),
    /**
     * `EntityNotFoundError`-shaped throw on empty criteria, mirroring TypeORM's own
     * `rejectEmpty` behaviour for `update`/`delete` — so a mutation that drops `where` down to
     * `{}` fails loudly here exactly as it would against Postgres, rather than the test looking
     * like it killed the mutant for the wrong reason.
     */
    update: (where: Where, patch: Row) => {
      if (Object.keys(where).length === 0) {
        throw new Error(
          'rejectEmpty: Cannot update entity, given criteria does not match any rows.',
        );
      }
      const matched = businesses.filter((row) => matches(row, where));
      for (const row of matched) Object.assign(row, patch);
      return Promise.resolve({ affected: matched.length });
    },
    create: (values: Row) => ({ ...values }),
    save: (values: Row) =>
      Promise.resolve({ id: 'b9000000-0000-4000-8000-000000000009', ...values }),
  };

  const addressesRepo = {
    find: (options: { where?: Where }) => Promise.resolve(select(addresses, options)),
    findOne: (options: { where?: Where }) => Promise.resolve(select(addresses, options)[0] ?? null),
  };

  const service = new BusinessesService(businessesRepo as never, addressesRepo as never);
  return { service, businesses, addresses };
}

describe('BusinessesService.createFor', () => {
  it('writes an empty mobile — the profile page is what fills it in', async () => {
    const { service } = harness();
    const created = await service.createFor(RAKESH, {
      companyName: 'New Co',
      contactPerson: 'Someone',
      businessType: 'Retail store',
    });
    expect(created).toMatchObject({ mobile: '', gstin: null });
  });

  it('stores the given GSTIN rather than always writing null', async () => {
    const { service } = harness();
    const created = await service.createFor(RAKESH, {
      companyName: 'New Co',
      contactPerson: 'Someone',
      businessType: 'Retail store',
      gstin: '29ABCDE1234F1Z5',
    });
    expect(created).toMatchObject({ gstin: '29ABCDE1234F1Z5' });
  });
});

describe('BusinessesService.getProfile', () => {
  it("resolves the caller's live billing address and answers null for an unset shipping one", async () => {
    const { service } = harness();
    const found = await service.getProfile(RAKESH);
    expect(found?.billing?.id).toBe(RAKESH_ADDRESS_ID);
    expect(found?.shipping).toBeNull();
  });

  it('answers null for both addresses when neither reference is set', async () => {
    const { service } = harness();
    const found = await service.getProfile(PRIYA);
    expect(found?.billing).toBeNull();
    expect(found?.shipping).toBeNull();
  });

  it('answers null, not the deleted row, for a reference to a since-soft-deleted address', async () => {
    const { service, businesses } = harness();
    const rakeshRow = businesses.find((row) => row.userId === RAKESH)!;
    rakeshRow.shippingAddressId = RAKESH_DELETED_ADDRESS_ID;

    const found = await service.getProfile(RAKESH);
    expect(found?.shipping).toBeNull();
  });

  it('answers null for a userId with no business row', async () => {
    const { service } = harness();
    expect(await service.getProfile('f0000000-0000-4000-8000-0000000000ff')).toBeNull();
  });
});

describe('BusinessesService.update', () => {
  const patch = {
    companyName: 'Anand Sweets & Namkeen Pvt Ltd',
    contactPerson: 'Rakesh Anand',
    mobile: '9845099999',
    businessType: 'Distributor',
    billingAddressId: null,
    shippingAddressId: RAKESH_ADDRESS_ID,
  };

  it('replaces the profile fields and resolves the new address references', async () => {
    const { service } = harness();
    const updated = await service.update(RAKESH, patch);
    expect(updated.business).toMatchObject({
      companyName: 'Anand Sweets & Namkeen Pvt Ltd',
      mobile: '9845099999',
      businessType: 'Distributor',
      billingAddressId: null,
      shippingAddressId: RAKESH_ADDRESS_ID,
    });
    expect(updated.billing).toBeNull();
    expect(updated.shipping?.id).toBe(RAKESH_ADDRESS_ID);
  });

  it('writes gstin as null when the request carries none', async () => {
    const { service, businesses } = harness();
    await service.update(RAKESH, { ...patch, gstin: undefined });
    expect(businesses.find((row) => row.id === RAKESH_BUSINESS_ID)?.gstin).toBeNull();
  });

  it('leaves a co-existing business untouched — the scope is userId, not any row it already found', async () => {
    const { service, businesses } = harness();
    const priyaBefore = { ...businesses.find((row) => row.id === PRIYA_BUSINESS_ID) };

    await service.update(RAKESH, patch);

    expect(businesses.find((row) => row.id === PRIYA_BUSINESS_ID)).toEqual(priyaBefore);
  });

  it('rejects an address id belonging to another customer, before writing anything', async () => {
    const { service, businesses } = harness();
    const rakeshBefore = { ...businesses.find((row) => row.id === RAKESH_BUSINESS_ID) };

    await expect(
      service.update(RAKESH, { ...patch, billingAddressId: PRIYA_ADDRESS_ID }),
    ).rejects.toBeInstanceOf(DomainError);

    expect(businesses.find((row) => row.id === RAKESH_BUSINESS_ID)).toEqual(rakeshBefore);
  });

  it('rejects a soft-deleted address id', async () => {
    const { service } = harness();
    await expect(
      service.update(RAKESH, { ...patch, shippingAddressId: RAKESH_DELETED_ADDRESS_ID }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('the address-id refusal is a 404, naming the id', async () => {
    const { service } = harness();
    const failure = (await service
      .update(RAKESH, { ...patch, billingAddressId: PRIYA_ADDRESS_ID })
      .catch((error: unknown) => error)) as DomainError;
    expect(failure.getStatus()).toBe(404);
    expect(failure.details).toEqual({ id: PRIYA_ADDRESS_ID });
  });
});
