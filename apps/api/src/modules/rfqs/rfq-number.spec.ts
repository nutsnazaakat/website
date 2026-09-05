import type { EntityManager } from 'typeorm';
import {
  formatRfqNumber,
  nextRfqNumber,
  RFQ_NUMBER_PATTERN,
  RFQ_NUMBER_SEQUENCE,
} from './rfq-number';

describe('formatRfqNumber', () => {
  it('pads to six digits behind the year', () => {
    expect(formatRfqNumber(2026, 100000)).toBe('RFQ-2026-100000');
    expect(formatRfqNumber(2026, 1)).toBe('RFQ-2026-000001');
  });

  /**
   * The column is `varchar(20)` and `RFQ-2026-1000000` is 16 characters, so a seventh digit fits.
   * Truncating to keep six would start re-issuing numbers that already exist — a unique violation
   * on the millionth RFQ, which is a good problem to have and a terrible way to meet it.
   *
   * The `toMatch` is not decoration. Measured: with only the two assertions above, tightening
   * `RFQ_NUMBER_PATTERN` to `\d{6}` passes every other test in this file, so the pattern would
   * come to reject the very string `formatRfqNumber` is documented to produce. This line is the
   * only thing that makes the `{6,}` in that pattern load-bearing.
   */
  it('grows past six digits rather than truncating', () => {
    expect(formatRfqNumber(2026, 1_000_000)).toBe('RFQ-2026-1000000');
    expect(formatRfqNumber(2026, 1_000_000).length).toBeLessThanOrEqual(20);
    expect(formatRfqNumber(2026, 1_000_000)).toMatch(RFQ_NUMBER_PATTERN);
  });

  it('matches the pattern the frontend and support both key on', () => {
    expect(formatRfqNumber(2026, 100000)).toMatch(RFQ_NUMBER_PATTERN);
    expect(formatRfqNumber(2030, 999999)).toMatch(RFQ_NUMBER_PATTERN);
  });

  /** A number stamped with a different year still matches — the pattern names no specific one. */
  it('matches regardless of which year it was stamped with', () => {
    expect(formatRfqNumber(1999, 100000)).toMatch(RFQ_NUMBER_PATTERN);
    expect(formatRfqNumber(2099, 100000)).toMatch(RFQ_NUMBER_PATTERN);
  });

  it('rejects the shapes that are not RFQ numbers', () => {
    for (const wrong of [
      'RFQ-2026-12345', // five digits — the honest negative `{6,}` exists to catch
      'rfq-2026-100000',
      'RFQ-26-100000',
      'RFQ-2026_100000',
      '100000',
      'NN-2026-100000', // an order number, not an RFQ number — the two must not cross-match
      // These two exist because the pattern is anchored, and — measured — nothing else in this
      // file holds it to that: dropping both `^` and `$` still rejects every case above, since
      // none of them contains a well-formed RFQ number as a substring. A pattern used to validate
      // a customer-supplied reference must not match one embedded in surrounding junk.
      'XRFQ-2026-100000',
      'RFQ-2026-100000X',
    ]) {
      expect(wrong).not.toMatch(RFQ_NUMBER_PATTERN);
    }
  });
});

/**
 * `nextRfqNumber` is the point of the module and the only part of it that talks to Postgres, so
 * it is covered here with a stub `EntityManager` rather than left to the first integration test
 * that happens to create an RFQ. What a stub can prove is the contract this function owns: the
 * sequence it draws from, the year it stamps, and its refusal to turn an unusable reply into an
 * RFQ number. That `nextval` itself is atomic and survives a rollback is Postgres's guarantee,
 * not this function's, and is proven against a real server instead.
 */
describe('nextRfqNumber', () => {
  const managerReturning = (rows: unknown) => {
    const query = jest.fn().mockResolvedValue(rows);
    return { manager: { query } as unknown as EntityManager, query };
  };

  it('draws from the RFQ number sequence and stamps the year of the clock it is given', async () => {
    const { manager, query } = managerReturning([{ nextval: '100000' }]);

    await expect(nextRfqNumber(manager, new Date('2027-03-04T05:06:07Z'))).resolves.toBe(
      'RFQ-2027-100000',
    );
    // Asserted, because the sequence name is the one thing a caller cannot see it get wrong:
    // drawing from a sequence that does not exist fails loudly, but drawing from the wrong
    // existing one — `order_number_seq`, say — issues plausible-looking duplicates.
    expect(query).toHaveBeenCalledWith(expect.stringContaining('nextval'), [RFQ_NUMBER_SEQUENCE]);
  });

  /**
   * `nextval` comes back over the wire as a string because the column is a bigint, and beyond
   * `Number.MAX_SAFE_INTEGER` that string stops surviving `Number()` intact — 9007199254740993
   * becomes ...992. Two RFQs would then be handed the same reference by rounding, with the
   * database having done nothing wrong. Refusing is the only safe answer, and it must not be
   * silent — a formatted `RFQ-2026-NaN` would be the alternative, and it would still look like a
   * reference until someone tried to look it up.
   */
  it('refuses a value that cannot survive the trip through a JS number', async () => {
    const { manager } = managerReturning([{ nextval: '9007199254740993' }]);
    await expect(nextRfqNumber(manager)).rejects.toThrow(
      'rfq_number_seq returned 9007199254740993',
    );
  });

  it('refuses an empty result rather than formatting NaN into a reference', async () => {
    const { manager } = managerReturning([]);
    await expect(nextRfqNumber(manager)).rejects.toThrow('rfq_number_seq returned undefined');
  });
});
