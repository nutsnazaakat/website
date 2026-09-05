import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../../entities/enums';

export const ROLES_KEY = 'roles';

/** Any one of the listed roles is sufficient. */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
