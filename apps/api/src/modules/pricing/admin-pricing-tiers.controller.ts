import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminPricingTier, Paginated } from '@nutwala/shared';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { UserRole } from '../../entities/enums';
import { AdminPricingTiersService } from './admin-pricing-tiers.service';
import { AdminPricingTierQueryDto } from './dto/admin-pricing-tier-query.dto';
import { CreatePricingTierDto, UpdatePricingTierDto } from './dto/save-pricing-tier.dto';

/**
 * `GET`, `POST` and `PATCH /admin/pricing-tiers` — spec §6.4, brief §31's B2B pricing admin.
 *
 * **The first controller `modules/pricing/` has ever had.** The directory held one file,
 * `pricing.resolver.ts`, a pair of plain functions the catalogue and cart mappers import directly —
 * no provider, no module. `PricingModule` exists as of plan 9.3 because these three routes need
 * one, and the resolver stays a plain import: it holds no state and takes no connection, and
 * turning it into a provider to keep it company would be churn for its four call sites.
 *
 * `@Roles(UserRole.ADMIN)` at the class, carrying the **database enum**: the token carries `ADMIN`
 * while an auth response body carries `admin`, so `@Roles('admin')` compiles and refuses every
 * admin. At the class rather than per handler, so every handler this controller ever grows is
 * guarded by default — `RolesGuard` fails *open* for a route with no `@Roles()`.
 *
 * **No `DELETE`.** §6.4 lists exactly these three verbs for this resource;
 * `AdminPricingTiersService`'s docblock has the fuller reasoning and reports the gap rather than
 * inventing the route.
 *
 * **Declaration order is routing order.** `@Patch(':id')` is the only pattern route and there is no
 * literal sibling to swallow, but the `@Get()` above it is deliberately first — a
 * `GET /admin/pricing-tiers/:id` added later must go below it, and a literal like
 * `/admin/pricing-tiers/export` below *that*.
 */
@ApiTags('admin')
@Roles(UserRole.ADMIN)
@Controller('admin/pricing-tiers')
export class AdminPricingTiersController {
  constructor(private readonly tiers: AdminPricingTiersService) {}

  /**
   * `GET /admin/pricing-tiers` — brief §31's ladder, filterable by product, band and business.
   *
   * Paginated, unlike `GET /admin/categories`' bare array, and the difference is the cardinality:
   * brief §7 fixes categories at twelve, while a ladder is per product *per band per business* —
   * twenty-seven seeded products across four bands is already three figures before a single
   * negotiated rate exists.
   */
  @Get()
  @ApiOperation({ summary: 'Pricing tiers, by product, band and business (brief §31)' })
  list(@Query() query: AdminPricingTierQueryDto): Promise<Paginated<AdminPricingTier>> {
    return this.tiers.list(query);
  }

  /**
   * `POST /admin/pricing-tiers` — a new rung.
   *
   * **201, Nest's default for a `POST`, and left alone here** unlike the order routes' explicit
   * `@HttpCode(OK)`: this genuinely creates a resource and answers with that resource, which is
   * what a 201 says. The order routes answer with the *order* rather than with what they created,
   * which is why they say 200 instead.
   *
   * A rung overlapping one already on the ladder is refused with **409 `PRICING_TIER_OVERLAP`**
   * naming the rung in the way — see `AdminPricingTiersService` for why the write is the place that
   * question is answered.
   */
  @Post()
  @ApiOperation({ summary: 'Add a quantity tier. Refuses an overlapping range' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePricingTierDto,
  ): Promise<AdminPricingTier> {
    // `actorUserId` after the spread — the audit trail's "who" is the signed token's, never a body
    // field's.
    return this.tiers.create({ ...dto, actorUserId: user.id });
  }

  /**
   * `PATCH /admin/pricing-tiers/:id` — an omitted field is left unchanged, and a request that
   * changes nothing writes no audit row.
   *
   * `ParseUUIDPipe` because a non-uuid reaches the repository as `WHERE id = 'banana'` and Postgres
   * answers `22P02`, which surfaces as a 500 rather than the 400 it is.
   */
  @Patch(':id')
  @ApiOperation({ summary: 'Change a tier. An omitted field is left unchanged' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdatePricingTierDto,
  ): Promise<AdminPricingTier> {
    return this.tiers.update(id, { ...dto, actorUserId: user.id });
  }
}
