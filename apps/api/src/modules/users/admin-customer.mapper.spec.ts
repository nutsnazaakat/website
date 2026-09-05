import type { SavedAddress } from '@nutwala/shared';
import { CustomerSegment, UserRole } from '../../entities/enums';
import type { Business } from '../../entities/identity/business.entity';
import type { User } from '../../entities/identity/user.entity';
import { NO_ORDER_TOTALS, type CustomerOrderTotals } from '../orders/customer-order-totals';
import {
  toAdminCustomer,
  toAdminCustomerBusiness,
  toAdminCustomerSummary,
} from './admin-customer.mapper';

/**
 * A row that **carries the password hash**, which is the whole point of the fixture.
 *
 * `users.passwordHash` is `select: false`, so a repository `find` leaves it `undefined` and a
 * mapper written as `{ ...user }` would publish nothing today and start publishing a bcrypt hash
 * the moment any query in the module reaches for `addSelect`. Building the fixture with the field
 * present is what makes the key-list assertion below measure the mapper rather than the column's
 * default.
 */
const row = (overrides: Partial<User> = {}): User =>
  ({
    id: 'f0000000-0000-4000-8000-00000000000a',
    name: 'Asha Rao',
    email: 'asha@demo.in',
    phone: '9876543210',
    passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX',
    role: UserRole.CUSTOMER,
    isActive: true,
    lastLoginAt: new Date('2026-08-20T06:00:00.000Z'),
    createdAt: new Date('2026-01-04T09:12:00.000Z'),
    updatedAt: new Date('2026-08-20T06:00:00.000Z'),
    ...overrides,
  }) as unknown as User;

const business = (overrides: Partial<Business> = {}): Business =>
  ({
    id: 'b0000000-0000-4000-8000-00000000000b',
    userId: 'f0000000-0000-4000-8000-00000000000a',
    companyName: 'Sweet Centre',
    contactPerson: 'Asha Rao',
    mobile: '9876543210',
    gstin: '29ABCDE1234F1Z5',
    businessType: 'Sweet shop',
    segment: CustomerSegment.RETAILER,
    billingAddressId: null,
    shippingAddressId: null,
    assignedSalespersonId: 'f0000000-0000-4000-8000-00000000000c',
    createdAt: new Date('2026-01-04T09:12:00.000Z'),
    updatedAt: new Date('2026-01-04T09:12:00.000Z'),
    ...overrides,
  }) as unknown as Business;

const TOTALS: CustomerOrderTotals = {
  orders: 4,
  // 12,345.67 in paise, so a `/ 100` written as float arithmetic would round visibly.
  spendPaise: 1_234_567n,
  lastOrderAt: new Date('2026-08-19T11:30:00.000Z'),
};

const ADDRESS: SavedAddress = {
  id: 'a0000000-0000-4000-8000-00000000000d',
  label: 'Shop',
  isDefault: true,
  fullName: 'Asha Rao',
  phone: '9876543210',
  email: 'asha@demo.in',
  line1: '12 Residency Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560025',
};

describe('toAdminCustomerSummary', () => {
  it('answers exactly the wire contract, field for field', () => {
    expect(toAdminCustomerSummary(row(), TOTALS)).toEqual({
      id: 'f0000000-0000-4000-8000-00000000000a',
      name: 'Asha Rao',
      email: 'asha@demo.in',
      phone: '9876543210',
      role: 'b2c',
      isActive: true,
      orders: 4,
      totalSpend: 12345.67,
      lastOrderAt: '2026-08-19T11:30:00.000Z',
      createdAt: '2026-01-04T09:12:00.000Z',
    });
  });

  /**
   * **The one assertion a spread would fail**, and it is a credential disclosure rather than an
   * untidiness.
   *
   * `AdminCustomerSummary` declares no `passwordHash`, so nothing in the type system objects to a
   * mapper that spreads the entity — the client simply ignores a field it does not know about, and
   * the bcrypt hash ships in the body of an endpoint any admin session can call. Written as an
   * exact key list rather than a `not.toHaveProperty('passwordHash')`, so a *second* internal
   * column added to `User` later is caught by the same case.
   */
  it('publishes no internal column — not the password hash, not the timestamps', () => {
    expect(Object.keys(toAdminCustomerSummary(row(), TOTALS)).sort()).toEqual([
      'createdAt',
      'email',
      'id',
      'isActive',
      'lastOrderAt',
      'name',
      'orders',
      'phone',
      'role',
      'totalSpend',
    ]);
  });

  it('maps a BUSINESS account to the b2b wire role', () => {
    expect(toAdminCustomerSummary(row({ role: UserRole.BUSINESS }), TOTALS).role).toBe('b2b');
  });

  /**
   * An admin is not a customer, and the mapper says so rather than rendering one. The service
   * pins `role <> 'ADMIN'` into every read, so reaching here means that filter was lost — which is
   * a bug to name, not a row to publish with figures no other admin screen agrees with.
   */
  it('refuses to map an ADMIN account', () => {
    expect(() => toAdminCustomerSummary(row({ role: UserRole.ADMIN }), TOTALS)).toThrow(
      /is not a customer/,
    );
  });

  it('answers zero and null for an account that has never ordered', () => {
    const mapped = toAdminCustomerSummary(row(), NO_ORDER_TOTALS);
    expect(mapped.orders).toBe(0);
    expect(mapped.totalSpend).toBe(0);
    expect(mapped.lastOrderAt).toBeNull();
  });
});

describe('toAdminCustomerBusiness', () => {
  it('carries the segment and omits every internal column', () => {
    expect(toAdminCustomerBusiness(business())).toEqual({
      id: 'b0000000-0000-4000-8000-00000000000b',
      companyName: 'Sweet Centre',
      gstin: '29ABCDE1234F1Z5',
      businessType: 'Sweet shop',
      segment: 'retailer',
    });
  });

  it('maps every segment the column can hold', () => {
    const bands = [
      [CustomerSegment.DEFAULT, 'default'],
      [CustomerSegment.RETAILER, 'retailer'],
      [CustomerSegment.DISTRIBUTOR, 'distributor'],
      [CustomerSegment.HORECA, 'horeca'],
    ] as const;
    for (const [column, wire] of bands) {
      expect(toAdminCustomerBusiness(business({ segment: column })).segment).toBe(wire);
    }
  });
});

describe('toAdminCustomer', () => {
  it('is the summary plus the address book and the business record', () => {
    const detail = toAdminCustomer(row({ role: UserRole.BUSINESS }), TOTALS, [ADDRESS], business());

    expect(detail).toMatchObject({
      ...toAdminCustomerSummary(row({ role: UserRole.BUSINESS }), TOTALS),
      lastLoginAt: '2026-08-20T06:00:00.000Z',
      addresses: [ADDRESS],
    });
    expect(detail.business?.companyName).toBe('Sweet Centre');
  });

  it('carries no business for a b2c account, and no password hash either', () => {
    const detail = toAdminCustomer(row(), TOTALS, [], null);
    expect(detail.business).toBeNull();
    expect(Object.keys(detail).sort()).toEqual([
      'addresses',
      'business',
      'createdAt',
      'email',
      'id',
      'isActive',
      'lastLoginAt',
      'lastOrderAt',
      'name',
      'orders',
      'phone',
      'role',
      'totalSpend',
    ]);
  });

  it('answers null for an account that has never signed in', () => {
    expect(toAdminCustomer(row({ lastLoginAt: null }), TOTALS, [], null).lastLoginAt).toBeNull();
  });
});
