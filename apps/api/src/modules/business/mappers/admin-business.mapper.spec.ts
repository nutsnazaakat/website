import { CustomerSegment, UserRole } from '../../../entities/enums';
import type { Address } from '../../../entities/identity/address.entity';
import type { Business } from '../../../entities/identity/business.entity';
import type { User } from '../../../entities/identity/user.entity';
import type { CustomerOrderTotals } from '../../orders/customer-order-totals';
import {
  NO_RFQ_COUNTS,
  toAdminBusiness,
  toAdminBusinessSummary,
  toAdminSalesperson,
  type AdminBusinessRow,
} from './admin-business.mapper';

const business = (overrides: Partial<Business> = {}): Business =>
  ({
    id: 'b0000000-0000-4000-8000-00000000000b',
    userId: 'f0000000-0000-4000-8000-00000000000a',
    companyName: 'Anand Sweets',
    contactPerson: 'Ravi Kumar',
    mobile: '9812345670',
    gstin: '29ABCDE1234F1Z5',
    businessType: 'Sweet shop',
    segment: CustomerSegment.RETAILER,
    billingAddressId: null,
    shippingAddressId: null,
    assignedSalespersonId: null,
    createdAt: new Date('2026-02-01T09:00:00.000Z'),
    updatedAt: new Date('2026-02-01T09:00:00.000Z'),
    ...overrides,
  }) as unknown as Business;

/** Carries the password hash on purpose — see `toAdminSalesperson`'s docblock and the key-list
 * assertion below. */
const account = (overrides: Partial<User> = {}): User =>
  ({
    id: 'f0000000-0000-4000-8000-00000000000a',
    name: 'Ravi Kumar',
    email: 'ravi@anandsweets.in',
    phone: '9812345670',
    passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX',
    role: UserRole.BUSINESS,
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date('2026-02-01T09:00:00.000Z'),
    updatedAt: new Date('2026-02-01T09:00:00.000Z'),
    ...overrides,
  }) as unknown as User;

const address = (overrides: Partial<Address> = {}): Address =>
  ({
    id: 'a0000000-0000-4000-8000-00000000000d',
    userId: 'f0000000-0000-4000-8000-00000000000a',
    label: 'Warehouse',
    fullName: 'Ravi Kumar',
    phone: '9812345670',
    email: 'ravi@anandsweets.in',
    line1: '9 Industrial Estate',
    line2: null,
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560058',
    isDefault: true,
    deletedAt: null,
    createdAt: new Date('2026-02-01T09:00:00.000Z'),
    updatedAt: new Date('2026-02-01T09:00:00.000Z'),
    ...overrides,
  }) as unknown as Address;

const TOTALS: CustomerOrderTotals = {
  orders: 6,
  spendPaise: 4_567_800n,
  lastOrderAt: new Date('2026-08-18T07:45:00.000Z'),
};

const row = (overrides: Partial<AdminBusinessRow> = {}): AdminBusinessRow => ({
  resolved: { business: business(), billing: null, shipping: null },
  account: account(),
  totals: TOTALS,
  rfqCounts: { rfqs: 5, openRfqs: 2 },
  salesperson: null,
  ...overrides,
});

describe('toAdminSalesperson', () => {
  /**
   * A salesperson is a `User` row, so a spread would publish the bcrypt hash — and
   * `AdminSalesperson` declares no such field, so nothing in the type system would object.
   */
  it('publishes three fields and never the password hash', () => {
    expect(toAdminSalesperson(account())).toEqual({
      id: 'f0000000-0000-4000-8000-00000000000a',
      name: 'Ravi Kumar',
      email: 'ravi@anandsweets.in',
    });
  });
});

describe('toAdminBusinessSummary', () => {
  it('answers brief §35’s B2B profile, field for field', () => {
    expect(toAdminBusinessSummary(row())).toEqual({
      id: 'b0000000-0000-4000-8000-00000000000b',
      userId: 'f0000000-0000-4000-8000-00000000000a',
      companyName: 'Anand Sweets',
      contactPerson: 'Ravi Kumar',
      mobile: '9812345670',
      email: 'ravi@anandsweets.in',
      gstin: '29ABCDE1234F1Z5',
      businessType: 'Sweet shop',
      segment: 'retailer',
      orders: 6,
      totalSpend: 45678,
      lastOrderAt: '2026-08-18T07:45:00.000Z',
      rfqs: 5,
      openRfqs: 2,
      assignedSalesperson: null,
      createdAt: '2026-02-01T09:00:00.000Z',
    });
  });

  /**
   * **The one assertion a spread would fail.** `Business` carries both address reference columns,
   * which `AdminBusiness` replaces with resolved rows, and the account behind it carries a password
   * hash. Written as an exact key list so a column added to either entity later is caught here.
   */
  it('publishes no reference column and no field from the account beyond its email', () => {
    expect(Object.keys(toAdminBusinessSummary(row())).sort()).toEqual([
      'assignedSalesperson',
      'businessType',
      'companyName',
      'contactPerson',
      'createdAt',
      'email',
      'gstin',
      'id',
      'lastOrderAt',
      'mobile',
      'openRfqs',
      'orders',
      'rfqs',
      'segment',
      'totalSpend',
      'userId',
    ]);
  });

  /**
   * `segment` and `assignedSalespersonId` are exactly the two fields `toBusinessProfile` refuses to
   * put on the customer's own payload. This mapper is the one place they are let through, because
   * the operator is the party they are about.
   */
  it('carries the segment and the assigned salesperson the customer’s own profile hides', () => {
    const mapped = toAdminBusinessSummary(
      row({
        resolved: {
          business: business({
            segment: CustomerSegment.HORECA,
            assignedSalespersonId: 'f0000000-0000-4000-8000-00000000000c',
          }),
          billing: null,
          shipping: null,
        },
        salesperson: account({
          id: 'f0000000-0000-4000-8000-00000000000c',
          name: 'Priya Desk',
          email: 'priya@nutsandnazaakat.in',
          role: UserRole.ADMIN,
        }),
      }),
    );

    expect(mapped.segment).toBe('horeca');
    expect(mapped.assignedSalesperson).toEqual({
      id: 'f0000000-0000-4000-8000-00000000000c',
      name: 'Priya Desk',
      email: 'priya@nutsandnazaakat.in',
    });
  });

  it('answers zeroes for a business that has neither ordered nor enquired', () => {
    const mapped = toAdminBusinessSummary(
      row({ totals: { orders: 0, spendPaise: 0n, lastOrderAt: null }, rfqCounts: NO_RFQ_COUNTS }),
    );
    expect(mapped).toMatchObject({
      orders: 0,
      totalSpend: 0,
      lastOrderAt: null,
      rfqs: 0,
      openRfqs: 0,
    });
  });

  it('carries the empty mobile a business that never filled in its profile has', () => {
    expect(
      toAdminBusinessSummary(
        row({ resolved: { business: business({ mobile: '' }), billing: null, shipping: null } }),
      ).mobile,
    ).toBe('');
  });
});

describe('toAdminBusiness', () => {
  it('is the summary plus the two resolved addresses', () => {
    const detail = toAdminBusiness(
      row({ resolved: { business: business(), billing: address(), shipping: null } }),
    );

    expect(detail).toMatchObject(toAdminBusinessSummary(row()));
    expect(detail.billingAddress).toMatchObject({ label: 'Warehouse', pincode: '560058' });
    expect(detail.shippingAddress).toBeNull();
  });

  /** `toSavedAddress` is the shared mapper, so the operator reads the address the customer's own
   * book shows — `userId` and `deletedAt` included in what it strips. */
  it('publishes no owner and no tombstone on a resolved address', () => {
    const detail = toAdminBusiness(
      row({ resolved: { business: business(), billing: address(), shipping: null } }),
    );
    expect(JSON.stringify(detail.billingAddress)).not.toContain('userId');
    expect(JSON.stringify(detail.billingAddress)).not.toContain('deletedAt');
  });
});
