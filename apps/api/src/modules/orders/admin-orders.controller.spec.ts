import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { VALIDATION_PIPE_OPTIONS } from '../../app.module';
import { ROLES_KEY } from '../../common/auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { DomainError } from '../../common/errors/domain-error';
import { UserRole } from '../../entities/enums';
import { AdminOrdersController } from './admin-orders.controller';
import type { AdminOrdersService } from './admin-orders.service';
import { ChangeOrderStatusDto } from './dto/change-order-status.dto';

const ORDER_NUMBER = 'NN-2026-100000';
const ADMIN: AuthenticatedUser = { id: 'admin-1', role: UserRole.ADMIN, sessionId: 'session-1' };

const PAGE = { items: [], total: 0, page: 1, limit: 24 };

function harness() {
  const orders = {
    setStatus: jest.fn().mockResolvedValue({ id: ORDER_NUMBER }),
    list: jest.fn().mockResolvedValue(PAGE),
    get: jest.fn().mockResolvedValue({ id: ORDER_NUMBER }),
    collectPayment: jest.fn().mockResolvedValue({ id: ORDER_NUMBER }),
    createShipment: jest.fn().mockResolvedValue({ id: ORDER_NUMBER }),
  };
  return {
    controller: new AdminOrdersController(orders as unknown as AdminOrdersService),
    orders,
  };
}

/**
 * The production pipe, imported rather than rebuilt — `save-product.dto.spec.ts` records why: a
 * locally-configured `new ValidationPipe({...})` asserts these decorators against *this file's*
 * options, so a `forbidNonWhitelisted` dropped in `app.module.ts` would leave every case green
 * while the server accepted what they claim it refuses.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
const validate = (value: unknown): Promise<unknown> =>
  Promise.resolve(pipe.transform(value, { type: 'body', metatype: ChangeOrderStatusDto }));

/**
 * The routing table Nest built, read off the prototype in declaration order — the same route
 * `orders.controller.spec.ts` takes, and for the same two reasons.
 *
 * **Order is the point, not decoration.** Nest registers handlers in
 * `Object.getOwnPropertyNames` order and Express matches the first that fits, so a literal
 * `@Get('...')` added below a `@Get(':orderNumber')` sibling would be swallowed by the pattern and
 * 404 for an order nobody placed. Reading the table rather than naming one route means a handler
 * added later is covered without anyone remembering to extend this file.
 *
 * Handlers are reached through `getOwnPropertyDescriptor` rather than `Controller.prototype.name`,
 * which is an unbound method reference and an eslint error.
 */
function declaredRoutes(): { name: string; method: string; path: string }[] {
  const prototype: object = AdminOrdersController.prototype;
  const routes: { name: string; method: string; path: string }[] = [];

  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const handler: unknown = Object.getOwnPropertyDescriptor(prototype, name)?.value;
    if (typeof handler !== 'function') continue;
    const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    if (typeof path !== 'string') continue;
    const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
    routes.push({ name, method: RequestMethod[verb], path });
  }

  return routes;
}

describe('AdminOrdersController', () => {
  /**
   * `RolesGuard` is global and returns `true` early for a route carrying no `@Roles()`, so a
   * controller that loses the decorator is not refused — it is silently opened to every
   * authenticated customer. This reads the metadata the guard reads.
   *
   * The **enum**, not the string. The token carries `ADMIN` and an auth response body carries
   * `admin`, so `@Roles('admin')` compiles and refuses every admin;
   * `test/integration/admin-routes-guarded.integration.spec.ts` compares the raw metadata for the
   * same reason.
   */
  it('is restricted to admins at class level', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminOrdersController)).toEqual([UserRole.ADMIN]);
  });

  /**
   * **`:orderNumber`, not `:id`.** Spec §6.4 spells this row `POST /admin/orders/:id/status`, and
   * an order does have a uuid `id` — but nothing addresses an order by it: `AccountOrder` carries
   * no field for it, `orders."orderNumber"` is the unique reference a customer reads down a phone
   * line, and `OrdersController` already uses it on both routes. Pinned here because the two spell
   * identically to `tsc` — both are `@Param(...): string` — so the mistake is invisible until a
   * lookup misses.
   */
  it('addresses an order by its number, not by a uuid', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminOrdersController)).toBe('admin/orders');
    expect(declaredRoutes()).toEqual([
      { name: 'list', method: 'GET', path: '/' },
      { name: 'get', method: 'GET', path: ':orderNumber' },
      { name: 'setStatus', method: 'POST', path: ':orderNumber/status' },
      { name: 'collectPayment', method: 'POST', path: ':orderNumber/payment/collect' },
      { name: 'createShipment', method: 'POST', path: ':orderNumber/shipment' },
    ]);
  });

  it('passes the order from the path and the move from the body', async () => {
    const { controller, orders } = harness();

    await controller.setStatus(ORDER_NUMBER, ADMIN, {
      status: 'packed',
      note: 'Boxed and labelled',
    });

    expect(orders.setStatus).toHaveBeenCalledWith(ORDER_NUMBER, {
      status: 'packed',
      note: 'Boxed and labelled',
      actorUserId: ADMIN.id,
    });
  });

  /**
   * The audit trail's and the timeline's "who" comes from the signed token, never the request.
   *
   * `whitelist: true` strips an unknown body property before the handler sees it, so this is the
   * second line of defence rather than the first — and worth pinning because the defence *is* the
   * key order in the object literal, a one-token change no assertion about the response would
   * notice.
   */
  it('takes the actor from the token even if the body carries one', async () => {
    const { controller, orders } = harness();
    const forged = { status: 'packed', actorUserId: 'someone-else' } as ChangeOrderStatusDto;

    await controller.setStatus(ORDER_NUMBER, ADMIN, forged);

    expect(orders.setStatus).toHaveBeenCalledWith(
      ORDER_NUMBER,
      expect.objectContaining({ actorUserId: ADMIN.id }),
    );
  });
});

/**
 * `ChangeOrderStatusDto` through the production pipe.
 *
 * Each case is a refusal that would otherwise be a silent write or a decision taken on the
 * operator's behalf, not a decorator inventory.
 */
describe('ChangeOrderStatusDto', () => {
  it('accepts a status from either channel’s vocabulary', async () => {
    await expect(validate({ status: 'packed' })).resolves.toMatchObject({ status: 'packed' });
    await expect(validate({ status: 'quote-sent' })).resolves.toMatchObject({
      status: 'quote-sent',
    });
  });

  /**
   * A value outside brief §33's two tuples never reaches `transition`. It would be refused there
   * anyway — `nextStatuses` degrades to `[]` for an unknown status — but as a 422 saying the move
   * was illegal, which is the wrong story about a typo, and `ck_orders_status` would be the only
   * thing left standing between a bad value and the column.
   */
  it('refuses a status that is not one at all', async () => {
    await expect(validate({ status: 'dispatched' })).rejects.toBeInstanceOf(DomainError);
  });

  /**
   * **The `refunded` path requires the restock decision to be stated.** `TransitionOptions.restock`
   * is never defaulted to `true` because returned food may not be resellable (spec §10.3), and its
   * docblock records the cost of an omitted flag — *"'no flag' and 'the admin decided not to
   * restock' are different facts that arrive here looking identical"*. `@ValidateIf` is what keeps
   * them distinguishable over HTTP: an admin must say which, rather than have "do not restock"
   * chosen for them by an empty body.
   */
  it('requires the restock decision when refunding, and only then', async () => {
    await expect(validate({ status: 'refunded' })).rejects.toBeInstanceOf(DomainError);
    await expect(validate({ status: 'refunded', restock: false })).resolves.toMatchObject({
      restock: false,
    });
    // Every other status leaves it optional, because nothing consults it there.
    await expect(validate({ status: 'cancelled' })).resolves.toMatchObject({ status: 'cancelled' });
  });

  /** `order_events.note` is `varchar(300)`; an untruncated 301 characters is a Postgres 22001. */
  it('refuses a note wider than the column it goes in', async () => {
    await expect(validate({ status: 'packed', note: 'w'.repeat(301) })).rejects.toBeInstanceOf(
      DomainError,
    );
  });

  /** `forbidNonWhitelisted`: a forged actor is a 400, not a field quietly stripped. */
  it('refuses an undeclared property such as a forged actor', async () => {
    await expect(
      validate({ status: 'packed', actorUserId: 'someone-else' }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});
