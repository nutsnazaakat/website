/**
 * Brief §46 — one account serves both retail and bulk. There is no separate B2B login: the
 * same session gains bulk access by carrying `role: "b2b"`.
 *
 * The wire values stay `b2c` / `b2b` / `admin` to match what the Phase 1 frontend already
 * types and stores. The database enum is `CUSTOMER` / `BUSINESS` / `ADMIN` (spec §5.1); the
 * backend maps between them in one place, `UserMapper` (Task 31).
 */
export type Role = 'b2c' | 'b2b' | 'admin';

/** Only populated on a business account. `/business/profile` owns the fuller record. */
export interface CompanyProfile {
  companyName: string;
  contactPerson: string;
  businessType: string;
  gstin?: string;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: Role;
  company?: CompanyProfile;
  createdAt: string;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface RegisterInput {
  name: string;
  email: string;
  phone: string;
  password: string;
  /** The "I'm buying for a business" checkbox. True creates the account as `b2b`. */
  isBusiness: boolean;
  company?: CompanyProfile;
}
