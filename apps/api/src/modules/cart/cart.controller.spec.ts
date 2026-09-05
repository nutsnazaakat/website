import type { CookieOptions } from 'express';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import type { Cart } from '../../entities/commerce/cart.entity';
import { CartController } from './cart.controller';
import type { CartService } from './cart.service';
import type { CartReadService } from './cart-read.service';
import { GUEST_TOKEN_COOKIE } from './guest-token';
import type { ReplaceCartDto } from './dto/replace-cart.dto';
import type { ValidateCartDto } from './dto/validate-cart.dto';

/** A key of the shape `issueGuestToken` mints, so `readGuestToken` accepts it. */
const GUEST_KEY = '0_dHX8IZEAuUg0j-XwTEv4Ud_mvJhJpOXO1BOW9b_Ag';
const SIGNED_IN: AuthenticatedUser = { id: 'user-1', role: 'CUSTOMER', sessionId: 'session-1' };

const STORED = { id: 'cart-1' } as unknown as Cart;
const PRESENTED = { lines: [], totals: { subtotal: 0 } };
const VERDICT = { ok: true, lines: [], totals: { subtotal: 0 } };

interface Harness {
  controller: CartController;
  cart: {
    find: jest.Mock;
    replace: jest.Mock;
    mergeInto: jest.Mock;
  };
  read: { present: jest.Mock; validateStored: jest.Mock; validateLines: jest.Mock };
  response: {
    cookie: jest.Mock<void, [string, string, CookieOptions]>;
    clearCookie: jest.Mock<void, [string, CookieOptions]>;
  };
}

function harness(auth = { cookieDomain: 'shop.example.in', cookieSecure: true }): Harness {
  const cart = {
    find: jest.fn().mockResolvedValue(STORED),
    replace: jest.fn().mockResolvedValue(STORED),
    mergeInto: jest.fn().mockResolvedValue(STORED),
  };
  const read = {
    present: jest.fn().mockResolvedValue(PRESENTED),
    validateStored: jest.fn().mockResolvedValue(VERDICT),
    validateLines: jest.fn().mockResolvedValue(VERDICT),
  };
  const config = { getOrThrow: () => ({ auth }) };

  return {
    controller: new CartController(
      cart as unknown as CartService,
      read as unknown as CartReadService,
      config as never,
    ),
    cart,
    read,
    response: {
      cookie: jest.fn<void, [string, string, CookieOptions]>(),
      clearCookie: jest.fn<void, [string, CookieOptions]>(),
    },
  };
}

const requestWith = (cookies: Record<string, string> = {}) => ({ cookies }) as never;

describe('CartController.get', () => {
  /**
   * The owner is the session when there is one, and this is the case that matters most.
   *
   * A customer who built a basket as a guest and then signed in still carries `nn_guest_token` —
   * the merge clears it, but a merge that failed, or a second browser tab, leaves it in place. If
   * the cookie won, a signed-in customer would be served the guest basket instead of their own.
   */
  it('resolves a signed-in customer by their id even when a guest cookie is still present', async () => {
    const { controller, cart } = harness();

    await controller.get(SIGNED_IN, requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }));

    expect(cart.find).toHaveBeenCalledWith({ userId: SIGNED_IN.id });
  });

  it('resolves a guest by their key', async () => {
    const { controller, cart } = harness();

    await controller.get(undefined, requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }));

    expect(cart.find).toHaveBeenCalledWith({ guestToken: GUEST_KEY });
  });

  /**
   * A read must not mint a key. `CartService.find` deliberately does not create on read so a
   * crawler cannot leave a cart row per request, and issuing a cookie here would defeat the same
   * intent one layer up: every bot fetching `/cart` would be handed a durable 30-day identifier.
   */
  it('serves an empty basket to a first-time visitor without issuing them a key', async () => {
    const { controller, cart, read, response } = harness();

    const result = await controller.get(undefined, requestWith());

    expect(cart.find).toHaveBeenCalledWith({});
    expect(response.cookie).not.toHaveBeenCalled();
    expect(read.present).toHaveBeenCalledWith(STORED, undefined);
    expect(result).toBe(PRESENTED);
  });
});

describe('CartController.replace', () => {
  const dto = { lines: [] } as ReplaceCartDto;

  it('mints a key for a guest who has none, and writes the basket against it', async () => {
    const { controller, cart, response } = harness();

    await controller.replace(undefined, requestWith(), response as never, dto);

    expect(response.cookie).toHaveBeenCalledTimes(1);
    const [name, issued] = response.cookie.mock.calls[0] ?? [];
    expect(name).toBe(GUEST_TOKEN_COOKIE);
    expect(cart.replace).toHaveBeenCalledWith({ guestToken: issued }, dto);
  });

  /**
   * Reusing the key a returning guest already holds is what makes their basket theirs. Minting a
   * fresh one on every write would orphan the previous cart row on each save — the customer's
   * basket would appear to empty itself between saves, and `carts` would grow a row per write.
   */
  it('reuses the key a returning guest already holds', async () => {
    const { controller, cart, response } = harness();

    await controller.replace(
      undefined,
      requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }),
      response as never,
      dto,
    );

    expect(response.cookie).not.toHaveBeenCalled();
    expect(cart.replace).toHaveBeenCalledWith({ guestToken: GUEST_KEY }, dto);
  });

  it('writes a signed-in customer’s basket against their id, minting no guest key', async () => {
    const { controller, cart, response } = harness();

    await controller.replace(SIGNED_IN, requestWith(), response as never, dto);

    expect(cart.replace).toHaveBeenCalledWith({ userId: SIGNED_IN.id }, dto);
    expect(response.cookie).not.toHaveBeenCalled();
  });
});

describe('CartController.merge', () => {
  it('folds the guest basket in and spends the key', async () => {
    const { controller, cart, response } = harness();

    await controller.merge(
      SIGNED_IN,
      requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }),
      response as never,
    );

    expect(cart.mergeInto).toHaveBeenCalledWith(SIGNED_IN.id, GUEST_KEY);
    // Cleared with the configured domain: `clearCookie` only deletes a cookie whose attributes
    // match, so a hardcoded domain would leave a stale key in the jar to recreate an empty guest
    // cart on the next anonymous write.
    expect(response.clearCookie).toHaveBeenCalledWith(GUEST_TOKEN_COOKIE, {
      path: '/',
      domain: 'shop.example.in',
    });
  });

  it('returns the customer’s own basket when there is no guest key to fold', async () => {
    const { controller, cart, response } = harness();

    await controller.merge(SIGNED_IN, requestWith(), response as never);

    expect(cart.mergeInto).not.toHaveBeenCalled();
    expect(cart.find).toHaveBeenCalledWith({ userId: SIGNED_IN.id });
    expect(response.clearCookie).not.toHaveBeenCalled();
  });
});

describe('CartController.validate', () => {
  it('validates the lines in the body without reading the stored cart', async () => {
    const { controller, cart, read } = harness();
    const dto = {
      lines: [{ slug: 'almonds', mode: 'retail', size: '250g', qty: 1 }],
    } as ValidateCartDto;

    await controller.validate(undefined, requestWith(), dto);

    expect(read.validateLines).toHaveBeenCalledWith(dto.lines, undefined);
    expect(cart.find).not.toHaveBeenCalled();
  });

  it('validates the stored cart when the body carries no lines', async () => {
    const { controller, cart, read } = harness();

    await controller.validate(undefined, requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }), {});

    expect(cart.find).toHaveBeenCalledWith({ guestToken: GUEST_KEY });
    expect(read.validateStored).toHaveBeenCalledWith(STORED, undefined);
    expect(read.validateLines).not.toHaveBeenCalled();
  });

  /**
   * An explicit empty array is the cart page having emptied the basket, not a request to validate
   * nothing. It must reach `validateStored`, or `ok` would be computed over zero lines and report
   * a basket the customer still holds as fine — which is why the branch tests `length > 0` rather
   * than just presence.
   */
  it('falls back to the stored cart when the body carries an empty array', async () => {
    const { controller, cart, read } = harness();

    await controller.validate(undefined, requestWith(), { lines: [] });

    expect(read.validateLines).not.toHaveBeenCalled();
    expect(cart.find).toHaveBeenCalledWith({});
    expect(read.validateStored).toHaveBeenCalled();
  });

  it('validates the stored cart of a signed-in customer by their id', async () => {
    const { controller, cart } = harness();

    await controller.validate(SIGNED_IN, requestWith({ [GUEST_TOKEN_COOKIE]: GUEST_KEY }), {});

    expect(cart.find).toHaveBeenCalledWith({ userId: SIGNED_IN.id });
  });
});
