import { FindOperator } from 'typeorm';
import { Address } from '../../entities/identity/address.entity';
import { AddressesService } from './addresses.service';
import type { CreateAddressDto } from './dto/save-address.dto';

/** Two customers, because every assertion in this file is about which of them a row belongs to. */
const ASHA = 'f0000000-0000-4000-8000-00000000000a';
const RAKESH = 'f0000000-0000-4000-8000-00000000000b';

/** The statement `lockOwner` issues, spelled out so a rewrite of it has to be deliberate. */
const OWNER_LOCK = 'SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE';

interface Seed {
  userId: string;
  label: string;
  isDefault?: boolean;
  deleted?: boolean;
  line2?: string | null;
}

/**
 * The fixture, in insertion order — which is `createdAt` order, which is the order `settle()` promotes
 * in.
 *
 * `Old flat` is soft-deleted and `Parents` is younger than `Office`, both deliberately: the first is
 * what a read that forgot `deletedAt IS NULL` returns, and the second is what tells "promote the
 * oldest" apart from "promote whichever comes back first".
 */
const SEEDS: readonly Seed[] = [
  { userId: ASHA, label: 'Home', isDefault: true, line2: 'Near Mayo Hall' },
  { userId: ASHA, label: 'Office' },
  { userId: ASHA, label: 'Parents' },
  { userId: ASHA, label: 'Old flat', deleted: true },
  { userId: RAKESH, label: 'Warehouse', isDefault: true },
];

/** A body `CreateAddressDto` would have produced — the form's own values. */
const NEW_ADDRESS: CreateAddressDto = {
  label: 'Studio',
  fullName: 'Asha Rao',
  phone: '9876543210',
  email: 'b2c@demo.in',
  line1: '9 Langford Road',
  line2: 'Opposite the park',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560027',
  isDefault: false,
};

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type Direction = 'ASC' | 'DESC';

interface FindOptions {
  where?: Where;
  order?: Record<string, unknown>;
}

const isDirection = (value: unknown): value is Direction => value === 'ASC' || value === 'DESC';

/**
 * A repository double that applies the `where`, the `order` and the patch it is sent — **and enforces
 * `uq_addresses_one_default_per_user`.**
 *
 * The index is the reason this harness is not a set of `jest.fn()`s. Three of the mutants this file
 * has to kill are invisible without it:
 *
 * - **setting the new default before clearing the old.** The index is checked per statement and is not
 *   deferrable, so against Postgres the second statement fails outright. A double that merely records
 *   writes would see the same two statements in either order and pass.
 * - **dropping `deletedAt IS NULL` from the predicate that clears the old default**, which changes
 *   which rows the constraint is counted over.
 * - **removing the promotion step**, whose whole purpose is the half of the rule the index does *not*
 *   check — that a book with addresses has at least one default.
 *
 * Four TypeORM behaviours are modelled from the library rather than invented, because the assertions
 * depend on them:
 *
 * - **`undefined` and `null` in a `where` are dropped, not compiled to anything**
 *   (`SelectQueryBuilder.js:2496-2517`, both default to `'ignore'`). So a lost `userId` here answers
 *   with every customer's addresses, exactly as it would against Postgres.
 * - **`IsNull()` is a `FindOperator` and means `IS NULL`.** Interpreted rather than compared with
 *   `===`, which would silently match nothing; any *other* operator throws, so a query rewritten into
 *   a shape this file cannot read fails loudly instead of quietly.
 * - **`undefined` values in an `UPDATE`'s value set are skipped** — `UpdateQueryBuilder.js:294`,
 *   *"it doesn't make sense to update undefined properties"* — which is what makes a patch a patch.
 * - **an `UPDATE` with nothing left to set is a syntax error**, not a no-op, so the harness throws on
 *   one rather than absorbing it.
 *
 * What it does **not** model is rollback: `transaction` here simply runs the callback, so a case that
 * asserts a *refusal* must not then assert the table's contents. Nothing below does.
 */
function harness(seeds: readonly Seed[] = SEEDS) {
  let generated = 0;
  const idFor = (): string => `aaaaaaaa-0000-4000-8000-${String(++generated).padStart(12, '0')}`;

  /** One minute apart, so `createdAt` is a total order and the promotion rule is observable. */
  const createdAtFor = (index: number): Date =>
    new Date(new Date('2025-11-04T09:12:00.000Z').getTime() + index * 60_000);

  const table: Row[] = seeds.map((seed, index) => ({
    id: idFor(),
    userId: seed.userId,
    label: seed.label,
    fullName: seed.userId === ASHA ? 'Asha Rao' : 'Rakesh Anand',
    phone: '9876543210',
    email: seed.userId === ASHA ? 'b2c@demo.in' : 'b2b@demo.in',
    line1: `${seed.label} line one`,
    line2: seed.line2 ?? null,
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560025',
    isDefault: seed.isDefault === true,
    deletedAt: seed.deleted === true ? new Date('2026-01-01T00:00:00.000Z') : null,
    createdAt: createdAtFor(index),
    updatedAt: createdAtFor(index),
  }));

  /** Every call the service made, in order, so "the lock came first" is assertable. */
  const calls: string[] = [];
  const inserted: Row[] = [];
  const locked: unknown[] = [];

  const enforceOneDefaultPerUser = (): void => {
    const counts = new Map<unknown, number>();
    for (const row of table) {
      if (row.isDefault === true && row.deletedAt === null) {
        counts.set(row.userId, (counts.get(row.userId) ?? 0) + 1);
      }
    }
    for (const [userId, count] of counts) {
      if (count > 1) {
        throw new Error(
          `duplicate key value violates unique constraint "uq_addresses_one_default_per_user" — (user_id)=(${String(userId)})`,
        );
      }
    }
  };

  const matches = (row: Row, where: Where): boolean =>
    Object.entries(where).every(([key, expected]) => {
      // TypeORM drops both, so the harness drops both.
      if (expected === undefined || expected === null) return true;
      if (expected instanceof FindOperator) {
        if (expected.type !== 'isNull') {
          throw new Error(`harness: cannot interpret a ${expected.type} operator on "${key}"`);
        }
        return row[key] === null;
      }
      if (typeof expected === 'object') {
        throw new Error(`harness: cannot interpret an object criterion on "${key}"`);
      }
      if (!(key in row)) throw new Error(`harness: unsupported criterion "${key}"`);
      return row[key] === expected;
    });

  const compare = (left: unknown, right: unknown, direction: Direction): number => {
    const sign = direction === 'ASC' ? 1 : -1;
    // Postgres orders `false` before `true`, so `isDefault DESC` puts the default first.
    if (typeof left === 'boolean' && typeof right === 'boolean') {
      return sign * (Number(left) - Number(right));
    }
    if (left instanceof Date && right instanceof Date) {
      return sign * (left.getTime() - right.getTime());
    }
    if (typeof left === 'string' && typeof right === 'string') {
      return sign * left.localeCompare(right);
    }
    throw new Error(`harness: cannot order values of type ${typeof left}`);
  };

  const select = (options: FindOptions): Row[] => {
    const found = table.filter((row) => matches(row, options.where ?? {}));
    const keys = Object.entries(options.order ?? {});
    for (const [key, direction] of keys) {
      if (!isDirection(direction)) throw new Error(`harness: unsupported order on "${key}"`);
    }

    // A genuine multi-key sort rather than one pass per key, so the tiebreakers really break ties.
    return [...found]
      .sort((left, right) => {
        for (const [key, direction] of keys) {
          if (!isDirection(direction)) continue;
          const result = compare(left[key], right[key], direction);
          if (result !== 0) return result;
        }
        return 0;
      })
      .map((row) => ({ ...row }));
  };

  const repository = {
    find: (options: FindOptions) => {
      calls.push('find');
      return Promise.resolve(select(options));
    },
    findOne: (options: FindOptions) => {
      calls.push('findOne');
      return Promise.resolve(select(options)[0] ?? null);
    },
    count: (options: FindOptions) => {
      calls.push('count');
      return Promise.resolve(select(options).length);
    },
    insert: (values: Row) => {
      calls.push('insert');
      inserted.push({ ...values });
      const row: Row = {
        id: idFor(),
        deletedAt: null,
        isDefault: false,
        createdAt: createdAtFor(table.length),
        updatedAt: createdAtFor(table.length),
        ...values,
      };
      table.push(row);
      enforceOneDefaultPerUser();
      return Promise.resolve({ identifiers: [{ id: row.id }] });
    },
    update: (criteria: Where, patch: Row) => {
      calls.push('update');
      const assignments = Object.entries(patch).filter(([, value]) => value !== undefined);
      if (assignments.length === 0) {
        throw new Error('harness: an UPDATE with an empty SET clause is a syntax error');
      }
      const targets = table.filter((row) => matches(row, criteria));
      for (const row of targets) {
        for (const [key, value] of assignments) row[key] = value;
      }
      enforceOneDefaultPerUser();
      return Promise.resolve({ affected: targets.length });
    },
  };

  const repositoryFor = (entity: unknown): typeof repository => {
    if (entity !== Address) throw new Error('harness: only the Address repository exists');
    return repository;
  };

  const manager = {
    getRepository: repositoryFor,
    query: (sql: string, parameters: unknown[]) => {
      calls.push(`query:${sql}`);
      locked.push(parameters[0]);
      return Promise.resolve([{ id: parameters[0] }]);
    },
  };

  const dataSource = {
    transaction: <T>(run: (m: unknown) => Promise<T>): Promise<T> => run(manager),
    getRepository: repositoryFor,
  };

  return {
    service: new AddressesService(dataSource as never),
    /** The rows as they now stand, including deleted ones — the table, not the book. */
    rows: (): Row[] => table.map((row) => ({ ...row })),
    calls,
    inserted,
    locked,
  };
}

const labelsOf = (book: { label: string }[]): string[] => book.map((address) => address.label);

const defaultOf = (book: { label: string; isDefault: boolean }[]): string | undefined =>
  book.find((address) => address.isDefault)?.label;

/** The id of one of ASHA's seeded addresses, by label. */
const idOf = (rows: Row[], label: string): string => {
  const found = rows.find((row) => row.label === label);
  if (found === undefined) throw new Error(`no seeded address labelled ${label}`);
  return String(found.id);
};

describe('AddressesService.list', () => {
  /**
   * **The IDOR clause, and the one mutant that turns this endpoint into a data breach.**
   *
   * The fixture interleaves two customers, so a `where` that lost `userId` answers with a list whose
   * *order* is plausible and whose membership is not — the failure names the real problem rather than
   * looking like an ordering bug.
   */
  it('answers with the caller’s own addresses and nobody else’s', async () => {
    const { service } = harness();

    expect(labelsOf(await service.list(ASHA))).toEqual(['Home', 'Office', 'Parents']);
    expect(labelsOf(await service.list(RAKESH))).toEqual(['Warehouse']);
  });

  /**
   * `Address.deletedAt` is a plain `@Column`, **not** a `@DeleteDateColumn`, so TypeORM adds no filter
   * of its own: without the explicit `IsNull()` this read answers with every address the customer has
   * ever removed, and the page they deleted it from shows it again on the next visit.
   */
  it('leaves a soft-deleted address out of the book', async () => {
    const { service } = harness();
    expect(labelsOf(await service.list(ASHA))).not.toContain('Old flat');
  });

  /**
   * `/account/addresses` promises the customer *"the default one is offered first"*, and checkout
   * prefills from the head of this list. The fixture's default is the *first* seeded row, so this is
   * arranged to fail on a mutant rather than to pass by accident: `Home` is also the oldest, so the
   * case below moves the default to the youngest address and asserts it overtakes both.
   */
  it('puts the default first', async () => {
    const { service, rows } = harness();
    await service.setDefault(ASHA, idOf(rows(), 'Parents'));

    expect(labelsOf(await service.list(ASHA))).toEqual(['Parents', 'Home', 'Office']);
  });

  /**
   * **Unreachable over HTTP, and that is why it is cheap to hold.**
   *
   * TypeORM drops an `undefined` from a `where`, so an ownerless read is not a query for unowned
   * addresses — it is a query with no owner clause, answering with every address in the table. Every
   * route on the controller is authenticated and `@CurrentUser()` throws rather than resolving nobody,
   * so this guard is the second lock; without it the failure mode is silent and total.
   */
  it('refuses an ownerless read rather than answering with the whole table', async () => {
    const { service } = harness();
    await expect(service.list(undefined as unknown as string)).rejects.toThrow(/without an owner/);
  });
});

describe('AddressesService.create', () => {
  it('stores the address against the caller and answers with the whole book', async () => {
    const { service, inserted } = harness();

    const book = await service.create(ASHA, NEW_ADDRESS);

    expect(labelsOf(book)).toEqual(['Home', 'Office', 'Parents', 'Studio']);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ userId: ASHA, label: 'Studio', city: 'Bengaluru' });
  });

  /**
   * **No client-supplied id, ever.** `routes/account/addresses.tsx` used to mint
   * `` `adr-${Date.now().toString(36)}` `` — which collides for two addresses saved in the same
   * millisecond, and which is not a uuid at all, so it reaches the `uuid` primary key as SQLSTATE
   * `22P02` and a 500. The DTO rejects the field and this asserts the service never writes one either,
   * so the key stays `BaseEntity`'s generated uuid.
   */
  it('lets the database allocate the id', async () => {
    const { service, inserted } = harness();
    await service.create(ASHA, NEW_ADDRESS);

    expect(inserted[0]).not.toHaveProperty('id');
  });

  /**
   * **The first address in a book is the default whatever the request said**, which is the half of the
   * rule the unique index has no opinion about. `NEW_ADDRESS` carries `isDefault: false`, so a mutant
   * that only honoured the request leaves a customer with one address, no default, no *Default* badge
   * and nothing for checkout to offer first — with no error anywhere.
   */
  it('promotes the first address in an empty book, whatever the request asked for', async () => {
    const { service } = harness([]);

    const book = await service.create(ASHA, { ...NEW_ADDRESS, isDefault: false });

    expect(defaultOf(book)).toBe('Studio');
  });

  it('does not disturb the existing default when the request does not ask to', async () => {
    const { service } = harness();

    expect(defaultOf(await service.create(ASHA, NEW_ADDRESS))).toBe('Home');
  });

  /**
   * **Clear first, then set — and the harness's unique index is what proves the order.**
   *
   * `uq_addresses_one_default_per_user` is checked per statement, so setting the new default before
   * clearing the old raises a constraint violation *immediately*: the customer's save fails with a 500
   * and their book keeps the old default. Reversing the two statements is the mutant, and this case is
   * the only thing in the unit suite that can see it.
   */
  it('moves the default rather than adding a second one', async () => {
    const { service } = harness();

    const book = await service.create(ASHA, { ...NEW_ADDRESS, isDefault: true });

    expect(defaultOf(book)).toBe('Studio');
    expect(book.filter((address) => address.isDefault)).toHaveLength(1);
    // The promoted address is first, which is what the page and checkout read.
    expect(labelsOf(book)[0]).toBe('Studio');
  });

  /**
   * **The clear half of a promotion is scoped to one customer, and nothing else in this file could see
   * it.**
   *
   * `clearDefault` is an `UPDATE … SET "isDefault" = false` over a `where`, and a `where` that loses
   * its `userId` demotes **every customer in the database** — a cross-tenant write with no error
   * anywhere, because the unique index only ever objects to *two* defaults and this leaves zero. The
   * victim's book is then read by `settle()` under a different `userId`, so nothing promotes a
   * replacement either: the next customer to open checkout has no address offered first and no way to
   * tell why. Measured as a **survivor** of all 91 unit and 34 integration cases before this case and
   * its two siblings existed.
   */
  it('demotes only the caller’s own default, never another customer’s', async () => {
    const { service, rows } = harness();

    await service.create(ASHA, { ...NEW_ADDRESS, isDefault: true });

    expect(rows().find((row) => row.label === 'Warehouse')).toMatchObject({ isDefault: true });
  });

  /**
   * `AddressForm`'s `emptyValues` sets `line2: ''` and `@IsOptional()` accepts it — an empty string is
   * a present value — so without this the column holds two spellings of "no second line" and every
   * consumer has to know both.
   */
  it('stores an untouched second line as null rather than an empty string', async () => {
    const { service, inserted } = harness();
    await service.create(ASHA, { ...NEW_ADDRESS, line2: '' });

    expect(inserted[0]?.line2).toBeNull();
  });

  it('treats a second line of nothing but spaces the same way', async () => {
    const { service, inserted } = harness();
    await service.create(ASHA, { ...NEW_ADDRESS, line2: '   ' });

    expect(inserted[0]?.line2).toBeNull();
  });

  it('keeps a real second line exactly as it was typed', async () => {
    const { service, inserted } = harness();
    await service.create(ASHA, NEW_ADDRESS);

    expect(inserted[0]?.line2).toBe('Opposite the park');
  });

  /**
   * **The lock, and it has to be the first thing the transaction does.**
   *
   * Two concurrent creates on an empty book each count zero addresses, each decide to promote
   * themselves, and the second dies on the unique index — a 500 for an ordinary double-click of *Add
   * Address*. The `users` row is what they serialise on, because on an empty book there is no address
   * row to lock. Asserted as *first*, not merely present: taken after the count, it serialises nothing
   * that matters.
   */
  it('locks the owner before it counts anything', async () => {
    const { service, calls, locked } = harness();
    await service.create(ASHA, NEW_ADDRESS);

    expect(calls[0]).toBe(`query:${OWNER_LOCK}`);
    expect(locked).toEqual([ASHA]);
  });
});

describe('AddressesService.update', () => {
  it('edits the fields the request carried and leaves the rest alone', async () => {
    const { service, rows } = harness();
    const id = idOf(rows(), 'Office');

    const book = await service.update(ASHA, id, { label: 'Studio office', city: 'Mysuru' });

    const edited = rows().find((row) => row.id === id);
    expect(edited).toMatchObject({
      label: 'Studio office',
      city: 'Mysuru',
      // untouched by this patch, and still the seeded values
      fullName: 'Asha Rao',
      line1: 'Office line one',
      pincode: '560025',
    });
    expect(labelsOf(book ?? [])).toEqual(['Home', 'Studio office', 'Parents']);
  });

  /**
   * `@CurrentUser()` decides the owner and the path decides the row, so an id belonging to another
   * customer is a miss — indistinguishable from an id belonging to nobody, which is the 404 the
   * controller answers. It must also write **nothing**: a mutant that dropped `userId` from the lookup
   * would let one customer rename another's address.
   */
  it('answers null for another customer’s address and edits nothing', async () => {
    const { service, rows } = harness();
    const warehouse = idOf(rows(), 'Warehouse');

    await expect(service.update(ASHA, warehouse, { label: 'Mine now' })).resolves.toBeNull();
    expect(rows().find((row) => row.id === warehouse)).toMatchObject({ label: 'Warehouse' });
  });

  it('answers null for an address the caller has already deleted', async () => {
    const { service, rows } = harness();

    await expect(
      service.update(ASHA, idOf(rows(), 'Old flat'), { label: 'Back again' }),
    ).resolves.toBeNull();
  });

  it('answers null for an id nobody owns', async () => {
    const { service } = harness();

    await expect(
      service.update(ASHA, 'ffffffff-0000-4000-8000-999999999999', { label: 'Nowhere' }),
    ).resolves.toBeNull();
  });

  /** Clear then set, exactly as a create does — same index, same ordering requirement. */
  it('moves the default when the edit asks for it', async () => {
    const { service, rows } = harness();

    const book = await service.update(ASHA, idOf(rows(), 'Office'), { isDefault: true });

    expect(defaultOf(book ?? [])).toBe('Office');
    expect((book ?? []).filter((address) => address.isDefault)).toHaveLength(1);
  });

  /**
   * **The invariant the database cannot enforce, from the direction nobody expects.**
   *
   * `uq_addresses_one_default_per_user` stops two defaults and has no opinion about zero. Unticking
   * *Use as my default address* on the only default is a request the form makes freely, and honoured
   * literally it leaves a book with three addresses and no default: no badge, and checkout with
   * nothing to offer first. The rule is that a default can be **moved, never removed** — so the oldest
   * address takes it, which is what the mock's `commit` did by promoting index 0.
   */
  it('never leaves the book with no default when the only one is unticked', async () => {
    const { service, rows } = harness();

    const book = await service.update(ASHA, idOf(rows(), 'Home'), { isDefault: false });

    expect(defaultOf(book ?? [])).toBe('Home');
    expect((book ?? []).filter((address) => address.isDefault)).toHaveLength(1);
  });

  /**
   * The same request against an address that is *not* the default is honoured exactly: the flag was
   * already false, the default stays where it is, and nothing is promoted.
   */
  it('leaves the default alone when a different address is unticked', async () => {
    const { service, rows } = harness();

    const book = await service.update(ASHA, idOf(rows(), 'Office'), { isDefault: false });

    expect(defaultOf(book ?? [])).toBe('Home');
  });

  /**
   * `UpdateAddressDto` accepts `{}` — every field is optional — and `UPDATE … SET` with nothing to set
   * is a syntax error, not a no-op. So an empty patch has to skip the statement rather than issue it,
   * and this is the case that says so.
   */
  it('accepts an empty patch without issuing an empty UPDATE', async () => {
    const { service, rows } = harness();

    const book = await service.update(ASHA, idOf(rows(), 'Office'), {});

    expect(labelsOf(book ?? [])).toEqual(['Home', 'Office', 'Parents']);
  });

  it('clears a second line the customer emptied', async () => {
    const { service, rows } = harness();
    const id = idOf(rows(), 'Home');

    await service.update(ASHA, id, { line2: '' });

    expect(rows().find((row) => row.id === id)?.line2).toBeNull();
  });

  it('leaves a second line alone when the patch does not mention it', async () => {
    const { service, rows } = harness();
    const id = idOf(rows(), 'Home');

    await service.update(ASHA, id, { label: 'House' });

    expect(rows().find((row) => row.id === id)?.line2).toBe('Near Mayo Hall');
  });

  it('locks the owner before it reads the address', async () => {
    const { service, calls, rows } = harness();
    await service.update(ASHA, idOf(rows(), 'Office'), { label: 'Studio office' });

    expect(calls[0]).toBe(`query:${OWNER_LOCK}`);
  });
});

describe('AddressesService.remove', () => {
  /**
   * **Soft, and the row survives.** `address.entity.ts`'s docblock gives the reason — *"Soft-deleted so
   * a restore is possible"* — and explicitly *not* the reason a reader assumes: orders never reference
   * this table, they hold an `addressSnapshot`, so a hard delete could not blank out a past
   * delivery address.
   */
  it('marks the address deleted rather than removing the row', async () => {
    const { service, rows } = harness();
    const id = idOf(rows(), 'Office');

    const book = await service.remove(ASHA, id);

    expect(labelsOf(book ?? [])).toEqual(['Home', 'Parents']);
    expect(rows().find((row) => row.id === id)?.deletedAt).toBeInstanceOf(Date);
  });

  /**
   * **Deleting the default promotes the oldest survivor.** Without it the customer's book keeps three
   * addresses and loses its default entirely — the index permits it, so nothing anywhere complains.
   *
   * `Office` rather than `Parents` is the assertion that matters: both are undefaulted survivors, so a
   * mutant that promoted the last row instead of the oldest passes a weaker check.
   */
  it('promotes the oldest remaining address when the default is deleted', async () => {
    const { service, rows } = harness();

    const book = await service.remove(ASHA, idOf(rows(), 'Home'));

    expect(defaultOf(book ?? [])).toBe('Office');
    expect(labelsOf(book ?? [])).toEqual(['Office', 'Parents']);
  });

  /**
   * **The flag is cleared on the way out, and the reason is the restore.** The index's predicate
   * already excludes deleted rows, so a deleted row that still says `isDefault` violates nothing
   * *today* — it violates on the day someone restores it, next to the address that was promoted in its
   * place. That restore is the entire stated purpose of the soft delete.
   */
  it('clears the deleted address’s own default flag, so a restore cannot make two', async () => {
    const { service, rows } = harness();
    const id = idOf(rows(), 'Home');

    await service.remove(ASHA, id);

    expect(rows().find((row) => row.id === id)).toMatchObject({ isDefault: false });
  });

  /**
   * The last address out of the book leaves it empty, and there is nothing to promote. A promotion
   * step that assumed a survivor would either crash here or write to `undefined`.
   */
  it('leaves an empty book empty', async () => {
    const { service } = harness([{ userId: ASHA, label: 'Only', isDefault: true }]);
    const rows = await service.list(ASHA);

    await expect(service.remove(ASHA, String(rows[0]?.id))).resolves.toEqual([]);
  });

  it('answers null for another customer’s address and deletes nothing', async () => {
    const { service, rows } = harness();
    const warehouse = idOf(rows(), 'Warehouse');

    await expect(service.remove(ASHA, warehouse)).resolves.toBeNull();
    expect(rows().find((row) => row.id === warehouse)?.deletedAt).toBeNull();
  });

  it('answers null for an address already deleted, rather than deleting it twice', async () => {
    const { service, rows } = harness();

    await expect(service.remove(ASHA, idOf(rows(), 'Old flat'))).resolves.toBeNull();
  });

  it('locks the owner before it reads the address', async () => {
    const { service, calls, rows } = harness();
    await service.remove(ASHA, idOf(rows(), 'Office'));

    expect(calls[0]).toBe(`query:${OWNER_LOCK}`);
  });
});

describe('AddressesService.setDefault', () => {
  it('moves the badge and leaves exactly one', async () => {
    const { service, rows } = harness();

    const book = await service.setDefault(ASHA, idOf(rows(), 'Parents'));

    expect(defaultOf(book ?? [])).toBe('Parents');
    expect((book ?? []).filter((address) => address.isDefault)).toHaveLength(1);
  });

  /**
   * A double-clicked *Make default* must not be a constraint violation. Clear-then-set is what makes
   * it idempotent: the second promotion clears the flag it is about to set, so the statement pair is
   * legal against the index however many times it runs.
   */
  it('is idempotent for the address that is already the default', async () => {
    const { service, rows } = harness();
    const home = idOf(rows(), 'Home');

    await service.setDefault(ASHA, home);
    const book = await service.setDefault(ASHA, home);

    expect(defaultOf(book ?? [])).toBe('Home');
    expect((book ?? []).filter((address) => address.isDefault)).toHaveLength(1);
  });

  /** The same scoping on the promotion path, which reaches `clearDefault` by a different route. */
  it('leaves another customer’s default standing', async () => {
    const { service, rows } = harness();

    await service.setDefault(ASHA, idOf(rows(), 'Parents'));

    expect(rows().find((row) => row.label === 'Warehouse')).toMatchObject({ isDefault: true });
  });

  /**
   * Another customer's default is not the caller's to move — and a mutant that dropped `userId` from
   * the lookup would leave `Warehouse` promoted inside `RAKESH`'s book by a request `ASHA` made.
   */
  it('answers null for another customer’s address and promotes nothing', async () => {
    const { service, rows } = harness();

    await expect(service.setDefault(ASHA, idOf(rows(), 'Warehouse'))).resolves.toBeNull();
    expect(defaultOf((await service.list(ASHA)) as never)).toBe('Home');
  });

  it('will not promote an address the caller has deleted', async () => {
    const { service, rows } = harness();

    await expect(service.setDefault(ASHA, idOf(rows(), 'Old flat'))).resolves.toBeNull();
  });

  it('locks the owner before it reads the address', async () => {
    const { service, calls, rows } = harness();
    await service.setDefault(ASHA, idOf(rows(), 'Parents'));

    expect(calls[0]).toBe(`query:${OWNER_LOCK}`);
  });
});
