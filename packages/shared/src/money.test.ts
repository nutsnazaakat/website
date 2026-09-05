import { describe, expect, it } from 'vitest';
import { applyFlat, applyPercent, gstOn, sumPaise, toPaise, toRupees } from './money';

describe('toPaise', () => {
  it('converts whole rupees', () => {
    expect(toPaise(1299)).toBe(129900n);
  });

  it('converts two-decimal rupees despite binary float error', () => {
    // 12.34 * 100 is 1233.9999999999998 in IEEE-754. A naive implementation truncates to 1233.
    expect(toPaise(12.34)).toBe(1234n);
    expect(toPaise(0.07)).toBe(7n);
  });

  it('accepts zero', () => {
    expect(toPaise(0)).toBe(0n);
  });

  it('rejects sub-paise precision rather than silently rounding money', () => {
    expect(() => toPaise(12.345)).toThrow(/sub-paise/i);
  });

  it('rejects values that are not finite numbers', () => {
    expect(() => toPaise(Number.NaN)).toThrow(/finite/i);
    expect(() => toPaise(Number.POSITIVE_INFINITY)).toThrow(/finite/i);
  });

  it('rejects negative money', () => {
    expect(() => toPaise(-1)).toThrow(/negative/i);
  });
});

describe('toRupees', () => {
  it('round-trips through toPaise', () => {
    expect(toRupees(toPaise(1299))).toBe(1299);
    expect(toRupees(toPaise(12.34))).toBe(12.34);
  });

  it('renders paise as a fractional rupee value', () => {
    expect(toRupees(7n)).toBe(0.07);
  });
});

describe('gstOn', () => {
  it('computes 5% GST on a round amount', () => {
    // ₹1000 at 5% is ₹50
    expect(gstOn(100000n, 5)).toBe(5000n);
  });

  it('rounds half up at the paise', () => {
    // 1 paise at 50% is 0.5 paise, which rounds up to 1
    expect(gstOn(1n, 50)).toBe(1n);
    // 1 paise at 49% is 0.49 paise, which rounds down to 0
    expect(gstOn(1n, 49)).toBe(0n);
  });

  it('rounds half up at an invoice-realistic magnitude', () => {
    // ₹1000.20 at 2.5% GST is exactly ₹25.005, i.e. 2500.5 paise -- a genuine tie at
    // an invoice-realistic amount, not just at the 1-paise edge case above.
    expect(gstOn(100020n, 2.5)).toBe(2501n);
  });

  it('handles a fractional rate', () => {
    // ₹100 at 2.5% is ₹2.50
    expect(gstOn(10000n, 2.5)).toBe(250n);
  });

  it('returns zero for a zero base', () => {
    expect(gstOn(0n, 5)).toBe(0n);
  });

  it('rejects a negative rate', () => {
    expect(() => gstOn(100n, -5)).toThrow(/rate/i);
  });

  it('rejects a negative base amount', () => {
    expect(() => gstOn(-1n, 5)).toThrow(/negative/i);
  });
});

describe('per-line rounding, spec §8', () => {
  it('sums per-line GST rather than rounding the aggregate', () => {
    // Three lines of ₹33.33 at 5%. Per line: 166.65 paise -> 167 each -> 501 total.
    // Rounding the aggregate instead gives round(499.95) = 500. The invoice must equal
    // the sum of its lines, so 501 is correct.
    const lines = [3333n, 3333n, 3333n];
    const perLine = sumPaise(lines.map((base) => gstOn(base, 5)));
    expect(perLine).toBe(501n);

    const aggregate = gstOn(sumPaise(lines), 5);
    expect(aggregate).toBe(500n);
    expect(perLine).not.toBe(aggregate);
  });
});

describe('sumPaise', () => {
  it('sums an empty list to zero', () => {
    expect(sumPaise([])).toBe(0n);
  });

  it('sums a list', () => {
    expect(sumPaise([100n, 250n, 3n])).toBe(353n);
  });
});

describe('applyPercent', () => {
  it('takes a percentage of the amount', () => {
    expect(applyPercent(100000n, 10)).toBe(10000n);
  });

  it('caps the discount at maxPaise when given', () => {
    expect(applyPercent(100000n, 50, 20000n)).toBe(20000n);
  });

  it('never discounts more than the amount itself', () => {
    expect(applyPercent(5000n, 150)).toBe(5000n);
  });

  it('returns zero for a zero amount', () => {
    expect(applyPercent(0n, 25)).toBe(0n);
  });

  it('rejects a negative amount', () => {
    expect(() => applyPercent(-1n, 10)).toThrow(/negative/i);
  });
});

describe('applyFlat', () => {
  it('returns the flat amount when it fits', () => {
    expect(applyFlat(100000n, 15000n)).toBe(15000n);
  });

  it('clamps to the amount so a total can never go negative', () => {
    expect(applyFlat(10000n, 50000n)).toBe(10000n);
  });

  it('clamps a negative flat discount to zero', () => {
    expect(applyFlat(10000n, -500n)).toBe(0n);
  });

  it('rejects a negative amount', () => {
    expect(() => applyFlat(-1n, 100n)).toThrow(/negative/i);
  });
});
