// shared/src/constants/rfq-status.test.ts
import { describe, expect, it } from 'vitest';
import { canTransitionRfq, nextRfqStatuses, RFQ_TRANSITIONS } from './rfq-status';
import { RFQ_STATUSES } from './taxonomy';

describe('RFQ_TRANSITIONS', () => {
  it('has exactly one entry per status in RFQ_STATUSES', () => {
    expect(Object.keys(RFQ_TRANSITIONS).sort()).toEqual([...RFQ_STATUSES].sort());
  });

  it('allows each forward step of the happy path', () => {
    expect(canTransitionRfq('new', 'contacted')).toBe(true);
    expect(canTransitionRfq('contacted', 'quote-sent')).toBe(true);
    expect(canTransitionRfq('quote-sent', 'negotiation')).toBe(true);
    expect(canTransitionRfq('negotiation', 'approved')).toBe(true);
    expect(canTransitionRfq('approved', 'converted')).toBe(true);
  });

  it('lets a prospect be turned away at either pre-quote stage', () => {
    expect(canTransitionRfq('new', 'rejected')).toBe(true);
    expect(canTransitionRfq('contacted', 'rejected')).toBe(true);
  });

  it('lets a quote be rejected outright, or after negotiation', () => {
    expect(canTransitionRfq('quote-sent', 'rejected')).toBe(true);
    expect(canTransitionRfq('negotiation', 'rejected')).toBe(true);
  });

  it('lets a sent quote skip negotiation and go straight to approved', () => {
    expect(canTransitionRfq('quote-sent', 'approved')).toBe(true);
  });

  it('refuses to move backwards', () => {
    expect(canTransitionRfq('approved', 'new')).toBe(false);
    expect(canTransitionRfq('negotiation', 'contacted')).toBe(false);
  });

  it('refuses a no-op', () => {
    for (const status of RFQ_STATUSES) {
      expect(canTransitionRfq(status, status)).toBe(false);
    }
  });

  it('treats rejected and converted as terminal', () => {
    expect(nextRfqStatuses('rejected')).toEqual([]);
    expect(nextRfqStatuses('converted')).toEqual([]);
  });

  it('refuses to skip straight from new to approved', () => {
    expect(canTransitionRfq('new', 'approved')).toBe(false);
  });
});
