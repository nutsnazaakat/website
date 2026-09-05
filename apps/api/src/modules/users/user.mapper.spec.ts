import { UserRole } from '../../entities/enums';
import type { User } from '../../entities/identity/user.entity';
import { toAuthUser, toUserRole } from './user.mapper';

function userFixture(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    name: 'Retail Customer',
    email: 'b2c@demo.in',
    phone: '9876543210',
    passwordHash: '$2b$10$hash',
    role: UserRole.CUSTOMER,
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    business: null,
    addresses: [],
    sessions: [],
    ...overrides,
  };
}

describe('toAuthUser', () => {
  it('maps CUSTOMER to the wire role b2c', () => {
    expect(toAuthUser(userFixture()).role).toBe('b2c');
  });

  it('maps BUSINESS to b2b and ADMIN to admin', () => {
    expect(toAuthUser(userFixture({ role: UserRole.BUSINESS })).role).toBe('b2b');
    expect(toAuthUser(userFixture({ role: UserRole.ADMIN })).role).toBe('admin');
  });

  it('never includes the password hash', () => {
    const result: Record<string, unknown> = { ...toAuthUser(userFixture()) };
    expect(result.passwordHash).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('$2b$');
  });

  it('serialises createdAt as an ISO string, matching the frontend type', () => {
    expect(toAuthUser(userFixture()).createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('includes company details only for a business account', () => {
    expect(toAuthUser(userFixture()).company).toBeUndefined();

    const withBusiness = userFixture({
      role: UserRole.BUSINESS,
      business: {
        companyName: 'Sharma Sweets',
        contactPerson: 'R Sharma',
        businessType: 'Sweet shop',
        gstin: '27AAPFU0939F1ZV',
      } as never,
    });
    expect(toAuthUser(withBusiness).company).toEqual({
      companyName: 'Sharma Sweets',
      contactPerson: 'R Sharma',
      businessType: 'Sweet shop',
      gstin: '27AAPFU0939F1ZV',
    });
  });
});

describe('toUserRole', () => {
  it('maps the wire role back to the database enum', () => {
    expect(toUserRole('b2c')).toBe(UserRole.CUSTOMER);
    expect(toUserRole('b2b')).toBe(UserRole.BUSINESS);
    expect(toUserRole('admin')).toBe(UserRole.ADMIN);
  });
});
