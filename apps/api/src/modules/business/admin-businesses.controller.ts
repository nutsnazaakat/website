import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminBusiness, AdminBusinessSummary, Paginated } from '@nutwala/shared';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../entities/enums';
import { AdminBusinessesService } from './admin-businesses.service';
import { AdminBusinessQueryDto } from './dto/admin-business-query.dto';

/**
 * `GET /admin/businesses` and `GET /admin/businesses/:id` — spec §6.4, brief §35's B2B profile.
 *
 * **A second controller beside `BusinessesController`, which carries `@Roles(UserRole.BUSINESS)`
 * and is not widened.** That class answers a business's own profile with every read scoped to
 * `user.id`; these two routes read the whole customer base. One class serving both roles would put
 * the distinction in per-handler decorators — and `RolesGuard` resolves handler metadata *over*
 * class metadata, so a handler that lost one would inherit `BUSINESS` and hand a customer
 * everybody's business records. The guard-coverage suite's "no route outside `admin/*` carries
 * `@Roles(ADMIN)`" case is what keeps the two classes from being merged by accident.
 *
 * `@Roles(UserRole.ADMIN)` at the class, carrying the **database enum**: the token carries `ADMIN`
 * while an auth response body carries `admin`, so `@Roles('admin')` compiles and refuses every
 * admin.
 *
 * **Read-only.** Spec §6.4 lists exactly these two verbs. `PATCH /admin/businesses/:id` — which is
 * what would set `segment`, brief §31's price band, and `assignedSalespersonId` — is **not in
 * §6.4's table at all** and is not invented here; `business.entity.ts` already names it as the
 * missing writer for `segment`, so it is a real gap and belongs to a plan that can decide its shape
 * rather than to this one.
 *
 * **Declaration order is routing order.** `@Get(':id')` stays below any literal `@Get('...')`
 * sibling; there is none today, which is exactly when one gets added and nobody can work out why it
 * 404s.
 */
@ApiTags('admin')
@Roles(UserRole.ADMIN)
@Controller('admin/businesses')
export class AdminBusinessesController {
  constructor(private readonly businesses: AdminBusinessesService) {}

  @Get()
  @ApiOperation({ summary: 'Businesses, newest first, searchable and filterable by segment (§35)' })
  list(@Query() query: AdminBusinessQueryDto): Promise<Paginated<AdminBusinessSummary>> {
    return this.businesses.list(query);
  }

  /**
   * By the **business's** uuid, not the account's: `GET /admin/customers/:id` is already addressed
   * by the account's, and one uuid reaching two resources would make a mistyped reference answer
   * the wrong screen rather than a 404. `AdminBusinessSummary.userId` is how a console gets from
   * one to the other.
   *
   * `ParseUUIDPipe` because a non-uuid reaches the repository as `WHERE id = 'banana'` and Postgres
   * answers `22P02`, which surfaces as a 500 rather than the 400 it is.
   */
  @Get(':id')
  @ApiOperation({ summary: 'One business, with its billing and shipping addresses' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AdminBusiness> {
    return this.businesses.get(id);
  }
}
