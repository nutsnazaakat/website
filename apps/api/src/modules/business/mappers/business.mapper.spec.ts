import type { Address } from '../../../entities/identity/address.entity';
import type { Business } from '../../../entities/identity/business.entity';
import { CustomerSegment } from '../../../entities/enums';
import { toBusinessProfile } from './business.mapper';

const businessRow = (overrides: Partial<Business> = {}): Business =>
  ({
    id: 'b1000000-0000-4000-8000-000000000001',
    userId: 'f0000000-0000-4000-8000-00000000000a',
    companyName: 'Anand Sweets & Namkeen',
    contactPerson: 'Rakesh Anand',
    mobile: '9845012345',
    gstin: '29ABCDE1234F1Z5',
    businessType: 'Sweet shop',
    segment: CustomerSegment.RETAILER,
    billingAddressId: 'a1000000-0000-4000-8000-000000000001',
    shippingAddressId: 'a2000000-0000-4000-8000-000000000002',
    assignedSalespersonId: 'u1000000-0000-4000-8000-000000000009',
    createdAt: new Date('2025-06-18T05:40:00.000Z'),
    updatedAt: new Date('2025-06-18T05:40:00.000Z'),
    ...overrides,
  }) as unknown as Business;

const addressRow = (overrides: Partial<Address> = {}): Address =>
  ({
    id: 'a1000000-0000-4000-8000-000000000001',
    userId: 'f0000000-0000-4000-8000-00000000000a',
    label: 'Warehouse',
    fullName: 'Rakesh Anand',
    phone: '9845012345',
    email: 'purchase@anandsweets.example',
    line1: '12 Industrial Estate',
    line2: null,
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560004',
    isDefault: true,
    deletedAt: null,
    createdAt: new Date('2025-06-18T05:40:00.000Z'),
    updatedAt: new Date('2025-06-18T05:40:00.000Z'),
    ...overrides,
  }) as unknown as Address;

describe('toBusinessProfile', () => {
  it('answers exactly the wire contract, with both addresses resolved', () => {
    const billing = addressRow();
    const shipping = addressRow({
      id: 'a2000000-0000-4000-8000-000000000002',
      label: 'Shop front',
    });

    expect(toBusinessProfile({ business: businessRow(), billing, shipping })).toEqual({
      companyName: 'Anand Sweets & Namkeen',
      contactPerson: 'Rakesh Anand',
      mobile: '9845012345',
      gstin: '29ABCDE1234F1Z5',
      businessType: 'Sweet shop',
      billingAddress: {
        id: 'a1000000-0000-4000-8000-000000000001',
        label: 'Warehouse',
        isDefault: true,
        fullName: 'Rakesh Anand',
        phone: '9845012345',
        email: 'purchase@anandsweets.example',
        line1: '12 Industrial Estate',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560004',
      },
      shippingAddress: {
        id: 'a2000000-0000-4000-8000-000000000002',
        label: 'Shop front',
        isDefault: true,
        fullName: 'Rakesh Anand',
        phone: '9845012345',
        email: 'purchase@anandsweets.example',
        line1: '12 Industrial Estate',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560004',
      },
    });
  });

  it('answers null for both addresses when neither reference resolves', () => {
    const profile = toBusinessProfile({ business: businessRow(), billing: null, shipping: null });
    expect(profile.billingAddress).toBeNull();
    expect(profile.shippingAddress).toBeNull();
  });

  it('omits gstin when the business has none', () => {
    const profile = toBusinessProfile({
      business: businessRow({ gstin: null }),
      billing: null,
      shipping: null,
    });
    expect(profile).not.toHaveProperty('gstin');
  });

  it('carries an empty mobile through as-is, rather than inventing a placeholder', () => {
    const profile = toBusinessProfile({
      business: businessRow({ mobile: '' }),
      billing: null,
      shipping: null,
    });
    expect(profile.mobile).toBe('');
  });

  /**
   * **The one assertion a spread would fail.** `segment` and `assignedSalespersonId` are both on
   * `Business`, and nothing in the type system objects to sending either — `BusinessProfile` has
   * no such fields, so a spread would ship them silently. Written as an exact key list, and
   * against the *values* too, not only the field names: a mapper that renamed `segment` to
   * `tier` before sending it would pass a name-only check while leaking exactly the same fact.
   */
  it('publishes no internal column — not segment, not the salesperson, not the owner', () => {
    const profile = toBusinessProfile({ business: businessRow(), billing: null, shipping: null });
    expect(Object.keys(profile).sort()).toEqual([
      'billingAddress',
      'businessType',
      'companyName',
      'contactPerson',
      'gstin',
      'mobile',
      'shippingAddress',
    ]);

    const serialised = JSON.stringify(profile);
    expect(serialised).not.toContain('retailer');
    expect(serialised).not.toContain('RETAILER');
    expect(serialised).not.toContain('u1000000-0000-4000-8000-000000000009');
    expect(serialised).not.toContain('segment');
    expect(serialised).not.toContain('assignedSalesperson');
  });
});
