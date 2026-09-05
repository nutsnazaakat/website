import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { CookieOptions } from 'express';
import type { ExecutionContext } from '@nestjs/common';
import type { Product } from '@nutwala/shared';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { GUEST_TOKEN_COOKIE } from '../cart/guest-token';
import { WishlistController } from './wishlist.controller';
import type { WishlistService } from './wishlist.service';

/** A key of the shape `issueGuestToken` mints, so `readGuestToken` accepts it. */
const GUEST_KEY = '0_dHX8IZEAuUg0j-XwTEv4Ud_mvJhJpOXO1BOW9b_Ag';
const SIGNED_IN: AuthenticatedUser = { id: 'user-1', role: 'CUSTOMER', sessionId: 'session-1' };
const SAVED = ['kashmiri-almonds', 'medjoul-dates'];
const PRODUCTS = [{ slug: 'kashmiri-almonds' }] as unknown as Product[];

interface Harness {
  controller: WishlistController;
  wishlist: { list: jest.Mock; add: jest.Mock; remove: jest.Mock; slugs: jest.Mock };
  response: {
    cookie: jest.Mock<void, [string, string, CookieOptions]>;
  };
}

function harness(): Harness {
  const wishlist = {
    list: jest.fn().mockResolvedValue(PRODUCTS),
    add: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    slugs: jest.fn().mockResolvedValue(SAVED),
  };
  const config = {
    getOrThrow: () => ({ auth: { cookieDomain: 'shop.example.in', cookieSecure: true } }),
  };

  return {
    controller: new WishlistController(wishlist as unknown as WishlistService, config as never),
    wishlist,
    response: { cookie: jest.fn<void, [string, string, CookieOptions]>() },
  };
}

const requestWith = (cookies: Record<string, string> = {}) => ({ cookies }) as never;

describe('WishlistController reading', () => {
  /**
   * A crawler, or anyone who has never saved anything, has no key and no rows. An empty list is the
   * answer — not a 404, and not a freshly minted 30-day identifier handed out for a GET.
   *
   * The service cannot supply this: `ownerWhere` throws for an ownerless call by design, so without
   * the short-circuit here a first-time visitor's `GET /wishlist` answers 404.
   */
  it('answers an empty list for a visitor with neither a session nor a key, without querying', async () => {
    const { controller, wishlist } = harness();

    await expect(controller.list(undefined, requestWith())).resolves.toEqual([]);
    expect(wishlist.list).not.toHaveBeenCalled();
  });

  /**
   * The session outranks the cookie, and this is the case that matters. A customer who saved things
   * as a guest and then signed in may still hold `nn_guest_token` — the merge clears it, but a failed
   * merge or a second tab leaves it behind — so a cookie that won would serve someone else's list.
   */
  it('resolves a signed-in customer by their id even when a guest cookie is still present', async () => {
    const { controller, wishlist } = harness();

    await controller.list(SIGNED_IN, requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }));

    expect(wishlist.list).toHaveBeenCalledWith({ userId: SIGNED_IN.id }, SIGNED_IN);
  });

  it('resolves a guest by their key', async () => {
    const { controller, wishlist } = harness();

    await controller.list(undefined, requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }));

    expect(wishlist.list).toHaveBeenCalledWith({ guestToken: GUEST_KEY }, undefined);
  });
});

/**
 * `GET /wishlist/slugs` — the membership read every listing page makes.
 *
 * Separate from `GET /wishlist` on purpose: a 24-card shop page needs to know which hearts are
 * filled, not 24 fully priced products, and `WishlistService.slugs` is one indexed column read
 * against `list`'s catalogue mapper.
 */
describe('WishlistController slug membership', () => {
  /**
   * Same short-circuit as `list`, and needed for the same reason: `ownerWhere` throws for an
   * ownerless call, so without it a first-time visitor's mount request answers 404 rather than
   * "you have saved nothing". Every page renders hearts, so that is every first visit.
   */
  it('answers an empty set for a visitor with neither a session nor a key, without querying', async () => {
    const { controller, wishlist } = harness();

    await expect(controller.slugs(undefined, requestWith())).resolves.toEqual({ slugs: [] });
    expect(wishlist.slugs).not.toHaveBeenCalled();
  });

  it('resolves a guest by their key', async () => {
    const { controller, wishlist } = harness();

    await expect(
      controller.slugs(undefined, requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY })),
    ).resolves.toEqual({ slugs: SAVED });
    expect(wishlist.slugs).toHaveBeenCalledWith({ guestToken: GUEST_KEY });
  });

  /**
   * The session outranks a stale guest cookie here too. Getting this wrong on *this* route is the
   * quietest of the three: the customer would see a guest's hearts on the shop page while their own
   * `/wishlist` showed the account's products, and nothing would error.
   */
  it('resolves a signed-in customer by their id even when a guest cookie is still present', async () => {
    const { controller, wishlist } = harness();

    await controller.slugs(SIGNED_IN, requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }));

    expect(wishlist.slugs).toHaveBeenCalledWith({ userId: SIGNED_IN.id });
  });
});

describe('WishlistController saving', () => {
  /**
   * Writing needs an owner, so `POST` is the one route that mints a key — the asymmetry with `GET`
   * and `DELETE` above is deliberate. Without it there is nothing to hang the row off, and the
   * service's `ownerWhere` would reject the follow-up `slugs()` call.
   */
  it('mints a key for a visitor who has none, and saves against that same key', async () => {
    const { controller, wishlist, response } = harness();

    await controller.add('kashmiri-almonds', undefined, requestWith(), response as never);

    expect(response.cookie).toHaveBeenCalledTimes(1);
    const [name, minted] = response.cookie.mock.calls.at(0) ?? [];
    expect(name).toBe(GUEST_TOKEN_COOKIE);
    expect(wishlist.add).toHaveBeenCalledWith({ guestToken: minted }, 'kashmiri-almonds');
  });

  /**
   * A returning guest's key is reused, never replaced. Minting a fresh one per save would orphan
   * every row saved under the previous key — the customer's list emptying itself as they add to it.
   */
  it('reuses an existing key rather than minting a second one', async () => {
    const { controller, wishlist, response } = harness();

    await controller.add(
      'kashmiri-almonds',
      undefined,
      requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }),
      response as never,
    );

    expect(response.cookie).not.toHaveBeenCalled();
    expect(wishlist.add).toHaveBeenCalledWith({ guestToken: GUEST_KEY }, 'kashmiri-almonds');
  });

  it('never mints a key for a signed-in customer, stale cookie or not', async () => {
    const { controller, wishlist, response } = harness();

    await controller.add(
      'kashmiri-almonds',
      SIGNED_IN,
      requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }),
      response as never,
    );

    expect(response.cookie).not.toHaveBeenCalled();
    expect(wishlist.add).toHaveBeenCalledWith({ userId: SIGNED_IN.id }, 'kashmiri-almonds');
  });

  /**
   * 200 with the new set, not 204. `TransformInterceptor` turns a handler returning `undefined` into
   * `{ success: true, data: null }`, so a 204 would carry a body — which RFC 9110 forbids. Returning
   * the new state also makes the client's optimistic toggle trivial to reconcile.
   */
  it('answers the new set of saved slugs', async () => {
    const { controller } = harness();

    await expect(
      controller.add('kashmiri-almonds', SIGNED_IN, requestWith(), harness().response as never),
    ).resolves.toEqual({ slugs: SAVED });
  });
});

describe('WishlistController unsaving', () => {
  it('answers an empty set without deleting when there is no owner at all', async () => {
    const { controller, wishlist } = harness();

    await expect(controller.remove('kashmiri-almonds', undefined, requestWith())).resolves.toEqual({
      slugs: [],
    });
    expect(wishlist.remove).not.toHaveBeenCalled();
  });

  it('scopes the delete to the guest holding the key, and answers the new set', async () => {
    const { controller, wishlist } = harness();

    await expect(
      controller.remove(
        'kashmiri-almonds',
        undefined,
        requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }),
      ),
    ).resolves.toEqual({ slugs: SAVED });
    expect(wishlist.remove).toHaveBeenCalledWith({ guestToken: GUEST_KEY }, 'kashmiri-almonds');
  });
});

type ParamFactory = (data: unknown, context: ExecutionContext) => unknown;

/**
 * Every custom param factory a handler declares, read back out of Nest's route metadata.
 *
 * The same route into `createParamDecorator`'s factory that `current-user.decorator.spec.ts` uses,
 * pointed at the real controller instead of a probe class.
 */
function customParamFactories(method: string): ParamFactory[] {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, WishlistController, method) as
    Record<string, { factory?: ParamFactory }> | undefined;
  return Object.values(args ?? {})
    .map((entry) => entry.factory)
    .filter((factory): factory is ParamFactory => typeof factory === 'function');
}

const GUEST_CONTEXT = {
  switchToHttp: () => ({ getRequest: () => ({ cookies: {} }) }),
} as unknown as ExecutionContext;

/**
 * Nothing else in this repository can catch this, and it is a 500 on every guest request.
 *
 * `@CurrentUser()` throws when `request.user` is absent — see `current-user.decorator.spec.ts` —
 * and a `@Public()` route serving guests is precisely where it is absent. The trap is that
 * `@CurrentUser() user: AuthenticatedUser | undefined` type-checks cleanly: the declared parameter
 * type is not what the factory returns, so `typecheck` is silent and every unit test that constructs
 * this controller by hand passes, because a hand-built call never runs a param decorator. The first
 * anonymous `GET /wishlist` in production is what finds out.
 */
describe('WishlistController param decorators', () => {
  it.each(['list', 'slugs', 'add', 'remove'] as const)(
    'resolves a guest on %s without throwing, so no route uses the strict decorator',
    (method) => {
      const factories = customParamFactories(method);

      expect(factories.length).toBeGreaterThan(0);
      for (const factory of factories) {
        expect(() => factory(undefined, GUEST_CONTEXT)).not.toThrow();
      }
    },
  );
});

/**
 * The docstring on `add` promises 200. Nest answers a `POST` with **201** unless `@HttpCode` says
 * otherwise, and nothing else here would notice the difference: every test above calls the handler
 * directly, so the status never enters the picture, and `typecheck` has no opinion on it either.
 *
 * 201 Created would also be a lie about what happened. `add` is idempotent — the second click on a
 * heart creates nothing — so the status would claim a resource was created on the majority of calls.
 */
describe('WishlistController response status', () => {
  it('pins POST /wishlist/:slug to 200, not the 201 a POST defaults to', () => {
    // `@HttpCode` writes to the handler function, the same place `@Post` writes `PATH_METADATA` —
    // read back exactly as `catalog.controller.spec.ts` reads the routing table.
    const handler: unknown = Object.getOwnPropertyDescriptor(
      WishlistController.prototype,
      'add',
    )?.value;
    if (typeof handler !== 'function') throw new Error('WishlistController has no `add` handler');

    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
  });
});

/**
 * The routing table, read off the prototype rather than restated from the source.
 *
 * `@Get('slugs')` writes `PATH_METADATA` and `METHOD_METADATA` to the handler function, and Nest
 * registers handlers in `Object.getOwnPropertyNames(prototype)` order — declaration order, which is
 * the order Express then matches them in. Same route into the metadata as
 * `catalog.controller.spec.ts` takes.
 */
function declaredRoutes(): { method: string; path: string }[] {
  const prototype: object = WishlistController.prototype;
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

/**
 * The one thing every direct-call test above is blind to: whether the handler is *routed*.
 *
 * Measured before this test was written — `GET http://localhost:4400/api/v1/wishlist/slugs` on the
 * running service answered **404**, while `GET /api/v1/wishlist` answered `{"success":true,
 * "data":[]}`. The route the client's mount request depends on did not exist, and 349 unit tests and
 * 155 integration tests were green. A `slugs` method with no `@Get` decorator would pass all three
 * cases in "slug membership" above and still 404 in production, because a hand-built controller call
 * never consults the routing table.
 */
describe('WishlistController routing table', () => {
  it('routes every handler, including the membership read the hearts depend on', () => {
    expect(declaredRoutes()).toEqual([
      { method: 'GET', path: '/' },
      { method: 'GET', path: 'slugs' },
      { method: 'POST', path: ':slug' },
      { method: 'DELETE', path: ':slug' },
    ]);
  });
});
