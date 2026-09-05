import { describe, expect, it } from 'vitest';
import { GSTIN_REGEX, PHONE_REGEX, PINCODE_REGEX } from './identifiers';

describe('PHONE_REGEX', () => {
  it('accepts a valid 10-digit number starting 6, 7, 8 or 9', () => {
    expect(PHONE_REGEX.test('6123456789')).toBe(true);
    expect(PHONE_REGEX.test('7123456789')).toBe(true);
    expect(PHONE_REGEX.test('8123456789')).toBe(true);
    expect(PHONE_REGEX.test('9123456789')).toBe(true);
  });

  it('rejects a number starting 0-5', () => {
    expect(PHONE_REGEX.test('5123456789')).toBe(false);
  });

  it('rejects 9 digits', () => {
    expect(PHONE_REGEX.test('612345678')).toBe(false);
  });

  it('rejects 11 digits', () => {
    expect(PHONE_REGEX.test('61234567890')).toBe(false);
  });

  it('rejects non-digits', () => {
    expect(PHONE_REGEX.test('9abcdefghi')).toBe(false);
  });

  it('rejects a number with surrounding whitespace', () => {
    expect(PHONE_REGEX.test(' 9123456789')).toBe(false);
    expect(PHONE_REGEX.test('9123456789 ')).toBe(false);
  });
});

describe('PINCODE_REGEX', () => {
  it('accepts a valid 6-digit code', () => {
    expect(PINCODE_REGEX.test('400001')).toBe(true);
  });

  it('rejects 5 digits', () => {
    expect(PINCODE_REGEX.test('40001')).toBe(false);
  });

  it('rejects 7 digits', () => {
    expect(PINCODE_REGEX.test('4000011')).toBe(false);
  });

  it('rejects non-digits', () => {
    expect(PINCODE_REGEX.test('ABCDEF')).toBe(false);
  });
});

describe('GSTIN_REGEX', () => {
  it('accepts a valid 15-character GSTIN', () => {
    expect(GSTIN_REGEX.test('27AAPFU0939F1Z5')).toBe(true);
  });

  it('rejects a truncated GSTIN', () => {
    expect(GSTIN_REGEX.test('27AAPFU0939F1Z')).toBe(false);
  });

  it('rejects a lowercase GSTIN', () => {
    expect(GSTIN_REGEX.test('27aapfu0939f1z5')).toBe(false);
  });

  it('rejects a GSTIN whose 14th character is not Z', () => {
    expect(GSTIN_REGEX.test('27AAPFU0939F1A5')).toBe(false);
  });
});
