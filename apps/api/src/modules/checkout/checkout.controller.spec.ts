import {
  HTTP_CODE_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod, type ExecutionContext } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { IS_PUBLIC_KEY } from '../../common/auth/decorators/public.decorator';
import type { Order } from '../../entities/commerce/order.entity';
import { GUEST_TOKEN_COOKIE } from '../cart/guest-token';
import { CheckoutIdempotencyInterceptor } from './checkout-idempotency.interceptor';
import { CheckoutController } from './checkout.controller';
import type { CheckoutService } from './checkout.service';
import type { CouponPreview } from './coupon.service';
import type { PlaceOrderDto } from './dto/place-order.dto';
import type { PincodeService, PincodeVerdict } from './pincode.service';

/** A key of the shape `issueGuestToken` mints, so `readGuestToken` accepts it. */
const GUEST_KEY = '0_dHX8IZEAuUg0j-XwTEv4Ud_mvJhJpOXO1BOW9b_Ag';
const SIGNED_IN: AuthenticatedUser = { id: 'user-1', role: 'CUSTOMER', sessionId: 'session-1' };

const DTO: PlaceOrderDto = {
  shipping: {
    fullName: 'Asha Rao',
    phone: '9876543210',
    email: 'asha@example.in',
    line1: '12 Residency Road',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560025',
  },
  paymentMethod: 'cod',
};

/**
 * The entity `place()` really returns: lines loaded, **`events` undefined**.
 *
 * `place` builds its draft with `items`, saves it, and inserts the first `pending` `OrderEvent`
 * separately and afterwards — so the returned entity has no `events` at all, while TypeORM types the
 * relation as a non-optional array. The fixture reproduces that rather than tidying it up, because a
 * fixture with `events: []` would make the reload below look unnecessary and a fixture with the real
 * event would make it look already done.
 */
const PLACED = {
  id: 'ord-uuid-1',
  orderNumber: 'NN-2026-000017',
  items: [],
} as unknown as Order;

const RELOADED = {
  id: 'ord-uuid-1',
  orderNumber: 'NN-2026-000017',
  channel: 'RETAIL',
  status: 'pending',
  placedAt: new Date('2026-08-21T09:00:00.000Z'),
  estimatedDelivery: new Date('2026-08-25T09:00:00.000Z'),
  subtotalPaise: 119_700n,
  discountPaise: 0n,
  gstPaise: 10_178n,
  shippingPaise: 0n,
  totalPaise: 129_878n,
  couponCode: null,
  companyName: null,
  gstin: null,
  poNumber: null,
  paymentMethod: 'COD',
  paymentStatus: 'PENDING',
  addressSnapshot: { ...DTO.shipping },
  items: [
    {
      productSlug: 'almonds',
      name: 'Premium California Almonds',
      detail: '250g',
      qty: 2,
      lineTotalPaise: 59_800n,
    },
  ],
  events: [
    { id: 'evt-1', status: 'pending', createdAt: new Date('2026-08-21T09:00:00.000Z'), note: null },
  ],
} as unknown as Order;

/**
 * The verdict `PincodeService.resolve` gives a serviceable prefix, in the units it works in: a
 * `bigint` of paise. ₹79, which is what every seeded prefix charges.
 */
const SERVICEABLE_VERDICT: PincodeVerdict = {
  isServiceable: true,
  etaDays: 4,
  shippingPaise: 7_900n,
  matchedPrefix: '5',
};

interface Harness {
  controller: CheckoutController;
  checkout: { place: jest.Mock; previewCoupon: jest.Mock };
  pincodes: { resolve: jest.Mock };
  orders: { findOne: jest.Mock };
}

function harness(
  overrides: {
    preview?: CouponPreview;
    reloaded?: Order | null;
    verdict?: PincodeVerdict;
  } = {},
): Harness {
  const checkout = {
    place: jest.fn().mockResolvedValue(PLACED),
    previewCoupon: jest
      .fn()
      .mockResolvedValue(
        overrides.preview ?? { eligible: false as const, code: 'COUPON_INVALID' as const },
      ),
  };
  const pincodes = {
    resolve: jest.fn().mockResolvedValue(overrides.verdict ?? SERVICEABLE_VERDICT),
  };
  const orders = {
    findOne: jest
      .fn()
      .mockResolvedValue(overrides.reloaded === undefined ? RELOADED : overrides.reloaded),
  };

  return {
    controller: new CheckoutController(
      checkout as unknown as CheckoutService,
      pincodes as unknown as PincodeService,
      orders as unknown as Repository<Order>,
    ),
    checkout,
    pincodes,
    orders,
  };
}

const requestWith = (cookies: Record<string, string> = {}) => ({ cookies }) as never;

describe('CheckoutController placement', () => {
  /**
   * The session outranks the cookie. A customer who built a basket as a guest and then signed in may
   * still hold `nn_guest_token` — the merge clears it, but a failed merge or a second tab leaves it
   * behind — so a cookie that won would place an order from someone else's basket, and bill this
   * customer for it.
   */
  it('resolves a signed-in customer by id even when a guest cookie is still present', async () => {
    const { controller, checkout } = harness();

    await controller.place(SIGNED_IN, requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }), DTO);

    expect(checkout.place).toHaveBeenCalledWith({ userId: SIGNED_IN.id }, DTO, SIGNED_IN);
  });

  it('resolves a guest by their key, so a guest can place an order', async () => {
    const { controller, checkout } = harness();

    await controller.place(undefined, requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }), DTO);

    expect(checkout.place).toHaveBeenCalledWith({ guestToken: GUEST_KEY }, DTO, undefined);
  });

  /**
   * No session and no key is `{}`, and **no cookie is minted** — unlike `PUT /cart`, which has to
   * mint one because it is creating the basket. Placement needs a basket that already exists, so
   * minting here would hand a crawler a 30-day identifier and then answer `CART_EMPTY` anyway.
   */
  it('passes no owner at all for a visitor with neither, rather than minting a key', async () => {
    const { controller, checkout } = harness();

    await controller.place(undefined, requestWith(), DTO);

    expect(checkout.place).toHaveBeenCalledWith({}, DTO, undefined);
  });

  /**
   * **The reload, and why this test is the one that matters most in the file.**
   *
   * `place()` returns the `save()` result, whose `events` is `undefined` — it inserts the first
   * `pending` event separately and afterwards. `toAccountOrder(await place(...))` typechecks
   * perfectly, because TypeORM types `Order.events` as a non-optional array, and would have answered
   * `timeline: []`: a brand-new order rendering a confirmation with no history, which
   * `OrderTimeline.tsx` draws as an empty `<ol>` without complaint.
   */
  it('answers from the order reloaded with its relations, not from what place() returned', async () => {
    const { controller, orders } = harness();

    const order = await controller.place(SIGNED_IN, requestWith(), DTO);

    expect(orders.findOne).toHaveBeenCalledWith({
      where: { id: 'ord-uuid-1' },
      relations: { items: true, events: true },
      // `OrdersService.ITEMS_IN_ORDER`, and it is load-bearing rather than tidy: the account read
      // orders an order's lines by `id`, so a reload that imposed no order answered the *same*
      // order's invoice in `order_items`' physical sequence — the two disagreeing whenever the
      // second line's uuid sorts below the first. `orders.integration.spec.ts` reads one order down
      // both paths and compares them field for field, which is what found it.
      order: { items: { id: 'ASC' } },
    });
    // The order *number*, not the uuid — `AccountOrder.id` is `NN-{year}-{6 digits}` and has no
    // field for the primary key.
    expect(order.id).toBe('NN-2026-000017');
    expect(order.timeline).toEqual([{ status: 'pending', at: '2026-08-21T09:00:00.000Z' }]);
    expect(order.items).toHaveLength(1);
  });

  /**
   * Money crosses to rupees and the two enum vocabularies are lowered, all through the one mapper.
   * Asserted here as well as in `order.mapper.spec.ts` because this is the endpoint that answers a
   * customer who has just paid, and "the mapper is applied at all" is a separate claim from "the
   * mapper is correct".
   */
  it('answers in the wire vocabulary — rupees, lowercase enums', async () => {
    const { controller } = harness();

    const order = await controller.place(SIGNED_IN, requestWith(), DTO);

    expect(order.total).toBe(1298.78);
    expect(order.channel).toBe('retail');
    expect(order.paymentMethod).toBe('cod');
    expect(order.paymentStatus).toBe('pending');
  });

  /**
   * A 500 with the order number in it, not a 404. The transaction has committed by the time the
   * reload runs, so an order that cannot be read back a moment later is a server fault — telling the
   * customer their order does not exist when it very much does is the worse of the two answers.
   */
  it('fails loudly, naming the order, if the placed order cannot be read back', async () => {
    const { controller } = harness({ reloaded: null });

    await expect(controller.place(SIGNED_IN, requestWith(), DTO)).rejects.toThrow(
      'Order NN-2026-000017 was placed but could not be read back',
    );
  });
});

describe('CheckoutController pincode check', () => {
  /**
   * **Rupees, not paise, and this is the assertion the whole route hangs on.** `PincodeVerdict.
   * shippingPaise` is a `bigint`; returned unmapped it reaches the wire as the *string* `"7900"`
   * through `bigint-json.ts`'s `toJSON` patch — not a 500, which is what makes it dangerous — and
   * the checker renders `₹NaN`. `toEqual` compares whole so the pass-through fields are pinned in
   * the same breath, and `typeof` is asserted separately because `expect("79").toEqual(79)` fails
   * but `expect(79).toEqual(79)` would also pass for a figure that had been divided somewhere else.
   */
  it('answers a serviceable pincode in rupees, echoing the pincode back', async () => {
    const { controller, pincodes } = harness();

    const result = await controller.checkPincode({ pincode: '560001' });

    expect(pincodes.resolve).toHaveBeenCalledWith('560001');
    expect(result).toEqual({ pincode: '560001', serviceable: true, etaDays: 4, shipping: 79 });
    expect(typeof result.shipping).toBe('number');
  });

  /**
   * `matchedPrefix` never crosses the wire. It is on the verdict so a caller can log *why* a pincode
   * was refused; which region row outranked a customer's pincode is not the customer's business, and
   * a spread of the verdict would have carried it — which is why the mapping is written out field by
   * field. `isServiceable` does not cross either: the wire spells it `serviceable`, which is what
   * `PincodeChecker.tsx` reads, so a spread would ship both spellings and the page would use neither.
   */
  it('does not leak the matched prefix or the entity spelling of the flag', async () => {
    const { controller } = harness();

    const result = await controller.checkPincode({ pincode: '560001' });

    expect(result).not.toHaveProperty('matchedPrefix');
    expect(result).not.toHaveProperty('isServiceable');
    expect(result).not.toHaveProperty('shippingPaise');
  });

  /**
   * A stored refusal is a **200 answering "no"**, and it carries the row's own figures rather than
   * zeroes. Disagreement 1's resolution in one assertion: `900001` is refused because the seeded `9`
   * row says so, and that row carries `etaDays: 4` it will never deliver in — so the ETA is
   * meaningless here and is passed through unflattened rather than normalised, because "nothing is
   * known about this pincode" (`etaDays: 0`, `matchedPrefix: null`) and "a rule says no" are
   * different answers and the wire should not hide which one the database gave.
   */
  it('reports a refusing row as not serviceable, passing its figures through', async () => {
    const { controller } = harness({
      verdict: { isServiceable: false, etaDays: 4, shippingPaise: 0n, matchedPrefix: '9' },
    });

    await expect(controller.checkPincode({ pincode: '900001' })).resolves.toEqual({
      pincode: '900001',
      serviceable: false,
      etaDays: 4,
      shipping: 0,
    });
  });

  /**
   * Delhi. `checkout/api/index.ts:42`'s `/^[2-8]\d{5}$/` refused prefix `1` outright and a smoke
   * test pinned that refusal as *"We don't deliver here yet."*; the seeded table says prefix `1` is
   * serviceable at four days, and the table is the authority. Asserted here as well as in
   * `pincode.service.spec.ts` because "the table says yes" and "the endpoint says yes" are separate
   * claims, and this is the one a customer sees.
   */
  it('answers the Delhi pincode the Phase 1 mock refused', async () => {
    const { controller } = harness({
      verdict: { isServiceable: true, etaDays: 4, shippingPaise: 7_900n, matchedPrefix: '1' },
    });

    await expect(controller.checkPincode({ pincode: '110001' })).resolves.toMatchObject({
      serviceable: true,
      etaDays: 4,
    });
  });
});

describe('CheckoutController coupon preview', () => {
  /**
   * **Rupees, not paise.** `CouponService` answers in `bigint` paise; returned unmapped they reach the
   * wire through `bigint-json.ts`'s polyfill as the *strings* `"11970"` and `"119700"` — not a 500,
   * which is what makes it dangerous, and a figure the page would render as `₹NaN`.
   */
  it('converts an eligible coupon to rupees', async () => {
    const { controller } = harness({
      preview: {
        eligible: true,
        couponId: 'cou-1',
        couponCode: 'WELCOME10',
        discountPaise: 11_970n,
        eligibleSubtotalPaise: 119_700n,
      },
    });

    await expect(
      controller.previewCoupon(SIGNED_IN, requestWith(), { code: 'welcome10' }),
    ).resolves.toEqual({
      eligible: true,
      couponCode: 'WELCOME10',
      discount: 119.7,
      eligibleSubtotal: 1197,
    });
  });

  /**
   * `couponId` never crosses the wire. It is an internal uuid, nothing on the page needs it, and a
   * spread of the service's result would have carried it — which is why the mapping is written out
   * field by field.
   */
  it('does not leak the coupon id', async () => {
    const { controller } = harness({
      preview: {
        eligible: true,
        couponId: 'cou-1',
        couponCode: 'WELCOME10',
        discountPaise: 11_970n,
        eligibleSubtotalPaise: 119_700n,
      },
    });

    const result = await controller.previewCoupon(SIGNED_IN, requestWith(), { code: 'WELCOME10' });

    expect(result).not.toHaveProperty('couponId');
  });

  /**
   * The refusal reason travels as `reason`, not as `code`.
   *
   * `CouponPreview` names the refusal reason `code` while naming the accepted coupon's code
   * `couponCode` — one field name for two meanings across the two arms, which its own docblock calls a
   * landmine for whoever reads `result.code` next. The wire does not inherit it.
   */
  it('reports a refusal reason with the figure the customer can act on', async () => {
    const { controller } = harness({
      preview: { eligible: false, code: 'COUPON_MIN_ORDER_VALUE', minOrderValuePaise: 99_900n },
    });

    await expect(
      controller.previewCoupon(undefined, requestWith(), { code: 'BIGSPEND' }),
    ).resolves.toEqual({
      eligible: false,
      reason: 'COUPON_MIN_ORDER_VALUE',
      minOrderValue: 999,
    });
  });

  /**
   * `minOrderValue` is omitted, not sent as null or zero, on every other refusal. `COUPON_INVALID`
   * carrying `minOrderValue: 0` would read as "spend ₹0 and it works".
   */
  it('omits the minimum on a refusal that does not carry one', async () => {
    const { controller } = harness({ preview: { eligible: false, code: 'COUPON_EXPIRED' } });

    const result = await controller.previewCoupon(undefined, requestWith(), { code: 'OLD' });

    expect(result).toEqual({ eligible: false, reason: 'COUPON_EXPIRED' });
    expect(result).not.toHaveProperty('minOrderValue');
  });

  it('previews against a guest basket resolved from their key', async () => {
    const { controller, checkout } = harness();

    await controller.previewCoupon(undefined, requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }), {
      code: 'WELCOME10',
    });

    expect(checkout.previewCoupon).toHaveBeenCalledWith(
      { guestToken: GUEST_KEY },
      'WELCOME10',
      undefined,
    );
  });
});

/**
 * Everything below reads Nest's own metadata rather than calling a handler.
 *
 * Hand-built controller tests cannot see decorators, which is how a wishlist route with no `@Get` at
 * all shipped past 349 unit and 155 integration tests over a 404. Every direct call above would pass
 * against a controller whose routes were never registered.
 */
function handlerOf(name: string): (...args: never[]) => unknown {
  const handler: unknown = Object.getOwnPropertyDescriptor(
    CheckoutController.prototype,
    name,
  )?.value;
  if (typeof handler !== 'function') throw new Error(`CheckoutController has no \`${name}\``);
  return handler as (...args: never[]) => unknown;
}

function declaredRoutes(): { method: string; path: string }[] {
  const prototype: object = CheckoutController.prototype;
  const routes: { method: string; path: string }[] = [];

  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const handler: unknown = Object.getOwnPropertyDescriptor(prototype, name)?.value;
    if (typeof handler !== 'function') continue;
    const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    if (typeof path !== 'string') continue;
    const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
    routes.push({ method: RequestMethod[verb], path });
  }

  return routes;
}

describe('CheckoutController routing table', () => {
  /**
   * **`POST /checkout/pincode`, not `GET /checkout/pincode/:pincode`.** Spec §6.1 lists it as a
   * `POST` in the public block, and a `GET` with a path parameter would be more natural for a
   * six-digit lookup and would cache — which is exactly why the verb is pinned here rather than left
   * to whoever reads the handler next. Changing it means amending §6.1 the way §5.3's `guest_token`
   * deviation is recorded, not diverging unilaterally.
   */
  it('routes all three endpoints, under the controller prefix', () => {
    expect(Reflect.getMetadata(PATH_METADATA, CheckoutController)).toBe('checkout');
    expect(declaredRoutes()).toEqual([
      { method: 'POST', path: 'pincode' },
      { method: 'POST', path: 'coupon/preview' },
      { method: 'POST', path: 'orders' },
    ]);
  });
});

describe('CheckoutController response statuses', () => {
  /**
   * Preview is read-only, so 200 — Nest answers a `POST` with 201 unless `@HttpCode` says otherwise,
   * and 201 Created would claim a resource was created by asking a question.
   */
  it('answers the preview with 200, not the 201 a POST defaults to', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf('previewCoupon'))).toBe(200);
  });

  /**
   * Same reason, and it bites harder here: the pincode check is the one route a *product* page calls,
   * and a `201 Created` in answer to "do you deliver to 560001" claims a resource was created by
   * asking a question. Nest's default for a `POST` is 201, so this is a decorator that has to be
   * there rather than a behaviour that is.
   */
  it('answers the pincode check with 200, since it creates nothing', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf('checkPincode'))).toBe(200);
  });

  /**
   * 201 on placement. The success route keys on the created order, and a 200 would make "created" and
   * "already existed" indistinguishable — which the interceptor's replay makes a real distinction.
   */
  it('answers placement with 201', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf('place'))).toBe(201);
  });
});

describe('CheckoutController idempotency', () => {
  /**
   * On placement and **only** placement. A replayed preview is harmless and costs nothing; a replayed
   * placement is a second order and a second stock decrement.
   *
   * Read off `INTERCEPTORS_METADATA` because that is the only thing that can see it: an
   * `@UseInterceptors` that was never written, or written on the wrong handler, is invisible to
   * `tsc` and to every direct call in this file.
   */
  it('carries the checkout-scoped interceptor on placement', () => {
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, handlerOf('place'))).toEqual([
      CheckoutIdempotencyInterceptor,
    ]);
  });

  it.each(['previewCoupon', 'checkPincode'] as const)('leaves %s without one', (method) => {
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, handlerOf(method))).toBeUndefined();
  });
});

type ParamFactory = (data: unknown, context: ExecutionContext) => unknown;

function customParamFactories(method: string): ParamFactory[] {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, CheckoutController, method) as
    Record<string, { factory?: ParamFactory }> | undefined;
  return Object.values(args ?? {})
    .map((entry) => entry.factory)
    .filter((factory): factory is ParamFactory => typeof factory === 'function');
}

const GUEST_CONTEXT = {
  switchToHttp: () => ({ getRequest: () => ({ cookies: {} }) }),
} as unknown as ExecutionContext;

/**
 * The only thing that can catch `@CurrentUser()` on a public route.
 *
 * The strict decorator **throws** when `request.user` is absent, which on a `@Public()` route is
 * every guest — measured as a 500 on every anonymous request when it happened on the wishlist. It
 * typechecks cleanly as `@CurrentUser() user: AuthenticatedUser | undefined`, because a param
 * decorator's return type is not the declared parameter type, so `tsc` is silent; and every
 * hand-built call above passes the argument directly, so no factory ever runs. Checkout is the worst
 * place for this to land: a guest's very first Place Order.
 */
describe('CheckoutController param decorators', () => {
  it.each(['place', 'previewCoupon'] as const)(
    'resolves a guest on %s without throwing, so neither route uses the strict decorator',
    (method) => {
      const factories = customParamFactories(method);

      expect(factories.length).toBeGreaterThan(0);
      for (const factory of factories) {
        expect(() => factory(undefined, GUEST_CONTEXT)).not.toThrow();
      }
    },
  );

  /**
   * `@Public()` on both, because the checkout page is reachable anonymously. Without it `JwtAuthGuard`
   * answers 401 and no guest can buy anything — and the `@OptionalUser()` assertion above would still
   * pass, because the two decorators are independent.
   */
  it.each(['place', 'previewCoupon', 'checkPincode'] as const)('marks %s public', (method) => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handlerOf(method))).toBe(true);
  });

  /**
   * The pincode check resolves **no owner at all**, which is the opposite assertion to the two above
   * and just as deliberate. Serviceability does not depend on who is asking or what is in their
   * basket — it is one read of an admin table keyed by six digits — so the handler takes neither
   * `@OptionalUser()` nor `@Req()`. Pinned because a parameter accepted here is a parameter someone
   * later branches on, and "does this pincode deliver" would start depending on the session.
   */
  it('resolves no owner for the pincode check, because serviceability does not depend on one', () => {
    expect(customParamFactories('checkPincode')).toEqual([]);
  });
});
