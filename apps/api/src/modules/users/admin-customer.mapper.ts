import { toRupees } from '@nutwala/shared';
import type {
  AdminCustomer,
  AdminCustomerBusiness,
  AdminCustomerSummary,
  CustomerSegment,
  Role,
  SavedAddress,
} from '@nutwala/shared';
import { CustomerSegment as CustomerSegmentEnum, UserRole } from '../../entities/enums';
import type { Business } from '../../entities/identity/business.entity';
import type { User } from '../../entities/identity/user.entity';
import type { CustomerOrderTotals } from '../orders/customer-order-totals';

/**
 * The wire role, `b2c` or `b2b` — and **not** `toAuthUser`'s map, deliberately.
 *
 * `user.mapper.ts`'s `TO_WIRE` is a total `Record<UserRole, Role>` including `ADMIN`, because an
 * admin signing in gets an `AuthUser`. A *customer* row cannot be an admin: `AdminCustomersService`
 * refuses to list or return one, so `ADMIN` reaching here is a bug in that filter rather than a
 * value to render. Throwing names it at the one place it could be caught, instead of publishing a
 * `role: "admin"` customer whose figures nothing else on the console agrees with.
 */
function toCustomerRole(role: UserRole, userId: string): Role {
  if (role === UserRole.CUSTOMER) return 'b2c';
  if (role === UserRole.BUSINESS) return 'b2b';
  throw new Error(`User ${userId} has role ${role} and is not a customer`);
}

/**
 * `businesses.segment` is a Postgres enum in `UPPERCASE`; the wire vocabulary is the lowercase
 * `CUSTOMER_SEGMENTS` tuple. A total `Record` in both directions, so a fifth band added to either
 * side is a compile error rather than an unmapped row — the same guard `businesses.service.ts`'s
 * `_segmentsMap` keeps, written the other way round because this one is actually called.
 */
const SEGMENT: Record<CustomerSegmentEnum, CustomerSegment> = {
  [CustomerSegmentEnum.DEFAULT]: 'default',
  [CustomerSegmentEnum.RETAILER]: 'retailer',
  [CustomerSegmentEnum.DISTRIBUTOR]: 'distributor',
  [CustomerSegmentEnum.HORECA]: 'horeca',
};

export function toWireSegment(segment: CustomerSegmentEnum): CustomerSegment {
  return SEGMENT[segment];
}

/**
 * `User` → `AdminCustomerSummary`, for `GET /admin/customers`' row shape.
 *
 * **Built field by field, never a spread, and this one is a disclosure rather than an
 * untidiness.** `User` carries `passwordHash`. The column is `select: false`, so an ordinary
 * `find` does not load it and a spread would publish `undefined` today — which is exactly what
 * makes the spread dangerous: it would look correct, pass every test that checks the visible
 * fields, and start leaking the bcrypt hash the day any query in this module reaches for
 * `addSelect('user.passwordHash')` or hand-writes a `SELECT *`. `AdminCustomerSummary` declares no
 * such field, so nothing in the type system would object either.
 * `admin-customer.mapper.spec.ts` asserts the exact key list against a row that *does* carry the
 * hash, so the spread fails there rather than in production.
 */
export function toAdminCustomerSummary(
  user: User,
  totals: CustomerOrderTotals,
): AdminCustomerSummary {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: toCustomerRole(user.role, user.id),
    isActive: user.isActive,
    orders: totals.orders,
    totalSpend: toRupees(totals.spendPaise),
    lastOrderAt: totals.lastOrderAt === null ? null : totals.lastOrderAt.toISOString(),
    createdAt: user.createdAt.toISOString(),
  };
}

/** The business record on a `b2b` account's detail. Field by field, for the reason above — a bare
 * `Business` carries `assignedSalespersonId` and both address references, none of which this shape
 * declares. */
export function toAdminCustomerBusiness(business: Business): AdminCustomerBusiness {
  return {
    id: business.id,
    companyName: business.companyName,
    gstin: business.gstin,
    businessType: business.businessType,
    segment: toWireSegment(business.segment),
  };
}

/** `User` → `AdminCustomer`, for `GET /admin/customers/:id`. The summary plus what a list row
 * cannot afford: the address book and the business record. */
export function toAdminCustomer(
  user: User,
  totals: CustomerOrderTotals,
  addresses: SavedAddress[],
  business: Business | null,
): AdminCustomer {
  return {
    ...toAdminCustomerSummary(user, totals),
    lastLoginAt: user.lastLoginAt === null ? null : user.lastLoginAt.toISOString(),
    addresses,
    business: business === null ? null : toAdminCustomerBusiness(business),
  };
}
