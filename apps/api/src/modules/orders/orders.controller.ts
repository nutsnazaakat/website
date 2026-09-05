import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AccountOrder } from '@nutwala/shared';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { OrderQueryDto } from './dto/order-query.dto';
import { toAccountOrder } from './mappers/order.mapper';
import { OrdersService } from './orders.service';

/**
 * A customer's own order history — spec §6.3's two account reads and the one write they allow.
 *
 * **Every route here is authenticated, and deliberately carries no `@Public()`.** `JwtAuthGuard` is
 * global, so the absence of that decorator is the whole of the guard: an anonymous `GET
 * /account/orders` is a 401 before this class is reached. There is no such thing as a guest's order
 * list — a guest sees their order exactly once, in the response to `POST /checkout/orders` — so a
 * route that answered `[]` to an anonymous caller would be hiding a missing guard behind an empty
 * array, and `OrdersService.list(null)` returns exactly that empty array on purpose. The guard is
 * what makes that arm unreachable over HTTP rather than a fallback this controller relies on.
 *
 * **`@CurrentUser()`, never `@OptionalUser()`.** The strict decorator throws when `request.user` is
 * absent, which is the correct failure for a route that cannot be served without an owner. Swapped
 * for the lenient one, a guest reaching any handler crashes on `user.id` — a 500, not a leak —
 * and the danger is the repair rather than the crash: `user?.id ?? null` turns it into a 200 with
 * `[]`, the empty array hiding a missing guard, while `user?.id ?? undefined` skips the service's
 * guest guard and reaches TypeORM with a criterion it silently drops. The two decorators are
 * interchangeable to `tsc` — a param decorator's return type is not the declared parameter type — so
 * `orders.controller.spec.ts` runs the factories against a user-less context and asserts they
 * **throw**, the mirror image of what `checkout.controller.spec.ts` asserts about its public
 * routes.
 *
 * **A miss is a 404 and never a 403.** `OrdersService` answers `null` for both "no such order" and
 * "not yours" and cannot tell them apart by design; turning that into two different statuses here
 * would make the endpoint an existence oracle, and order numbers are sequential and walkable, so a
 * scan of the range would enumerate the shop's volume. Spec §13. Note that `ErrorCodes` has no
 * `FORBIDDEN` member at all, which is the registry saying the same thing. All three routes share one
 * `notFound` helper so the read and the cancel cannot start answering differently.
 *
 * **The cancel route carries no `@SkipCsrf()`**, so the global `CsrfGuard` applies to it as to every
 * other unsafe method: a `POST` whose `X-CSRF-Token` does not match the readable `nn_csrf` cookie is
 * a 403 before this class is reached. That matters more here than on a read, because a cancellation
 * is irreversible — `nextStatuses(channel, 'cancelled')` is `[]` — so a cross-site form post would
 * destroy an order rather than merely disclose one.
 *
 * **Declaration order is routing order.** Nest registers handlers in
 * `Object.getOwnPropertyNames(prototype)` order and Express matches the first that fits, so
 * `@Get(':orderNumber')` must stay below any literal `@Get('...')` sibling or the pattern swallows
 * it — `GET /account/orders/summary` would reach `findOne('summary')` and answer 404 for an order
 * nobody placed. There is no literal sibling today, which is precisely when one gets added and
 * nobody can work out why it 404s; `catalog.controller.ts` has three of them and its spec pins the
 * invariant, and this controller's spec pins the same one over the whole route list rather than over
 * a named route, so it covers a sibling added later without anyone remembering to extend it.
 */
@ApiTags('account')
@Controller('account/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * `GET /account/orders` — the caller's own orders, newest first.
   *
   * The owner comes from `@CurrentUser()` and from nowhere else. It is deliberately not a query
   * parameter, a body field or an email: `OrderFilters` has no email field for exactly this reason,
   * and an `?email=` that scoped the read would let anyone who can guess an address read a stranger's
   * history.
   *
   * `AccountOrder[]`, the same shape as the detail route — not a lighter header projection. The
   * account list renders each order's status and its lines, and two shapes for one thing would be
   * two contracts, the second of which nobody updates.
   */
  @Get()
  @ApiOperation({ summary: 'The signed-in customer’s orders, newest first' })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: OrderQueryDto,
  ): Promise<AccountOrder[]> {
    const found = await this.orders.list(user.id, query);
    return found.map((order) => toAccountOrder(order));
  }

  /**
   * `GET /account/orders/:orderNumber` — one of the caller's orders, by the number they can read
   * down a phone line.
   *
   * The 404 is built here rather than in the service, because the service is also the cancel path's
   * reader and a `null` is the honest answer to "is this order the caller's". `HttpStatus.NOT_FOUND`
   * is passed explicitly: `DomainError` defaults to **422**, so omitting it answers a mistyped order
   * number with "unprocessable entity" and the client's not-found branch never runs.
   *
   * `details: { orderNumber }` echoes the caller's own input back and reveals nothing — it is the
   * value they just sent. What is *not* here is any hint of which of the two misses occurred.
   */
  @Get(':orderNumber')
  @ApiOperation({ summary: 'One of the signed-in customer’s orders, with its tracking timeline' })
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderNumber') orderNumber: string,
  ): Promise<AccountOrder> {
    const order = await this.orders.findOne(user.id, orderNumber);
    if (order === null) throw this.notFound(orderNumber);
    return toAccountOrder(order);
  }

  /**
   * `POST /account/orders/:orderNumber/cancel` — the customer cancelling their own order.
   *
   * **No body, and that is the contract rather than an omission.** The target status is
   * `'cancelled'`, hardcoded in the service: `RETAIL_TRANSITIONS` also allows
   * `delivered -> refunded`, so a route that read a status from its caller would let a customer
   * refund themselves through an endpoint named cancel. There is nothing else to send either — the
   * order comes from the path and the actor from the session.
   *
   * **`@HttpCode(HttpStatus.OK)`, because Nest answers a `POST` with 201 by default.** Nothing is
   * created here: the response is the same `AccountOrder` the detail route answers, re-read after the
   * transition so its `status`, its `timeline` and the cancellation event are the committed ones. A
   * 201 with a `Location`-less body describing an existing order would be a lie the client cannot
   * act on, and returning the order rather than `204` is what lets the page re-render from the
   * response instead of guessing what the server did.
   *
   * **The refusals, and which layer each comes from.** A stranger's order or a mistyped number is a
   * **404** built here, letter for letter the same as the detail route's — `OrdersService.cancel`
   * answers `null` for both and cannot tell them apart, so a 403 would make this an existence oracle
   * exactly as it would there, and `ErrorCodes` has no `FORBIDDEN` member. An order that has shipped
   * is a **422 `ILLEGAL_STATUS_TRANSITION`** from `OrderStatusService`, carrying `allowed` — the
   * `nextStatuses(channel, from)` list — so the UI can say what *is* possible rather than "no". A
   * second cancellation is the same 422, because `canTransition` refuses a no-op; there is
   * deliberately no early return here that would answer 200 to it and append a second event. And a
   * cancellation racing another one is a **409** from the guarded `UPDATE`.
   *
   * Declared below `@Get(':orderNumber')` and that is safe, unlike a literal `@Get` sibling would be:
   * this is a different verb *and* a longer path, so the pattern above cannot swallow it.
   */
  @Post(':orderNumber/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel one of the signed-in customer’s orders' })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderNumber') orderNumber: string,
  ): Promise<AccountOrder> {
    const cancelled = await this.orders.cancel(user.id, orderNumber);
    if (cancelled === null) throw this.notFound(orderNumber);
    return toAccountOrder(cancelled);
  }

  /**
   * The one 404 both handlers throw, so the read and the cancel are **indistinguishable** on a miss.
   *
   * Written once rather than twice because that identity is the property: two copies drift, and the
   * first divergence — a cancel that said "this order is not yours" while the read said "no order" —
   * would hand an attacker the difference between "no such order" and "someone else's", which is the
   * oracle spec §13 forbids.
   *
   * `HttpStatus.NOT_FOUND` is passed explicitly: `DomainError` defaults to **422**, so omitting it
   * answers a mistyped order number with "unprocessable entity" and the client's not-found branch
   * never runs. Worse on this route than on the read, because 422 is also what a genuinely
   * uncancellable order answers — the two refusals would become one status.
   */
  private notFound(orderNumber: string): DomainError {
    return new DomainError(
      ErrorCodes.NOT_FOUND,
      `No order ${orderNumber} in your account.`,
      HttpStatus.NOT_FOUND,
      { orderNumber },
    );
  }
}
