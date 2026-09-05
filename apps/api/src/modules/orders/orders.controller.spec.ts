import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { HttpStatus, RequestMethod, ValidationPipe, type ExecutionContext } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../app.module';
import { IS_PUBLIC_KEY } from '../../common/auth/decorators/public.decorator';
import { DomainError } from '../../common/errors/domain-error';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import type { OrderEvent } from '../../entities/commerce/order-event.entity';
import type { OrderItem } from '../../entities/commerce/order-item.entity';
import type { AddressSnapshot, Order } from '../../entities/commerce/order.entity';
import { OrderChannelEnum, PaymentMethodEnum, PaymentStatusEnum } from '../../entities/enums';
import { OrderQueryDto } from './dto/order-query.dto';
import { OrdersController } from './orders.controller';
import type { OrdersService } from './orders.service';

const ASHA: AuthenticatedUser = {
  id: 'f0000000-0000-4000-8000-00000000000a',
  role: 'CUSTOMER',
  sessionId: 'session-1',
};

const SNAPSHOT: AddressSnapshot = {
  fullName: 'Asha Rao',
  phone: '9876543210',
  email: 'b2c@demo.in',
  line1: '12 Residency Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560025',
};

/**
 * The two relations `toAccountOrder` refuses to map without, stored in the sequence a query has
 * already imposed — `OrdersService` orders items by `id` and the mapper sorts events by `createdAt`
 * itself, so this fixture is what the controller really receives rather than raw table order.
 */
const items = (orderNumber: string): OrderItem[] =>
  [
    {
      id: `${orderNumber}-item-1`,
      productSlug: 'premium-california-almonds',
      name: 'Premium California Almonds',
      detail: '1kg',
      qty: 1,
      lineTotalPaise: 99_900n,
    },
    {
      id: `${orderNumber}-item-2`,
      productSlug: 'w320-cashews',
      name: 'W320 Cashews',
      detail: '500g',
      qty: 2,
      lineTotalPaise: 119_800n,
    },
  ] as unknown as OrderItem[];

const events = (placedAt: string): OrderEvent[] =>
  [
    {
      id: `${placedAt}-evt-1`,
      status: 'pending',
      note: null,
      createdAt: new Date(placedAt),
    },
    {
      id: `${placedAt}-evt-2`,
      status: 'confirmed',
      note: 'Payment received.',
      createdAt: new Date(new Date(placedAt).getTime() + 120_000),
    },
  ] as unknown as OrderEvent[];

const row = (orderNumber: string, placedAt: string): Order =>
  ({
    id: `ord-${orderNumber}`,
    orderNumber,
    userId: ASHA.id,
    channel: OrderChannelEnum.RETAIL,
    status: 'confirmed',
    paymentMethod: PaymentMethodEnum.COD,
    paymentStatus: PaymentStatusEnum.PENDING,
    subtotalPaise: 219_700n,
    discountPaise: 0n,
    gstPaise: 10_985n,
    shippingPaise: 0n,
    totalPaise: 230_685n,
    couponCode: null,
    companyName: null,
    gstin: null,
    poNumber: null,
    addressSnapshot: SNAPSHOT,
    billingSnapshot: null,
    placedAt: new Date(placedAt),
    estimatedDelivery: new Date('2026-08-20T12:00:00.000Z'),
    items: items(orderNumber),
    events: events(placedAt),
  }) as unknown as Order;

/** Newest first, the sequence `OrdersService.list` guarantees and this controller must not disturb. */
const ASHA_ORDERS: readonly Order[] = [
  row('NN-2026-005107', '2026-08-12T05:20:00.000Z'),
  row('NN-2026-004977', '2026-08-05T14:10:00.000Z'),
];

interface Harness {
  controller: OrdersController;
  orders: { list: jest.Mock; findOne: jest.Mock; cancel: jest.Mock };
}

/**
 * `cancelled` is the row `cancel` answers with, and it is a *different* row from `findOne`'s on
 * purpose: the handler has to send back what the service returned after the transition, not the
 * order it happened to read on the way in. Same order number, so a mutant that answered the detail
 * read's row instead fails on the status rather than on the identity.
 */
const CANCELLED = (): Order => ({
  ...row('NN-2026-005107', '2026-08-12T05:20:00.000Z'),
  status: 'cancelled',
  events: [
    ...events('2026-08-12T05:20:00.000Z'),
    {
      id: 'evt-cancelled',
      status: 'cancelled',
      note: null,
      createdAt: new Date('2026-08-12T06:00:00.000Z'),
    },
  ] as unknown as OrderEvent[],
});

function harness(
  overrides: { found?: Order | null; rows?: readonly Order[]; cancelled?: Order | null } = {},
): Harness {
  const orders = {
    list: jest.fn().mockResolvedValue(overrides.rows ?? ASHA_ORDERS),
    findOne: jest
      .fn()
      .mockResolvedValue(overrides.found === undefined ? ASHA_ORDERS[0] : overrides.found),
    cancel: jest
      .fn()
      .mockResolvedValue(overrides.cancelled === undefined ? CANCELLED() : overrides.cancelled),
  };

  return {
    controller: new OrdersController(orders as unknown as OrdersService),
    orders,
  };
}

const query = (channel?: 'retail' | 'bulk'): OrderQueryDto =>
  Object.assign(new OrderQueryDto(), channel === undefined ? {} : { channel });

describe('OrdersController list', () => {
  /**
   * The owner comes from the session and from nowhere else — spec §13's IDOR rule at the point of
   * use.
   *
   * `OrderFilters` has no email field and this handler accepts no owner-bearing parameter, so there
   * is nothing a caller could send that would rescope the read. Asserted as the *first* argument
   * being the session's id rather than merely "list was called", because `list(query.something)`
   * typechecks the moment a filter grows a string field.
   */
  it('scopes the read to the session’s user id, not to anything the caller sent', async () => {
    const { controller, orders } = harness();

    await controller.list(ASHA, query());

    expect(orders.list).toHaveBeenCalledWith(ASHA.id, {});
  });

  it('passes the channel filter through to the service', async () => {
    const { controller, orders } = harness();

    await controller.list(ASHA, query('bulk'));

    expect(orders.list).toHaveBeenCalledWith(ASHA.id, { channel: 'bulk' });
  });

  /**
   * **Through `toAccountOrder`, not straight out of the repository.** This is the assertion that
   * separates the wire contract from the table.
   *
   * `AccountOrder` and `Order` share no money representation and no enum vocabulary: paise are
   * `bigint`, rupees are `number`; `channel` and the two payment columns are `UPPERCASE` Postgres
   * enums, the wire is lowercase; and `AccountOrder.id` is the order *number*, with no field for the
   * uuid at all. Returning the entities cast to the wire type compiles — both `id` fields are
   * `string` — and would not throw either, because `bigint-json.ts` patches
   * `BigInt.prototype.toJSON`: the account page would render `₹NaN` against an empty status badge,
   * with a 200 and nothing in the log.
   */
  it('answers in the wire vocabulary — rupees, lowercase enums, the order number as the id', async () => {
    const { controller } = harness();

    const [newest] = await controller.list(ASHA, query());

    expect(newest?.id).toBe('NN-2026-005107');
    expect(newest?.total).toBe(2306.85);
    expect(newest?.subtotal).toBe(2197);
    expect(newest?.gst).toBe(109.85);
    expect(newest?.channel).toBe('retail');
    expect(newest?.paymentMethod).toBe('cod');
    expect(newest?.paymentStatus).toBe('pending');
    expect(newest?.status).toBe('confirmed');
    expect(newest?.email).toBe('b2c@demo.in');
  });

  /**
   * Every order, in the order the service gave them, each with its own timeline and lines.
   *
   * `found[0]` mapped and the rest forwarded raw is a plausible slip — a `.map` written as an index
   * lookup — and it would show up as one correct order followed by garbage, which is why the whole
   * list is compared rather than its head.
   */
  it('maps every order and preserves the newest-first sequence', async () => {
    const { controller } = harness();

    const found = await controller.list(ASHA, query());

    expect(found.map((order) => order.id)).toEqual(['NN-2026-005107', 'NN-2026-004977']);
    for (const order of found) {
      expect(order.items.map((line) => line.name)).toEqual([
        'Premium California Almonds',
        'W320 Cashews',
      ]);
      expect(order.timeline.map((entry) => entry.status)).toEqual(['pending', 'confirmed']);
    }
  });

  /**
   * An empty history is `[]` and a 200, not a 404. A customer who has never ordered is not an error,
   * and `/account/orders` renders its own empty state.
   */
  it('answers an empty list for a customer with no orders', async () => {
    const { controller } = harness({ rows: [] });

    await expect(controller.list(ASHA, query())).resolves.toEqual([]);
  });
});

describe('OrdersController detail', () => {
  it('scopes the lookup to the session’s user id and the number in the path', async () => {
    const { controller, orders } = harness();

    await controller.findOne(ASHA, 'NN-2026-005107');

    expect(orders.findOne).toHaveBeenCalledWith(ASHA.id, 'NN-2026-005107');
  });

  it('answers one order in the wire vocabulary, with its timeline oldest first', async () => {
    const { controller } = harness();

    const order = await controller.findOne(ASHA, 'NN-2026-005107');

    expect(order.id).toBe('NN-2026-005107');
    expect(order.total).toBe(2306.85);
    expect(order.timeline).toEqual([
      { status: 'pending', at: '2026-08-12T05:20:00.000Z' },
      { status: 'confirmed', at: '2026-08-12T05:22:00.000Z', note: 'Payment received.' },
    ]);
  });

  /**
   * **404, and the status is the whole assertion.**
   *
   * `DomainError`'s third parameter defaults to **422**, so a throw that omits `HttpStatus.NOT_FOUND`
   * answers a mistyped order number with "unprocessable entity" — a status no client's not-found
   * branch is looking at, and one that reads as "your request was malformed" for a URL that was
   * perfectly well formed. The code is asserted alongside it because the two travel together in
   * `ApiError` and clients switch on the code.
   */
  it('turns the service’s null into a 404 with NOT_FOUND', async () => {
    const { controller } = harness({ found: null });

    const failure: unknown = await controller
      .findOne(ASHA, 'NN-2026-999999')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DomainError);
    const error = failure as DomainError;
    expect(error.getStatus()).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.getResponse()).toEqual({
      code: 'NOT_FOUND',
      message: 'No order NN-2026-999999 in your account.',
      details: { orderNumber: 'NN-2026-999999' },
    });
  });

  /**
   * **Never a 403, and this is the assertion that says so.**
   *
   * `OrdersService.findOne` answers `null` for both "no such order" and "not yours" and cannot tell
   * them apart — so the controller has nothing to branch on, and that is deliberate rather than a
   * limitation. Order numbers are sequential and walkable (`NN-2026-005107` and `NN-2026-005042`
   * differ by 65), so a 403 for the second case would turn this route into an existence oracle: a
   * scan of the range would enumerate the shop's order volume and every live reference in it, from a
   * signed-in account with one order of its own. Spec §13.
   *
   * Asserted as an *equality between the two answers* rather than as two separate 404s, because the
   * property is "the endpoint is not an oracle" and not "this lookup missed". Note also that
   * `ErrorCodes` has no `FORBIDDEN` member at all — the registry saying the same thing one layer
   * down.
   */
  it('answers a stranger’s order exactly as it answers one that does not exist', async () => {
    const { controller } = harness({ found: null });

    const strangers = await controller.findOne(ASHA, 'NN-2026-005042').catch((e: unknown) => e);
    const absent = await controller.findOne(ASHA, 'NN-2026-999999').catch((e: unknown) => e);

    for (const failure of [strangers, absent]) {
      expect(failure).toBeInstanceOf(DomainError);
      expect((failure as DomainError).getStatus()).toBe(404);
      expect((failure as DomainError).getStatus()).not.toBe(403);
      expect((failure as DomainError).code).toBe('NOT_FOUND');
    }
    // Nothing in the response distinguishes the two beyond the number the caller themselves sent.
    expect((strangers as DomainError).getStatus()).toBe((absent as DomainError).getStatus());
  });
});

describe('OrdersController cancel', () => {
  /**
   * The order comes from the path, the owner from the session, and there is **no third argument**.
   *
   * `POST .../cancel` takes no body: the target status is `'cancelled'`, hardcoded in the service,
   * because `RETAIL_TRANSITIONS` also allows `delivered -> refunded` and a route that accepted a
   * status would let a customer refund themselves through an endpoint named cancel. The whole
   * argument list is compared for that reason — a `to` smuggled in as a third parameter fails here.
   */
  it('scopes the cancel to the session’s user id and the number in the path', async () => {
    const { controller, orders } = harness();

    await controller.cancel(ASHA, 'NN-2026-005107');

    expect(orders.cancel).toHaveBeenCalledTimes(1);
    expect(orders.cancel).toHaveBeenCalledWith(ASHA.id, 'NN-2026-005107');
  });

  /**
   * The response is the order **after** the transition, mapped, so the page can re-render from it
   * rather than guessing what the server did.
   *
   * `status` and the last timeline entry are both asserted because they are the two things that
   * moved, and because a handler that answered `this.orders.findOne(...)`'s row instead — the
   * plausible slip, since the two lines are one word apart — would come back `confirmed` with a
   * two-step timeline and a 200 attached.
   */
  it('answers the cancelled order in the wire vocabulary, timeline and all', async () => {
    const { controller } = harness();

    const order = await controller.cancel(ASHA, 'NN-2026-005107');

    expect(order.id).toBe('NN-2026-005107');
    expect(order.status).toBe('cancelled');
    expect(order.timeline.map((entry) => entry.status)).toEqual([
      'pending',
      'confirmed',
      'cancelled',
    ]);
    // Still the wire's vocabulary and not the table's — the mapper is on this path too.
    expect(order.total).toBe(2306.85);
    expect(order.channel).toBe('retail');
  });

  /**
   * **The cancel's 404 and the read's 404 are the same object, field for field.**
   *
   * That identity is the property, not two separate 404s. `OrdersService` answers `null` for both "no
   * such order" and "not yours" on either path, and a cancel that said anything the read did not —
   * a different message, a different code, a 403 — would hand an attacker the difference between an
   * order that exists and one that does not, on sequential order numbers. Compared as whole
   * responses so a reworded message on one route alone fails.
   */
  it('answers a miss with exactly the 404 the read answers', async () => {
    const { controller } = harness({ found: null, cancelled: null });

    const read = await controller.findOne(ASHA, 'NN-2026-005042').catch((e: unknown) => e);
    const cancel = await controller.cancel(ASHA, 'NN-2026-005042').catch((e: unknown) => e);

    for (const failure of [read, cancel]) {
      expect(failure).toBeInstanceOf(DomainError);
      expect((failure as DomainError).getStatus()).toBe(404);
      expect((failure as DomainError).getStatus()).not.toBe(403);
    }
    expect((cancel as DomainError).getResponse()).toEqual((read as DomainError).getResponse());
    expect((cancel as DomainError).getResponse()).toEqual({
      code: 'NOT_FOUND',
      message: 'No order NN-2026-005042 in your account.',
      details: { orderNumber: 'NN-2026-005042' },
    });
  });

  /**
   * A refusal from `OrderStatusService` travels out untouched.
   *
   * The 422 that says an order cannot be cancelled carries `allowed` — `nextStatuses(channel, from)`
   * — and the whole reason it does is so a client can say what *is* possible. A handler that caught
   * it and rethrew its own error, or that mapped it onto the 404 above, would leave the UI with "no"
   * and nothing else. So the error object itself is asserted to be the one the service threw.
   */
  it('lets an illegal transition through as the 422 the status service raised', async () => {
    const { controller, orders } = harness();
    const raised = new DomainError(
      'ILLEGAL_STATUS_TRANSITION',
      'An order that is "shipped" cannot become "cancelled".',
      HttpStatus.UNPROCESSABLE_ENTITY,
      { orderNumber: 'NN-2026-005042', from: 'shipped', to: 'cancelled', allowed: ['delivered'] },
    );
    orders.cancel.mockRejectedValue(raised);

    const failure = await controller.cancel(ASHA, 'NN-2026-005042').catch((e: unknown) => e);

    expect(failure).toBe(raised);
    expect((failure as DomainError).getStatus()).toBe(422);
    expect((failure as DomainError).details?.allowed).toEqual(['delivered']);
  });
});

/**
 * Everything below reads Nest's own metadata instead of calling a handler.
 *
 * A hand-built controller test cannot see a decorator, which is how a wishlist route with no `@Get`
 * at all shipped past 349 unit and 155 integration tests over a 404. Every direct call above would
 * pass against a controller whose routes were never registered, whose routes were declared in an
 * order that makes one unreachable, or which resolved its caller with the wrong decorator.
 */
function handlerOf(name: string): (...args: never[]) => unknown {
  const handler: unknown = Object.getOwnPropertyDescriptor(OrdersController.prototype, name)?.value;
  if (typeof handler !== 'function') throw new Error(`OrdersController has no \`${name}\``);
  return handler as (...args: never[]) => unknown;
}

interface DeclaredRoute {
  name: string;
  method: string;
  path: string;
}

function declaredRoutes(): DeclaredRoute[] {
  const prototype: object = OrdersController.prototype;
  const routes: DeclaredRoute[] = [];

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

/**
 * The handler names, read off the routing table rather than listed.
 *
 * Every `it.each` below iterates this instead of `['list', 'findOne']`, so the two decorator rules
 * this controller lives by — a strict user and no `@Public()` — cover a route added in Task 20 or by
 * the admin plan the moment it is declared, without anyone remembering to extend a literal array.
 * `catalog.controller.spec.ts` draws the same distinction between a control and an inventory: the
 * enumeration above is the inventory and has to be edited; these are controls and do not.
 */
const ROUTED = declaredRoutes().map((route) => route.name);

describe('OrdersController routing table', () => {
  /**
   * `account/orders` on the class, so both routes sit where §6.3 puts them. Read off the class
   * because the prefix is the half of every path that no handler mentions: `@Controller('orders')`
   * would move the whole account section to `/api/v1/orders` and every assertion above would still
   * pass.
   */
  it('routes both reads and the cancel under the account prefix', () => {
    expect(Reflect.getMetadata(PATH_METADATA, OrdersController)).toBe('account/orders');
    expect(declaredRoutes()).toEqual([
      { name: 'list', method: 'GET', path: '/' },
      { name: 'findOne', method: 'GET', path: ':orderNumber' },
      { name: 'cancel', method: 'POST', path: ':orderNumber/cancel' },
    ]);
  });

  /**
   * **The parameterised route is declared last, and every literal one above it.**
   *
   * Nest registers handlers in `Object.getOwnPropertyNames(prototype)` order — declaration order —
   * and Express matches the first that fits, so `:orderNumber` matches any single segment and
   * swallows every literal sibling declared below it. `GET /account/orders/summary` would reach
   * `findOne('summary')`, ask the database for an order nobody placed, and answer **404** — a route
   * that exists, is decorated, and is unreachable, which no direct-call test in this file can see.
   * Measured on `CatalogController` before its own version of this test was written:
   * `products/bestsellers` declared below `products/:slug` answered *"That product may have been
   * renamed or is no longer stocked."*
   *
   * Written as an invariant over the whole list rather than as an assertion about a named route,
   * because **there is no literal sibling today** — which is exactly when one gets added. This covers
   * the sibling that arrives in Task 20 or the admin plan without anyone remembering to extend it;
   * the enumeration above is the complementary control, and it fails the moment the two existing
   * declarations are swapped.
   */
  it('declares every literal route above the :orderNumber pattern', () => {
    const paths = declaredRoutes().map((route) => route.path);
    const patternAt = paths.indexOf(':orderNumber');
    expect(patternAt).toBeGreaterThanOrEqual(0);

    const shadowed = paths.slice(patternAt + 1).filter((path) => !path.includes(':'));
    expect(shadowed).toEqual([]);
  });

  /**
   * **`@HttpCode(HttpStatus.OK)` on the cancel, because Nest answers a `POST` with 201 by default.**
   *
   * Nothing is created: the body is the same `AccountOrder` the detail route answers, re-read after
   * the transition. A 201 says a new resource exists at a URL the response does not name, which no
   * client can act on — and a client written against 200 that checks the status rather than
   * `response.ok` breaks on it. Invisible to every direct-call test in this file, because a handler's
   * return value carries no status; only the metadata does.
   *
   * Asserted over the whole routing table rather than about `cancel` by name, so a second write added
   * later has to make the same decision explicitly. The two reads are `GET`s and Nest's default for
   * those is already 200, which is why they are expected to carry no override.
   */
  it('answers the write with 200 rather than Nest’s default 201', () => {
    const codes = declaredRoutes().map((route) => ({
      name: route.name,
      method: route.method,
      code: Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf(route.name)) as unknown,
    }));

    expect(codes).toEqual([
      { name: 'list', method: 'GET', code: undefined },
      { name: 'findOne', method: 'GET', code: undefined },
      { name: 'cancel', method: 'POST', code: HttpStatus.OK },
    ]);
  });
});

type ParamFactory = (data: unknown, context: ExecutionContext) => unknown;

function customParamFactories(method: string): ParamFactory[] {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, OrdersController, method) as
    Record<string, { factory?: ParamFactory }> | undefined;
  return Object.values(args ?? {})
    .map((entry) => entry.factory)
    .filter((factory): factory is ParamFactory => typeof factory === 'function');
}

const GUEST_CONTEXT = {
  switchToHttp: () => ({ getRequest: () => ({ cookies: {} }) }),
} as unknown as ExecutionContext;

const SIGNED_IN_CONTEXT = {
  switchToHttp: () => ({ getRequest: () => ({ cookies: {}, user: ASHA }) }),
} as unknown as ExecutionContext;

/**
 * **`@CurrentUser()`, not `@OptionalUser()` — the mirror image of what
 * `checkout.controller.spec.ts` asserts about its public routes.**
 *
 * The two decorators are interchangeable to `tsc`: a param decorator's return type is not the
 * declared parameter type, so `@OptionalUser() user: AuthenticatedUser` typechecks cleanly and hands
 * the handler `undefined` for a caller with no session. Both handlers then read `user.id` off it and
 * throw `Cannot read properties of undefined` — a **500** on every anonymous request, which is
 * exactly how the wishlist's version of this was found.
 *
 * The worse outcome is the *repair*. A 500 like that gets fixed where it is thrown, and the obvious
 * fix is `user?.id ?? null` — at which point the route answers `[]` to anonymous callers, because
 * `OrdersService.list(null)` returns an empty array by design. That is the failure this task exists
 * to prevent: a missing guard hidden behind an empty array, indistinguishable from a customer who has
 * never ordered. Written instead as `user?.id ?? undefined`, the guest guard is skipped entirely and
 * `where: { userId: undefined }` reaches TypeORM, which **drops** the criterion
 * (`SelectQueryBuilder.js:2496-2504`) and answers with every order in the table.
 *
 * All of that is unreachable today only because these routes carry no `@Public()` and `JwtAuthGuard`
 * refuses an anonymous caller first — which is why both halves are pinned below. The strict decorator
 * is the second lock, and its whole observable behaviour is that it *throws*, so this is the only
 * test in the repository that can see the difference.
 */
describe('OrdersController param decorators', () => {
  it.each(ROUTED)(
    'refuses to resolve a caller with no session on %s, so no route is optional-user',
    (method) => {
      const factories = customParamFactories(method);

      // Exactly one custom factory per handler: the user. `@Query()` and `@Param()` are built-ins and
      // carry no factory, so a second entry here would be a second identity source on the route.
      expect(factories).toHaveLength(1);
      for (const factory of factories) {
        expect(() => factory(undefined, GUEST_CONTEXT)).toThrow(
          'CurrentUser used on a route without JwtAuthGuard',
        );
        // The positive control: with a session it resolves, so the throw above is about the absent
        // user and not about a factory that throws unconditionally.
        expect(factory(undefined, SIGNED_IN_CONTEXT)).toBe(ASHA);
      }
    },
  );

  /**
   * **No `@Public()` on either route, and that absence is the guard.**
   *
   * `JwtAuthGuard` is global, so an anonymous `GET /account/orders` is a 401 before this class is
   * reached. Marked public, it would instead reach a handler whose `@CurrentUser()` throws — a **500**
   * on every anonymous request, which is how the wishlist's version of this was found. And a route
   * marked public *and* switched to `@OptionalUser()` would answer `[]`, which is the failure this
   * task exists to prevent: a missing guard hidden behind an empty array, indistinguishable from a
   * customer who has never ordered.
   */
  it.each(ROUTED)('leaves %s authenticated, with no @Public()', (method) => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handlerOf(method))).toBeUndefined();
  });
});

/**
 * The query string, validated through the **production** pipe.
 *
 * `VALIDATION_PIPE_OPTIONS` is imported from `app.module.ts` rather than restated here, so these
 * cases are about what the server does and not about a locally-configured copy of it: a
 * `skipMissingProperties` added there, or a dropped `forbidNonWhitelisted`, fails here.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
const validate = (value: unknown): Promise<unknown> =>
  Promise.resolve(pipe.transform(value, { type: 'query', metatype: OrderQueryDto }));

describe('OrdersController query validation', () => {
  it.each(['retail', 'bulk'] as const)('accepts channel=%s', async (channel) => {
    await expect(validate({ channel })).resolves.toEqual({ channel });
  });

  /** No filter is the common case, and it must not become `{ channel: undefined }`-shaped noise. */
  it('accepts an absent channel as no filter at all', async () => {
    await expect(validate({})).resolves.toEqual({});
  });

  /**
   * **The `@IsIn` case, and the reason the DTO exists at all.**
   *
   * Without it, `?channel=gold` is a 200. `OrdersService.list` resolves the value through
   * `CHANNEL[filters.channel]`, a string outside the union resolves to `undefined`, and TypeORM
   * *drops* an `undefined` from a find-options `where` — default
   * `invalidWhereValuesBehavior.undefined: 'ignore'`, measured at
   * `SelectQueryBuilder.js:2496-2504` — rather than narrowing on it. So the filter **widens** the
   * query to every channel instead of matching none: a bulk customer asking for their retail orders
   * is shown all of them. `@IsOptional() @IsString()`, the pairing a reader reaches for first,
   * accepts `gold` and is exactly the hole. It stays inside the caller's own history either way,
   * because `userId` is a separate clause — a wrong answer, never a leak.
   */
  it('rejects a channel outside the union, which would otherwise widen the query', async () => {
    const failure: unknown = await validate({ channel: 'gold' }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DomainError);
    expect((failure as DomainError).getStatus()).toBe(400);
    expect((failure as DomainError).code).toBe('VALIDATION_FAILED');
    expect((failure as DomainError).details).toEqual({
      channel: ['channel must be one of the following values: retail, bulk'],
    });
  });

  /**
   * The wire vocabulary is lowercase, and nothing here is case-insensitive.
   *
   * `RETAIL` is the *entity* spelling, and `orders.service.ts`'s `CHANNEL` map is keyed on the wire's
   * — so an accepted `RETAIL` would take the same widening path as `gold`. A 400 naming the two legal
   * values is the answer a client can act on.
   */
  it('rejects the entity spelling of a channel', async () => {
    await expect(validate({ channel: 'RETAIL' })).rejects.toBeInstanceOf(DomainError);
  });

  /**
   * `forbidNonWhitelisted` means an unrecognised parameter is a 400 rather than silently ignored,
   * which is what makes adding pagination later a safe, additive change: `?page=2` fails loudly
   * today instead of being dropped and answering page one.
   */
  it('rejects an unknown query parameter rather than ignoring it', async () => {
    await expect(validate({ page: '2' })).rejects.toBeInstanceOf(DomainError);
  });
});
