import type { AuthUser, Role } from '@nutwala/shared';
import { UserRole } from '../../entities/enums';
import type { User } from '../../entities/identity/user.entity';

/**
 * The only place the database enum and the wire role translate.
 *
 * The database uses `CUSTOMER`/`BUSINESS`/`ADMIN` because those read correctly in SQL and in
 * an admin screen. The wire keeps `b2c`/`b2b`/`admin` because the Phase 1 frontend already
 * types and persists those values. One mapper is cheaper than changing either side.
 */
const TO_WIRE: Record<UserRole, Role> = {
  [UserRole.CUSTOMER]: 'b2c',
  [UserRole.BUSINESS]: 'b2b',
  [UserRole.ADMIN]: 'admin',
};

const TO_ENUM: Record<Role, UserRole> = {
  b2c: UserRole.CUSTOMER,
  b2b: UserRole.BUSINESS,
  admin: UserRole.ADMIN,
};

export function toUserRole(role: Role): UserRole {
  return TO_ENUM[role];
}

/**
 * Builds the response body. Constructed field by field rather than by spreading and deleting,
 * so a column added to `User` later cannot leak into an API response by default.
 */
export function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: TO_WIRE[user.role],
    createdAt: user.createdAt.toISOString(),
    ...(user.business
      ? {
          company: {
            companyName: user.business.companyName,
            contactPerson: user.business.contactPerson,
            businessType: user.business.businessType,
            ...(user.business.gstin ? { gstin: user.business.gstin } : {}),
          },
        }
      : {}),
  };
}
