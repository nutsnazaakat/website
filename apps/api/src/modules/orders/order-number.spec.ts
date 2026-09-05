import type { EntityManager } from 'typeorm';
import {
  formatOrderNumber,
  nextOrderNumber,
  ORDER_NUMBER_PATTERN,
  ORDER_NUMBER_SEQUENCE,
} from './order-number';

describe('formatOrderNumber', () => {
  it('pads to six digits behind the year', () => {
    expect(formatOrderNumber(2026, 100000)).toBe('NN-2026-100000');
    expect(formatOrderNumber(2026, 1)).toBe('NN-2026-000001');
  });

  /**
   * The column is `varchar(20)` and `NN-2026-1000000` is 15 characters, so a seventh digit fits.
   * Truncating to keep six would start re-issuing numbers that already exist — a unique violation on
   * the millionth order, which is a good problem to have and a terrible way to meet it.
   *
   * The `toMatch` is not decoration. Measured: with only the two assertions above, tightening
   * `ORDER_NUMBER_PATTERN` to `\d{6}` passes every test in this file, so the pattern would come to
   * reject the very string `formatOrderNumber` is documented to produce. This line is the only thing
   * that makes the `{6,}` in that pattern load-bearing.
   */
  it('grows past six digits rather than truncating', () => {
    expect(formatOrderNumber(2026, 1_000_000)).toBe('NN-2026-1000000');
    expect(formatOrderNumber(2026, 1_000_000).length).toBeLessThanOrEqual(20);
    expect(formatOrderNumber(2026, 1_000_000)).toMatch(ORDER_NUMBER_PATTERN);
  });

  it('matches the pattern the frontend and support both key on', () => {
    expect(formatOrderNumber(2026, 100000)).toMatch(ORDER_NUMBER_PATTERN);
    expect(formatOrderNumber(2030, 999999)).toMatch(ORDER_NUMBER_PATTERN);
  });

  /**
   * Every seeded order must satisfy the same pattern, or a test that greps for it passes on generated
   * numbers and fails on the fixtures — which is how a format claim comes to be half true.
   */
  it('accepts the seeded numbers', () => {
    for (const seeded of [
      'NN-2026-004488',
      'NN-2026-004650',
      'NN-2026-004821',
      'NN-2026-004977',
      'NN-2026-005042',
      'NN-2026-005107',
    ]) {
      expect(seeded).toMatch(ORDER_NUMBER_PATTERN);
    }
  });

  it('rejects the shapes that are not order numbers', () => {
    for (const wrong of [
      'NN-2026-12345',
      'nn-2026-100000',
      'NN-26-100000',
      'NN-2026_100000',
      '100000',
      // The last two exist because the docblock calls the pattern "anchored" and, measured, nothing
      // else here holds it to that: dropping both `^` and `$` still rejects all five above, since
      // none of them contains a well-formed order number as a substring. A pattern used to validate
      // a customer-supplied reference must not match one embedded in surrounding junk.
      'XNN-2026-100000',
      'NN-2026-100000X',
    ]) {
      expect(wrong).not.toMatch(ORDER_NUMBER_PATTERN);
    }
  });
});

/**
 * `nextOrderNumber` is the point of the module and the only part of it that talks to Postgres, so it
 * is covered here with a stub `EntityManager` rather than left to the first integration test that
 * happens to place an order. What a stub can prove is the contract this function owns: the sequence it
 * draws from, the year it stamps, and its refusal to turn an unusable reply into an order number. That
 * `nextval` itself is atomic and survives a rollback is Postgres's guarantee, not this function's, and
 * is proven against a real server instead.
 */
describe('nextOrderNumber', () => {
  const managerReturning = (rows: unknown) => {
    const query = jest.fn().mockResolvedValue(rows);
    return { manager: { query } as unknown as EntityManager, query };
  };

  it('draws from the order number sequence and stamps the year of the clock it is given', async () => {
    const { manager, query } = managerReturning([{ nextval: '100000' }]);

    await expect(nextOrderNumber(manager, new Date('2027-03-04T05:06:07Z'))).resolves.toBe(
      'NN-2027-100000',
    );
    // Asserted, because the sequence name is the one thing a caller cannot see it get wrong: drawing
    // from a sequence that does not exist fails loudly, but drawing from the wrong existing one
    // issues plausible duplicates.
    expect(query).toHaveBeenCalledWith(expect.stringContaining('nextval'), [ORDER_NUMBER_SEQUENCE]);
  });

  /**
   * `nextval` comes back over the wire as a string because the column is a bigint, and beyond
   * `Number.MAX_SAFE_INTEGER` that string stops surviving `Number()` intact — 9007199254740993
   * becomes ...992. Two orders would then be handed the same reference by rounding, with the database
   * having done nothing wrong. Refusing is the only safe answer, and it must not be silent.
   */
  it('refuses a value that cannot survive the trip through a JS number', async () => {
    const { manager } = managerReturning([{ nextval: '9007199254740993' }]);
    await expect(nextOrderNumber(manager)).rejects.toThrow(
      'order_number_seq returned 9007199254740993',
    );
  });

  it('refuses an empty result rather than formatting NaN into a reference', async () => {
    const { manager } = managerReturning([]);
    await expect(nextOrderNumber(manager)).rejects.toThrow('order_number_seq returned undefined');
  });
});
