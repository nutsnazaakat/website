import { describe, expect, it } from 'vitest';
import { CUSTOMER_SEGMENTS } from './taxonomy';

describe('CUSTOMER_SEGMENTS — brief §16/§31', () => {
  it('lists the four segments, lowercase, DEFAULT first', () => {
    expect(CUSTOMER_SEGMENTS).toEqual(['default', 'retailer', 'distributor', 'horeca']);
  });
});
