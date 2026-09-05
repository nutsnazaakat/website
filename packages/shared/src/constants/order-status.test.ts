import { describe, expect, it } from 'vitest';
import {
  B2B_ORDER_STATUSES,
  B2C_ORDER_STATUSES,
  canTransition,
  isTerminalStatus,
  nextStatuses,
} from './order-status';

describe('status vocabularies match brief §33 verbatim', () => {
  it('lists the nine retail statuses in order', () => {
    expect(B2C_ORDER_STATUSES).toEqual([
      'pending',
      'confirmed',
      'processing',
      'packed',
      'shipped',
      'out-for-delivery',
      'delivered',
      'cancelled',
      'refunded',
    ]);
  });

  it('lists the eight bulk statuses in order', () => {
    expect(B2B_ORDER_STATUSES).toEqual([
      'quote-requested',
      'quote-sent',
      'quote-accepted',
      'awaiting-payment',
      'approved',
      'processing',
      'shipped',
      'delivered',
    ]);
  });
});

describe('canTransition — retail', () => {
  it('allows each forward step of the happy path', () => {
    expect(canTransition('retail', 'pending', 'confirmed')).toBe(true);
    expect(canTransition('retail', 'confirmed', 'processing')).toBe(true);
    expect(canTransition('retail', 'processing', 'packed')).toBe(true);
    expect(canTransition('retail', 'packed', 'shipped')).toBe(true);
    expect(canTransition('retail', 'shipped', 'out-for-delivery')).toBe(true);
    expect(canTransition('retail', 'out-for-delivery', 'delivered')).toBe(true);
  });

  it('refuses to move backwards', () => {
    expect(canTransition('retail', 'delivered', 'pending')).toBe(false);
    expect(canTransition('retail', 'shipped', 'packed')).toBe(false);
  });

  it('refuses to skip a step', () => {
    expect(canTransition('retail', 'pending', 'shipped')).toBe(false);
    expect(canTransition('retail', 'confirmed', 'delivered')).toBe(false);
  });

  it('allows cancellation up to and including packed, but not after dispatch', () => {
    expect(canTransition('retail', 'pending', 'cancelled')).toBe(true);
    expect(canTransition('retail', 'confirmed', 'cancelled')).toBe(true);
    expect(canTransition('retail', 'processing', 'cancelled')).toBe(true);
    expect(canTransition('retail', 'packed', 'cancelled')).toBe(true);
    expect(canTransition('retail', 'shipped', 'cancelled')).toBe(false);
    expect(canTransition('retail', 'delivered', 'cancelled')).toBe(false);
  });

  it('allows a refund only from delivered', () => {
    expect(canTransition('retail', 'delivered', 'refunded')).toBe(true);
    expect(canTransition('retail', 'shipped', 'refunded')).toBe(false);
  });

  it('treats cancelled and refunded as terminal', () => {
    expect(nextStatuses('retail', 'cancelled')).toEqual([]);
    expect(nextStatuses('retail', 'refunded')).toEqual([]);
    expect(isTerminalStatus('retail', 'cancelled')).toBe(true);
    expect(isTerminalStatus('retail', 'refunded')).toBe(true);
    expect(isTerminalStatus('retail', 'delivered')).toBe(false);
  });

  it('throws rather than silently call a cross-channel status terminal', () => {
    expect(() => isTerminalStatus('retail', 'quote-sent')).toThrow(RangeError);
    expect(() => isTerminalStatus('bulk', 'packed')).toThrow(RangeError);
  });

  it('rejects a status that is not in the retail vocabulary', () => {
    expect(canTransition('retail', 'pending', 'quote-sent')).toBe(false);
  });

  it('refuses a no-op transition, so a duplicate admin click is not recorded twice', () => {
    expect(canTransition('retail', 'confirmed', 'confirmed')).toBe(false);
  });
});

describe('canTransition — bulk', () => {
  it('walks the quote-first pipeline', () => {
    expect(canTransition('bulk', 'quote-requested', 'quote-sent')).toBe(true);
    expect(canTransition('bulk', 'quote-sent', 'quote-accepted')).toBe(true);
    expect(canTransition('bulk', 'quote-accepted', 'awaiting-payment')).toBe(true);
    expect(canTransition('bulk', 'awaiting-payment', 'approved')).toBe(true);
    expect(canTransition('bulk', 'approved', 'processing')).toBe(true);
    expect(canTransition('bulk', 'processing', 'shipped')).toBe(true);
    expect(canTransition('bulk', 'shipped', 'delivered')).toBe(true);
  });

  it('does not accept retail-only statuses', () => {
    expect(canTransition('bulk', 'processing', 'packed')).toBe(false);
    expect(canTransition('bulk', 'delivered', 'refunded')).toBe(false);
  });

  it('ends at delivered', () => {
    expect(isTerminalStatus('bulk', 'delivered')).toBe(true);
  });
});
