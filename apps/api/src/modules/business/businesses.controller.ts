import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AccountOrder, BusinessProfile, BusinessStats } from '@nutwala/shared';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { UserRole } from '../../entities/enums';
import { toAccountOrder } from '../orders/mappers/order.mapper';
import { OrdersService } from '../orders/orders.service';
import { BusinessStatsService } from './business-stats.service';
import { BusinessesService } from './businesses.service';
import { UpdateBusinessDto } from './dto/update-business.dto';
import { toBusinessProfile } from './mappers/business.mapper';

/**
 * `GET`/`PUT /business/me`, `GET /business/stats` and `GET /business/orders` — brief §19's
 * fuller business profile, the dashboard's server-computed figures, and spec §6.3's bulk-order
 * convenience route.
 *
 * **`@Roles(UserRole.BUSINESS)` at the class**, so a `CUSTOMER` account gets a 403 and an
 * anonymous caller gets a 401 from the global `JwtAuthGuard`/`RolesGuard` pair before either
 * handler runs — the same shape `InventoryController` states for `@Roles(UserRole.ADMIN)`, for
 * the identical reason: this is enforced server-side regardless of what any client believes.
 * Ownership scoping by `user.id` alone would answer 404 to a `CUSTOMER` rather than 403, and the
 * plan's own proof list asks for the role check specifically.
 *
 * **Every field the mapper omits — `segment`, `assignedSalespersonId` — cannot be reached from
 * either route.** `UpdateBusinessDto` does not declare them, so the global pipe's
 * `forbidNonWhitelisted` turns either one appearing in a `PUT` body into a 400; `toBusinessProfile`
 * does not read them off the entity, so neither can appear in a `GET` response.
 */
@ApiTags('business')
@Roles(UserRole.BUSINESS)
@Controller('business')
export class BusinessesController {
  constructor(
    private readonly businesses: BusinessesService,
    private readonly stats: BusinessStatsService,
    private readonly orders: OrdersService,
  ) {}

  /**
   * `GET /business/me` — the caller's own business, with `billingAddress`/`shippingAddress`
   * resolved from their address book rather than sent as bare ids.
   *
   * A `null` from `getProfile` is not turned into a 404 here: it means the caller's account has
   * no business row at all, which `@Roles(UserRole.BUSINESS)` and registration's `createFor`
   * together make unreachable over HTTP — every `BUSINESS` account gains one at signup. Thrown
   * as a plain error rather than a `DomainError`, because there is no client action that fixes
   * it and no wire code the frontend needs to branch on.
   */
  @Get('me')
  @ApiOperation({ summary: 'The signed-in business’s own profile' })
  async me(@CurrentUser() user: AuthenticatedUser): Promise<BusinessProfile> {
    const resolved = await this.businesses.getProfile(user.id);
    if (resolved === null) {
      throw new Error(`BUSINESS user ${user.id} has no business row`);
    }
    return toBusinessProfile(resolved);
  }

  /**
   * `PUT /business/me` — a full replace of the editable profile fields.
   *
   * Answers with the same shape `GET` does — the profile as it now stands, addresses resolved —
   * so the form can render exactly what was saved without a second round trip, `AddressesController`'s
   * own reason for answering every address write with the whole book.
   */
  @Put('me')
  @ApiOperation({ summary: 'Replace the signed-in business’s own profile' })
  async updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateBusinessDto,
  ): Promise<BusinessProfile> {
    const resolved = await this.businesses.update(user.id, {
      companyName: dto.companyName,
      contactPerson: dto.contactPerson,
      mobile: dto.mobile,
      gstin: dto.gstin,
      businessType: dto.businessType,
      billingAddressId: dto.billingAddressId ?? null,
      shippingAddressId: dto.shippingAddressId ?? null,
    });
    return toBusinessProfile(resolved);
  }

  /**
   * `GET /business/stats` — open enquiries, bulk spend and bulk order count, all three computed
   * here rather than by the dashboard summing an order and RFQ list it fetched for other
   * reasons. See `BusinessStatsService`'s own docblock for why the scope is `user.id` and for
   * the `businessId` column this deliberately does not use.
   */
  @Get('stats')
  @ApiOperation({ summary: 'The signed-in business’s dashboard figures' })
  async getStats(@CurrentUser() user: AuthenticatedUser): Promise<BusinessStats> {
    return this.stats.forUser(user.id);
  }

  /**
   * `GET /business/orders` — `GET /account/orders?channel=bulk`, at the URL the business
   * dashboard calls.
   *
   * **A convenience, not a second implementation.** `OrdersService.list` already carries the
   * IDOR scoping, the `placedAt DESC` ordering and the `ITEMS_IN_ORDER` clause `toAccountOrder`
   * throws without — `orders.controller.spec.ts` and `orders.service.spec.ts` already prove all
   * three. A bespoke query here would inherit none of that, and the divergence would be
   * invisible until a customer noticed their bulk orders sorted differently from their retail
   * ones. This route earns its place by being the URL the dashboard calls, not by doing anything
   * `?channel=bulk` cannot — do not "optimise" it into one later.
   */
  @Get('orders')
  @ApiOperation({ summary: 'The signed-in business’s own bulk orders, newest first' })
  async listOrders(@CurrentUser() user: AuthenticatedUser): Promise<AccountOrder[]> {
    const found = await this.orders.list(user.id, { channel: 'bulk' });
    return found.map((order) => toAccountOrder(order));
  }
}
