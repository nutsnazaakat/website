import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminCustomer, AdminCustomerSummary, Paginated } from '@nutwala/shared';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../entities/enums';
import { AdminCustomersService } from './admin-customers.service';
import { AdminCustomerQueryDto } from './dto/admin-customer-query.dto';

/**
 * `GET /admin/customers` and `GET /admin/customers/:id` — spec §6.4, brief §35.
 *
 * **The first controller `UsersModule` has ever had.** The module existed to provide `UsersService`
 * to `AuthModule` and `ProfileModule`; nothing about the users table was ever addressable over
 * HTTP. That is why `UsersModule` is now listed explicitly in `AppModule.imports` — it was reachable
 * only transitively before, which registers its providers perfectly well and its controllers by
 * accident.
 *
 * `@Roles(UserRole.ADMIN)` at the **class**, carrying the database enum: the token carries `ADMIN`
 * while an auth response body carries `admin` via `toAuthUser`, so `@Roles('admin')` compiles and
 * refuses every admin. At the class rather than per handler, so every handler this controller ever
 * grows is guarded by default — `RolesGuard` fails *open* for a route with no `@Roles()`, so a
 * missing decorator is not a refusal, it is a quiet opening to every authenticated customer.
 * `test/integration/admin-routes-guarded.integration.spec.ts` discovers both handlers below through
 * the booted application.
 *
 * **Read-only, deliberately.** Spec §6.4 lists exactly these two verbs for this resource: no
 * `PATCH`, no `DELETE`. An operator editing a customer's own name, email or phone would be writing
 * the account's sign-in identity, which `PUT /account/profile` owns and which registration's
 * `LOWER(email)` unique index polices; deleting one has nowhere to put the orders, addresses and
 * RFQs that reference it. Neither is a gap this plan is closing by inventing surface the spec does
 * not list.
 *
 * **Declaration order is routing order.** Nest matches the first handler that fits, so `@Get(':id')`
 * stays below any literal `@Get('...')` sibling. There is none today, which is precisely when one
 * gets added and nobody can work out why it 404s.
 */
@ApiTags('admin')
@Roles(UserRole.ADMIN)
@Controller('admin/customers')
export class AdminCustomersController {
  constructor(private readonly customers: AdminCustomersService) {}

  @Get()
  @ApiOperation({
    summary: 'Customers, newest first, searchable and filterable by role (brief §35)',
  })
  list(@Query() query: AdminCustomerQueryDto): Promise<Paginated<AdminCustomerSummary>> {
    return this.customers.list(query);
  }

  /**
   * `GET /admin/customers/:id` — by **uuid**, spec §6.4's own spelling, and unlike the order and RFQ
   * routes there is no application-generated reference to prefer over it: an account has an id and
   * an email, and addressing it by email would put a customer's address in a URL and in every
   * access log that records one.
   *
   * `ParseUUIDPipe` for the reason the catalogue's `:id` routes carry it: a non-uuid reaches the
   * repository as a `WHERE id = 'banana'` and Postgres answers `22P02 invalid input syntax for type
   * uuid`, which surfaces as a 500. The pipe makes it the 400 it is.
   */
  @Get(':id')
  @ApiOperation({ summary: 'One customer, with their addresses and business record' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AdminCustomer> {
    return this.customers.get(id);
  }
}
