import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminOrder, AdminOrderSummary, Paginated } from '@nutwala/shared';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { UserRole } from '../../entities/enums';
import { AdminOrdersService } from './admin-orders.service';
import { AdminOrderQueryDto } from './dto/admin-order-query.dto';
import { ChangeOrderStatusDto } from './dto/change-order-status.dto';
import { CollectPaymentDto } from './dto/collect-payment.dto';
import { CreateShipmentDto } from './dto/create-shipment.dto';

/**
 * The operator's order screens — spec §6.4's `/admin/orders` block, brief §33.
 *
 * **A second controller beside `OrdersController`, not extra handlers on it.** No class in this
 * codebase mixes scopes, and here that is a safety property rather than tidiness: `RolesGuard`
 * resolves `@Roles()` with handler metadata overriding class metadata, so an admin handler living
 * on the customer's controller would depend on somebody remembering a per-handler decorator — and a
 * handler that loses one is not refused, it is silently opened to every authenticated customer.
 * `@Roles(UserRole.ADMIN)` at the **class** makes every handler this controller ever grows guarded
 * by default, and `test/integration/admin-routes-guarded.integration.spec.ts` discovers it through
 * the booted application.
 *
 * The enum, never the string: the token carries `ADMIN` while an auth response body carries `admin`
 * via `toAuthUser`, so `@Roles('admin')` compiles and refuses every admin.
 *
 * **`:orderNumber`, not `:id`.** Spec §6.4 spells these `POST /admin/orders/:id/status`, and the
 * order table has a uuid `id` — but nothing customer-facing or admin-facing addresses an order by
 * it. `AccountOrder` has no field for the uuid at all, `orders."orderNumber"` carries
 * `uq_orders_order_number`, and `OrdersController` is already `:orderNumber` on both of its routes.
 * §6.4 needs the same correction it already carries for
 * `PATCH /admin/inventory/:variantId`: the spelling in the table is not the shipped one.
 *
 * **`actorUserId` is assigned after the DTO spread**, everywhere below. The audit trail's "who"
 * comes from the signed token and must not be overridable by a body field, whatever the validation
 * pipe strips — `whitelist` would drop one today, and the spread order is what makes that a
 * property of this code rather than of the pipe's configuration.
 *
 * **Declaration order is routing order.** Nest registers handlers in
 * `Object.getOwnPropertyNames(prototype)` order and Express matches the first that fits, so
 * `@Get(':orderNumber')` stays below any literal `@Get('...')` sibling — there is none today, which
 * is exactly when one gets added and nobody can work out why it 404s. `admin/orders/export` would
 * have to be declared **above** the detail route or the pattern swallows it. The `POST` handlers
 * below are safe wherever they sit: each is a different verb *and* a longer path, so the detail
 * route cannot match them. `OrdersController` carries this warning in two places, and
 * `admin-orders.controller.spec.ts` pins the whole table rather than one route, so a handler added
 * later is covered without anyone remembering to extend it.
 */
@ApiTags('admin')
@Roles(UserRole.ADMIN)
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(private readonly orders: AdminOrdersService) {}

  /**
   * `GET /admin/orders` — brief §33's list: Order ID, Customer, B2C/B2B, Amount, Payment, Status,
   * Date. Filterable by status, channel and date range, and paginated.
   */
  @Get()
  @ApiOperation({ summary: 'Orders across both channels, newest first (brief §33)' })
  list(@Query() query: AdminOrderQueryDto): Promise<Paginated<AdminOrderSummary>> {
    return this.orders.list(query);
  }

  /**
   * `GET /admin/orders/:orderNumber` — one order in full: items, totals, address, timeline and
   * payment state, plus the customer identity `/account/orders/:orderNumber` omits.
   *
   * No `ParseUUIDPipe`, unlike the `:id` routes on the catalogue controllers, and not by oversight:
   * the parameter is an order **number**, so a uuid pipe here would reject every real reference.
   */
  @Get(':orderNumber')
  @ApiOperation({ summary: 'One order in full, with its timeline and its customer' })
  get(@Param('orderNumber') orderNumber: string): Promise<AdminOrder> {
    return this.orders.get(orderNumber);
  }

  /**
   * `POST /admin/orders/:orderNumber/status` — move an order along, with the timeline event and the
   * stock consequence the move implies.
   *
   * **`@HttpCode(HttpStatus.OK)`, because Nest answers a `POST` with 201 by default.** Nothing is
   * created: the reply is the same `AdminOrder` the detail route answers, re-read after the
   * transition, so the console re-renders the committed status, the new timeline entry and the
   * payment state from the response instead of guessing what the server did.
   * `OrdersController.cancel` makes the same choice for the same reason.
   *
   * **No `@SkipCsrf()`**, so the global `CsrfGuard` applies as it does to every unsafe method — and
   * it matters more here than on a read, because several of these transitions are irreversible:
   * `cancelled` and `refunded` are terminal, and both move stock.
   */
  @Post(':orderNumber/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move an order to a new status, with a timeline event (spec §10.3)' })
  setStatus(
    @Param('orderNumber') orderNumber: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangeOrderStatusDto,
  ): Promise<AdminOrder> {
    // `actorUserId` after the spread, deliberately: the audit row's and the timeline's "who" comes
    // from the signed token and must not be overridable by a body field.
    return this.orders.setStatus(orderNumber, { ...dto, actorUserId: user.id });
  }

  /**
   * `POST /admin/orders/:orderNumber/payment/collect` — spec §10.4's COD collection.
   *
   * `@HttpCode(HttpStatus.OK)` for the reason above, with an extra one: a 201 on the *second* call
   * would claim something was created when the whole point is that nothing was. The reply is the
   * order as it now stands, identical whichever call it was.
   */
  @Post(':orderNumber/payment/collect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record COD as collected. Idempotent (spec §10.4)' })
  collectPayment(
    @Param('orderNumber') orderNumber: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CollectPaymentDto,
  ): Promise<AdminOrder> {
    // `actorUserId` after the spread, as everywhere: the audit row's "who" is the token's.
    return this.orders.collectPayment(orderNumber, { ...dto, actorUserId: user.id });
  }

  /**
   * `POST /admin/orders/:orderNumber/shipment` — record a dispatch, which also moves the order to
   * `shipped`. `AdminOrdersService.createShipment` carries the full case for coupling the two.
   *
   * **`@HttpCode(HttpStatus.OK)`, even though this one genuinely creates a row.** A 201 would be
   * defensible on its own and is not what the response says: the body is the whole order, the same
   * `AdminOrder` every other write here answers with, so the console re-renders the new status, the
   * new timeline entry and the shipment together. A 201 with no `Location` and a body describing
   * something other than the created resource would be worse than the small inconsistency.
   */
  @Post(':orderNumber/shipment')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record a dispatch. Also moves the order to shipped (spec §10.3)' })
  createShipment(
    @Param('orderNumber') orderNumber: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateShipmentDto,
  ): Promise<AdminOrder> {
    // `actorUserId` after the spread, as everywhere: the audit row's "who" is the token's.
    return this.orders.createShipment(orderNumber, { ...dto, actorUserId: user.id });
  }
}
