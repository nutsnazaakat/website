// backend/src/modules/admin/admin-dashboard.controller.ts
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminDashboard } from '@nutwala/shared';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../entities/enums';
import { DashboardService } from './dashboard.service';

/**
 * `GET /admin/dashboard` — brief §29.
 *
 * `@Roles(UserRole.ADMIN)` at the **class**, carrying the database enum, exactly as
 * `inventory.controller.ts` establishes. Both halves of that are load-bearing and neither is
 * style: at the class, every handler this controller ever grows is guarded by default, where
 * repeating the decorator per handler leaves the next one somebody adds open; and the enum, because
 * the token carries `ADMIN` while an auth response body carries `admin`, so `@Roles('admin')`
 * compiles and refuses every admin. `test/integration/admin-routes-guarded.integration.spec.ts`
 * discovers this controller through the booted application and fails the build on either mistake.
 *
 * No `@Public()`, so the global `JwtAuthGuard` answers an anonymous caller 401 before `RolesGuard`
 * is reached, and a signed-in customer gets 403.
 */
@ApiTags('admin')
@Roles(UserRole.ADMIN)
@Controller('admin/dashboard')
export class AdminDashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @ApiOperation({ summary: "The operator dashboard's cards and charts (brief §29)" })
  summary(): Promise<AdminDashboard> {
    return this.dashboard.summary();
  }
}
