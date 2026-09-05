import { toRupees } from '@nutwala/shared';
import type { AdminBusiness, AdminBusinessSummary, AdminSalesperson } from '@nutwala/shared';
import type { User } from '../../../entities/identity/user.entity';
import { toSavedAddress } from '../../addresses/mappers/address.mapper';
import { toWireSegment } from '../../users/admin-customer.mapper';
import type { CustomerOrderTotals } from '../../orders/customer-order-totals';
import type { ResolvedBusiness } from './business.mapper';

/** How many enquiries this account has raised, and how many are still being worked. Computed in
 * SQL by `AdminBusinessesService`, so a page of businesses costs one statement rather than one per
 * row. */
export interface BusinessRfqCounts {
  rfqs: number;
  openRfqs: number;
}

/** No enquiries at all — what an account the aggregate returned no row for gets. */
export const NO_RFQ_COUNTS: BusinessRfqCounts = { rfqs: 0, openRfqs: 0 };

/**
 * Everything the admin business shapes are built from, gathered by the service so the mapper reads
 * rather than queries.
 *
 * `account` is the `users` row the business belongs to — 1:1, and where `email` comes from, since
 * `businesses` has no email column of its own. `salesperson` is the resolved
 * `assigned_salesperson_id`, or `null`; the column is `ON DELETE SET NULL`, so an admin who leaves
 * takes the assignment with them rather than blocking their own deletion.
 */
export interface AdminBusinessRow {
  resolved: ResolvedBusiness;
  account: User;
  totals: CustomerOrderTotals;
  rfqCounts: BusinessRfqCounts;
  salesperson: User | null;
}

/**
 * An admin account named as somebody's salesperson — brief §34/§35.
 *
 * Field by field, never a spread, and here the reason is the same one `toAdminCustomerSummary`
 * states at length: the row is a `User` and carries `passwordHash`. A spread would publish it the
 * day any query in either module reaches for `addSelect`, and `AdminSalesperson` declares no such
 * field so nothing in the type system would object.
 */
export function toAdminSalesperson(user: User): AdminSalesperson {
  return { id: user.id, name: user.name, email: user.email };
}

/**
 * `Business` → `AdminBusinessSummary`, for `GET /admin/businesses`' row shape — **brief §35's B2B
 * profile**: company, GSTIN, business type, orders, total spend, RFQs, last order, assigned
 * salesperson.
 *
 * **Built field by field, never a spread**, exactly as `toBusinessProfile` is and for the
 * complementary reason. That mapper is the wall that keeps `segment` and `assignedSalespersonId`
 * *off* the customer's own payload; this one is the only place they are deliberately let through,
 * because the operator is the party those two facts are about — and both address reference columns
 * are still omitted, since `AdminBusiness` carries the resolved rows instead.
 */
export function toAdminBusinessSummary(row: AdminBusinessRow): AdminBusinessSummary {
  const { business } = row.resolved;
  return {
    id: business.id,
    userId: business.userId,
    companyName: business.companyName,
    contactPerson: business.contactPerson,
    mobile: business.mobile,
    email: row.account.email,
    gstin: business.gstin,
    businessType: business.businessType,
    segment: toWireSegment(business.segment),
    orders: row.totals.orders,
    totalSpend: toRupees(row.totals.spendPaise),
    lastOrderAt: row.totals.lastOrderAt === null ? null : row.totals.lastOrderAt.toISOString(),
    rfqs: row.rfqCounts.rfqs,
    openRfqs: row.rfqCounts.openRfqs,
    assignedSalesperson: row.salesperson === null ? null : toAdminSalesperson(row.salesperson),
    createdAt: business.createdAt.toISOString(),
  };
}

/**
 * `Business` → `AdminBusiness`, for `GET /admin/businesses/:id`.
 *
 * The two addresses come from `ResolvedBusiness`, which `BusinessesService.getProfile` produced —
 * the one implementation of "a reference to a soft-deleted address reads back as absent". The
 * operator and the business therefore see the same answer, which is the whole reason this route
 * resolves them through that service rather than joining the relation itself.
 */
export function toAdminBusiness(row: AdminBusinessRow): AdminBusiness {
  return {
    ...toAdminBusinessSummary(row),
    billingAddress: row.resolved.billing === null ? null : toSavedAddress(row.resolved.billing),
    shippingAddress: row.resolved.shipping === null ? null : toSavedAddress(row.resolved.shipping),
  };
}
