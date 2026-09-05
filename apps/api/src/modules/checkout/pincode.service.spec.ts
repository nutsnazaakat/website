import type { Repository } from 'typeorm';
import type { ServiceablePincode } from '../../entities/commerce/serviceable-pincode.entity';
import { PincodeService } from './pincode.service';

/**
 * Three rows nested inside one another, which is the shape the rule exists for: `110001` is
 * unserviceable *inside* a serviceable `110` inside a serviceable `1`. All three match a Delhi
 * pincode, so only "longest wins" can pick the right one — a two-level fixture cannot tell
 * "longest" from "most recently added", and a fixture without a full-length row cannot tell
 * "every prefix" from "every prefix but the pincode itself".
 */
const ROWS = [
  { pincodePrefix: '1', isServiceable: true, etaDays: 4, shippingPaise: 7900n },
  { pincodePrefix: '110', isServiceable: true, etaDays: 2, shippingPaise: 4900n },
  { pincodePrefix: '110001', isServiceable: false, etaDays: 4, shippingPaise: 7900n },
  { pincodePrefix: '9', isServiceable: false, etaDays: 4, shippingPaise: 7900n },
] as ServiceablePincode[];

type Criterion = { type: string; value: unknown };

/** Named predicate rather than a cast, so an unexpected criterion is narrowed, not asserted past. */
function isFindOperator(value: unknown): value is Criterion {
  return typeof value === 'object' && value !== null && 'type' in value && 'value' in value;
}

/**
 * A repository double that actually applies the `where` it is sent.
 *
 * A `find: jest.fn(() => Promise.resolve(ROWS))` double answers every query with every row, and
 * then *nothing here is load-bearing*: `resolve('555555')` is handed the Delhi rows it must never
 * see, and the longest of them decides the verdict. The unknown-pincode case would pass without
 * ever reaching the no-match path, and dropping the exact-match candidate would pass too. This is
 * the shape `cart-read.service.spec.ts`'s `filteringHarness` takes, for the same reason.
 *
 * It understands `In` and refuses anything else. That is deliberately a check on the query's
 * *shape* and not on its behaviour: swapping `In(candidates)` for `Like(`${pincode}%`)` fails here
 * because the harness will not interpret it, not because it returns the wrong rows. What it would
 * really return against Postgres is proven in Task 10.
 */
function harness(rows: ServiceablePincode[] = ROWS) {
  const find = jest.fn((options: { where?: { pincodePrefix?: unknown } }) => {
    const criterion = options.where?.pincodePrefix;
    if (!isFindOperator(criterion) || criterion.type !== 'in' || !Array.isArray(criterion.value)) {
      throw new Error(
        `harness: expected In(candidates) on pincodePrefix, got ${String(criterion)}`,
      );
    }
    const wanted: unknown[] = criterion.value;
    return Promise.resolve(rows.filter((row) => wanted.includes(row.pincodePrefix)));
  });

  return {
    service: new PincodeService({ find } as unknown as Repository<ServiceablePincode>),
    find,
  };
}

/**
 * If one of the money assertions below ever fails, jest reports it as "Test suite failed to run:
 * TypeError: Do not know how to serialize a BigInt" rather than as a diff: a `bigint` in the
 * failure cannot cross the jest-worker boundary. Re-run this file alone — `npm run test -w @nutwala/api
 * -- pincode.service` runs in band and prints the real comparison. `expect(1n).toBe(2n)` reproduces
 * it by itself, so it is a property of the runner and not of this spec.
 */
describe('PincodeService.resolve', () => {
  /**
   * Longest prefix wins, which is the entity's stated rule and the only one that lets an admin carve
   * an exception out of a region. Compared whole, so the ETA and the shipping charge of the row that
   * answered are pinned too — those two numbers are the whole point of the service.
   */
  it('prefers the most specific matching prefix', async () => {
    await expect(harness().service.resolve('110001')).resolves.toEqual({
      isServiceable: false,
      etaDays: 4,
      shippingPaise: 7900n,
      matchedPrefix: '110001',
    });
    await expect(harness().service.resolve('110002')).resolves.toEqual({
      isServiceable: true,
      etaDays: 2,
      shippingPaise: 4900n,
      matchedPrefix: '110',
    });
    await expect(harness().service.resolve('120002')).resolves.toEqual({
      isServiceable: true,
      etaDays: 4,
      shippingPaise: 7900n,
      matchedPrefix: '1',
    });
  });

  /**
   * Every prefix of the pincode is a candidate, the six-digit pincode itself included. `slice(0, i)`
   * instead of `slice(0, i + 1)` drops that last one, and then an admin's exact-pincode row — the
   * only way to carve out a single delivery area — is silently unreachable.
   */
  it('asks for every prefix of the pincode, including the pincode itself', async () => {
    const { service, find } = harness();
    await service.resolve('110002');
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0]?.[0].where?.pincodePrefix).toMatchObject({
      value: ['1', '11', '110', '1100', '11000', '110002'],
    });
  });

  /**
   * No matching row is **not serviceable**. Defaulting to deliverable would promise delivery to a
   * pincode nobody has said anything about, and the customer discovers it after paying.
   *
   * The ETA and charge come back as zero rather than the seeded four days and ₹79: a caller that
   * reads them without checking `isServiceable` gets an obviously wrong figure instead of a
   * plausible one, and `matchedPrefix: null` says in a log why there was no answer.
   */
  it('treats an unknown pincode as not serviceable', async () => {
    await expect(harness().service.resolve('555555')).resolves.toEqual({
      isServiceable: false,
      etaDays: 0,
      shippingPaise: 0n,
      matchedPrefix: null,
    });
  });

  /** An empty table is the same refusal, not an exception from `reduce` on an empty array. */
  it('refuses every pincode when the table is empty', async () => {
    await expect(harness([]).service.resolve('110002')).resolves.toMatchObject({
      isServiceable: false,
      matchedPrefix: null,
    });
  });

  it('reports the seeded Delhi pincode as serviceable, which the Phase 1 mock did not', async () => {
    // Disagreement 1. `checkout/api/index.ts:42`'s `/^[2-8]\d{5}$/` refused prefix 1, and a smoke
    // test pinned that refusal. The seeded table says otherwise and the table is now the authority.
    const resolved = await harness().service.resolve('110002');
    expect(resolved.isServiceable).toBe(true);
  });
});
