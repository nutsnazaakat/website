import type { CookieOptions } from 'express';
import type { CartService } from '../cart/cart.service';
import { GUEST_TOKEN_COOKIE } from '../cart/guest-token';
import type { SessionsService } from '../sessions/sessions.service';
import type { WishlistService } from '../wishlist/wishlist.service';
import type { WinstonLoggerService } from '../../common/logging/winston-logger.service';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { CookieService } from './cookie.service';
import type { TokenService } from './token.service';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';

const GUEST_KEY = '0_dHX8IZEAuUg0j-XwTEv4Ud_mvJhJpOXO1BOW9b_Ag';
const RESULT = {
  user: { id: 'user-1', email: 'a@b.in', role: 'b2c' },
  accessToken: 'access',
  refreshToken: 'refresh',
};

interface Harness {
  controller: AuthController;
  carts: { mergeInto: jest.Mock };
  wishlists: { mergeInto: jest.Mock };
  logger: { error: jest.Mock; setContext: jest.Mock };
  response: {
    cookie: jest.Mock;
    clearCookie: jest.Mock<void, [string, CookieOptions]>;
  };
}

interface Failures {
  cart?: boolean;
  wishlist?: boolean;
}

function harness({ cart: cartFails, wishlist: wishlistFails }: Failures = {}): Harness {
  const carts = {
    mergeInto: cartFails
      ? jest.fn().mockRejectedValue(new Error('deadlock detected'))
      : jest.fn().mockResolvedValue({ id: 'cart-1' }),
  };
  const wishlists = {
    mergeInto: wishlistFails
      ? jest.fn().mockRejectedValue(new Error('no unique or exclusion constraint'))
      : jest.fn().mockResolvedValue(undefined),
  };
  const logger = { error: jest.fn(), setContext: jest.fn() };
  logger.setContext.mockReturnValue(logger);

  const auth = {
    login: jest.fn().mockResolvedValue(RESULT),
    register: jest.fn().mockResolvedValue(RESULT),
  };
  const cookies = { issue: jest.fn().mockReturnValue('csrf-token') };
  const config = { getOrThrow: () => ({ auth: { cookieDomain: 'shop.example.in' } }) };

  return {
    controller: new AuthController(
      auth as unknown as AuthService,
      cookies as unknown as CookieService,
      {} as unknown as SessionsService,
      {} as unknown as TokenService,
      config as never,
      carts as unknown as CartService,
      wishlists as unknown as WishlistService,
      logger as unknown as WinstonLoggerService,
    ),
    carts,
    wishlists,
    logger,
    response: {
      cookie: jest.fn(),
      clearCookie: jest.fn<void, [string, CookieOptions]>(),
    },
  };
}

const requestWith = (cookies: Record<string, string> = {}) =>
  ({ cookies, ip: '127.0.0.1', header: () => undefined }) as never;

const LOGIN: LoginDto = { email: 'a@b.in', password: 'x' };
const REGISTER = { email: 'a@b.in', password: 'x', name: 'A' } as RegisterDto;

describe('AuthController sign-in folds a guest basket in', () => {
  it('merges on login and spends the key', async () => {
    const { controller, carts, response } = harness();

    await controller.login(
      LOGIN,
      requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }),
      response as never,
    );

    expect(carts.mergeInto).toHaveBeenCalledWith('user-1', GUEST_KEY);
    expect(response.clearCookie).toHaveBeenCalledWith(GUEST_TOKEN_COOKIE, {
      path: '/',
      domain: 'shop.example.in',
    });
  });

  it('merges on registration too', async () => {
    const { controller, carts } = harness();

    await controller.register(
      REGISTER,
      requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }),
      harness().response as never,
    );

    expect(carts.mergeInto).toHaveBeenCalledWith('user-1', GUEST_KEY);
  });

  it('does not reach for a cart when the visitor has no guest key', async () => {
    const { controller, carts, response } = harness();

    await controller.login(LOGIN, requestWith(), response as never);

    expect(carts.mergeInto).not.toHaveBeenCalled();
    expect(response.clearCookie).not.toHaveBeenCalled();
  });

  /**
   * A failed merge costs the customer their basket, which is bad; a failed sign-in costs them the
   * account, which is worse. So the failure is swallowed — and logged rather than hidden.
   */
  it('signs the customer in even when the merge fails', async () => {
    const { controller, logger, response } = harness({ cart: true });

    const result = await controller.login(
      LOGIN,
      requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }),
      response as never,
    );

    expect(result).toEqual({ user: RESULT.user, csrfToken: 'csrf-token' });
    expect(logger.error).toHaveBeenCalled();
  });

  /**
   * And the key survives that failure, which is the half a naive `finally` gets wrong.
   *
   * The token is the only name those guest rows have. Clearing it after a failed merge strands the
   * basket permanently — nothing can ever address it again. Leaving it means the next sign-in
   * retries, and a retried merge is harmless because `mergeInto` finds no guest cart the second
   * time.
   */
  it('leaves the key in place when the merge fails, so the next sign-in retries', async () => {
    const { controller, response } = harness({ cart: true });

    await controller.login(
      LOGIN,
      requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }),
      response as never,
    );

    expect(response.clearCookie).not.toHaveBeenCalled();
  });
});

/**
 * The cart merge and the wishlist merge are independent, and that is the argument *against* sharing a
 * `catch` rather than for it.
 */
describe('AuthController folds the guest wishlist in too', () => {
  it('merges both against the one guest key', async () => {
    const { controller, carts, wishlists, response } = harness();

    await controller.login(
      LOGIN,
      requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }),
      response as never,
    );

    expect(carts.mergeInto).toHaveBeenCalledWith('user-1', GUEST_KEY);
    expect(wishlists.mergeInto).toHaveBeenCalledWith('user-1', GUEST_KEY);
  });

  it('merges both on registration too', async () => {
    const { controller, wishlists, response } = harness();

    await controller.register(
      REGISTER,
      requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }),
      response as never,
    );

    expect(wishlists.mergeInto).toHaveBeenCalledWith('user-1', GUEST_KEY);
  });

  it('touches neither when the visitor has no guest key', async () => {
    const { controller, carts, wishlists, response } = harness();

    await controller.login(LOGIN, requestWith(), response as never);

    expect(carts.mergeInto).not.toHaveBeenCalled();
    expect(wishlists.mergeInto).not.toHaveBeenCalled();
  });

  /**
   * The one case that distinguishes two `catch` blocks from one, and the reason for the shape.
   *
   * Inside a single `try`, a throwing `carts.mergeInto` jumps straight to the `catch` and
   * `wishlists.mergeInto` is never called at all — so a customer whose *basket* merge hit a deadlock
   * silently loses their saved list as well, a second loss caused by nothing to do with the wishlist.
   */
  it('still merges the wishlist when the cart merge throws', async () => {
    const { controller, wishlists, response } = harness({ cart: true });

    await controller.login(
      LOGIN,
      requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }),
      response as never,
    );

    expect(wishlists.mergeInto).toHaveBeenCalledWith('user-1', GUEST_KEY);
  });

  it('signs the customer in even when the wishlist merge fails', async () => {
    const { controller, response } = harness({ wishlist: true });

    await expect(
      controller.login(LOGIN, requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }), response as never),
    ).resolves.toEqual({ user: RESULT.user, csrfToken: 'csrf-token' });
  });

  /**
   * The key is cleared only when **both** succeeded, because it is the only name those guest rows
   * have. Clearing it after a half-failure strands whichever half did not make it — permanently,
   * since nothing can address those rows again. Leaving it means the next sign-in retries, and a
   * retried merge is harmless: neither `mergeInto` finds anything to fold the second time.
   */
  it('keeps the key when only the wishlist merge fails, even though the cart merge succeeded', async () => {
    const { controller, carts, response } = harness({ wishlist: true });

    await controller.login(
      LOGIN,
      requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }),
      response as never,
    );

    expect(carts.mergeInto).toHaveBeenCalled();
    expect(response.clearCookie).not.toHaveBeenCalled();
  });

  /**
   * And the log says *which* one broke. A single shared message could not, and the merge is swallowed
   * by design — so the log line is the only signal that anything went wrong at all.
   */
  it('names the failing merge in the log', async () => {
    const { controller, logger, response } = harness({ wishlist: true });

    await controller.login(
      LOGIN,
      requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }),
      response as never,
    );

    expect(logger.error).toHaveBeenCalledWith(
      'Guest wishlist merge failed after sign-in',
      expect.objectContaining({ userId: 'user-1' }),
    );
  });
});
