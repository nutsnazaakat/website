import type { EntityManager } from 'typeorm';
import {
  formatTicketNumber,
  nextTicketNumber,
  TICKET_NUMBER_PATTERN,
  TICKET_NUMBER_SEQUENCE,
} from './ticket-number';

describe('formatTicketNumber', () => {
  it('pads to six digits behind the year', () => {
    expect(formatTicketNumber(2026, 100000)).toBe('ST-2026-100000');
    expect(formatTicketNumber(2026, 1)).toBe('ST-2026-000001');
  });

  it('grows past six digits rather than truncating', () => {
    expect(formatTicketNumber(2026, 1_000_000)).toBe('ST-2026-1000000');
    expect(formatTicketNumber(2026, 1_000_000).length).toBeLessThanOrEqual(20);
    expect(formatTicketNumber(2026, 1_000_000)).toMatch(TICKET_NUMBER_PATTERN);
  });

  it('matches the pattern the frontend keys on', () => {
    expect(formatTicketNumber(2026, 100000)).toMatch(TICKET_NUMBER_PATTERN);
  });

  it('rejects the shapes that are not ticket numbers', () => {
    for (const wrong of [
      'ST-2026-12345',
      'st-2026-100000',
      'ST-26-100000',
      'RFQ-2026-100000',
      'NN-2026-100000',
      '100000',
      'XST-2026-100000',
      'ST-2026-100000X',
    ]) {
      expect(wrong).not.toMatch(TICKET_NUMBER_PATTERN);
    }
  });
});

describe('nextTicketNumber', () => {
  const managerReturning = (rows: unknown) => {
    const query = jest.fn().mockResolvedValue(rows);
    return { manager: { query } as unknown as EntityManager, query };
  };

  it('draws from the ticket number sequence and stamps the year of the clock it is given', async () => {
    const { manager, query } = managerReturning([{ nextval: '100000' }]);

    await expect(nextTicketNumber(manager, new Date('2027-03-04T05:06:07Z'))).resolves.toBe(
      'ST-2027-100000',
    );
    expect(query).toHaveBeenCalledWith(expect.stringContaining('nextval'), [
      TICKET_NUMBER_SEQUENCE,
    ]);
  });

  it('refuses a value that cannot survive the trip through a JS number', async () => {
    const { manager } = managerReturning([{ nextval: '9007199254740993' }]);
    await expect(nextTicketNumber(manager)).rejects.toThrow(
      'ticket_number_seq returned 9007199254740993',
    );
  });

  it('refuses an empty result rather than formatting NaN into a reference', async () => {
    const { manager } = managerReturning([]);
    await expect(nextTicketNumber(manager)).rejects.toThrow('ticket_number_seq returned undefined');
  });
});
