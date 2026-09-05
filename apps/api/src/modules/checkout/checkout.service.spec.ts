import { HttpStatus } from '@nestjs/common';
import { Not, type Repository } from 'typeorm';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import type { Product } from '../../entities/catalog/product.entity';
import type { ProductVariant } from '../../entities/catalog/product-variant.entity';
import type { Cart } from '../../entities/commerce/cart.entity';
import type { Order } from '../../entities/commerce/order.entity';
import type { Business } from '../../entities/identity/business.entity';
import type { Setting } from '../../entities/ops/setting.entity';
import {
  CustomerSegment,
  OrderChannelEnum,
  InventoryTransactionType,
  PaymentMethodEnum,
  PaymentStatusEnum,
} from '../../entities/enums';
import { CartPricingService } from '../cart/cart-pricing.service';
import { CartReadService } from '../cart/cart-read.service';
import { CheckoutService } from './checkout.service';
import type { CouponPreview } from './coupon.service';
import type { PincodeVerdict } from './pincode.service';
import type { PlaceOrderDto } from './dto/place-order.dto';

/**
 * `CartReadService` and `CartPricingService` are **real** here, and that is the point of the harness.
 *
 * The gates this task exists to enforce — `quoteOnly`, `isPublished`, `moq`, the priced tier and the
 * stock level — live in `verdictFor`, and placement is required to reuse them rather than restate
 * them. Doubling the cart layer would leave every one of those tests asserting against a stub, so
 * they would pass with the gates removed. Only the repositories underneath are doubled: the settings
 * row, the pincode verdict, the coupon preview and the transaction manager.
 *
 * What a double **cannot** reach is stated where it applies: the decrement race is Task 7's, the
 * coupon race is Task 8's, and both need real Postgres and two connections.
 */

/** Numeric columns arrive from `pg` as strings, and these fixtures keep that shape. */
const ALMONDS = {
  id: 'prod-almonds',
  slug: 'almonds',
  name: 'Premium California Almonds',
  hsn: '08021200',
  categoryId: 'cat-nuts',
  isPublished: true,
  quoteOnly: false,
  gstRate: '5.00',
  moqKg: '10.00',
  // `segment: DEFAULT, businessId: null` on both rows — `resolveTiers` (Milestone 7) now filters
  // this relation, so a fixture tier missing either field is invisible to every bulk test in this
  // file, exactly as an unset `isPublished` would be.
  pricingTiers: [
    {
      minKg: '25.00',
      maxKg: '49.00',
      pricePerKgPaise: 84900n,
      segment: CustomerSegment.DEFAULT,
      businessId: null,
    },
    {
      minKg: '50.00',
      maxKg: null,
      pricePerKgPaise: null,
      segment: CustomerSegment.DEFAULT,
      businessId: null,
    },
  ],
} as unknown as Product;

/**
 * A second product at a **different GST rate**, which is what makes "per line, then summed"
 * distinguishable from any single percentage of the aggregate. With one rate in the basket the two
 * arithmetics agree and the test could not fail.
 */
const CASHEWS = {
  id: 'prod-cashews',
  slug: 'cashews',
  name: 'W320 Cashews',
  hsn: '08013200',
  categoryId: 'cat-nuts',
  isPublished: true,
  quoteOnly: false,
  gstRate: '12.00',
  moqKg: '10.00',
  pricingTiers: [],
} as unknown as Product;

const ALMOND_PACK = {
  id: 'var-almonds',
  productId: 'prod-almonds',
  size: '250g',
  grams: 250,
  isActive: true,
  moq: 1,
  pricePaise: 29900n,
  inventory: { onHand: 120, reserved: 0 },
} as unknown as ProductVariant;

const CASHEW_PACK = {
  id: 'var-cashews',
  productId: 'prod-cashews',
  size: '500g',
  grams: 500,
  isActive: true,
  moq: 1,
  pricePaise: 59900n,
  inventory: { onHand: 40, reserved: 0 },
} as unknown as ProductVariant;

interface LineFixture {
  product: Product;
  variant: ProductVariant | null;
  mode?: OrderChannelEnum;
  qty?: number;
  kg?: string | null;
}

/**
 * `var-cashews` is deliberately listed **before** `var-almonds`, so insertion order and ascending
 * `variantId` order are different.
 *
 * Task 5 found its own "this mutation will survive" prediction was wrong because its fixture happened
 * to be sorted already, which made a decrement-in-insertion-order mutation indistinguishable from the
 * real thing. An unsorted fixture is what gives the ordering assertion below something to fail on.
 */
function cartOf(lines: LineFixture[]): Cart {
  return {
    id: 'cart-1',
    userId: 'user-1',
    guestToken: null,
    items: lines.map((line, index) => ({
      id: `row-${index + 1}`,
      cartId: 'cart-1',
      productId: line.product.id,
      variantId: line.variant?.id ?? null,
      product: line.product,
      variant: line.variant,
      mode: line.mode ?? OrderChannelEnum.RETAIL,
      kg: line.kg ?? null,
      qty: line.qty ?? 1,
    })),
  } as unknown as Cart;
}

/** ₹599 of cashews at 12% and ₹598 of almonds at 5%: subtotal ₹1,197, above the ₹999 threshold. */
const MIXED_CART = cartOf([
  { product: CASHEWS, variant: CASHEW_PACK, qty: 1 },
  { product: ALMONDS, variant: ALMOND_PACK, qty: 2 },
]);

/** One ₹299 pack: below the free-shipping threshold, so shipping is actually charged. */
const SMALL_CART = cartOf([{ product: ALMONDS, variant: ALMOND_PACK, qty: 1 }]);

const SHIPPING_ADDRESS = {
  fullName: 'Asha Rao',
  phone: '9876543210',
  email: 'asha@example.in',
  line1: '12 Residency Road',
  line2: 'Near Mayo Hall',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560025',
};

const DTO: PlaceOrderDto = {
  shipping: SHIPPING_ADDRESS,
  paymentMethod: 'cod',
};

/** Serviceable, four days out, and ₹120 per-destination — deliberately not the ₹79 flat setting. */
const SERVICEABLE: PincodeVerdict = {
  isServiceable: true,
  etaDays: 4,
  shippingPaise: 12_000n,
  matchedPrefix: '5',
};

interface Recorded {
  /** Every write, in the order it was issued, so ordering claims are assertable. */
  writes: string[];
  orders: Order[];
  events: { orderId: string; status: string; note: string | null; actorUserId: string | null }[];
  payments: Record<string, unknown>[];
  redemptions: Record<string, unknown>[];
  ledger: {
    variantId: string;
    delta: number;
    type: InventoryTransactionType;
    balanceAfter: number;
    orderId: string | null;
  }[];
  stockUpdates: { variantId: string; qty: number }[];
  cartItemDeletes: { cartId: string }[];
  couponLocks: string[];
  /**
   * Every `where` `redeem` counted `orders` with, so the *criterion* is assertable and not merely the
   * refusal. The exclusion of the order being placed is the whole of the first-order re-check — a
   * version without it refuses every genuine first order — and an empty array here is what "the check
   * was skipped" looks like, which is the guest case.
   */
  orderCounts: Record<string, unknown>[];
  sequenceReads: number;
  queued: unknown[];
}

function harness(options: {
  cart?: Cart | null;
  pincode?: PincodeVerdict;
  coupon?: CouponPreview;
  settings?: { key: string; value: unknown }[];
  /** Successive answers from the guarded `UPDATE inventory`. `[]` models losing the race. */
  stockRows?: { onHand: number; lowStockThreshold?: number }[][];
  couponRow?: {
    usageLimit: number | null;
    usageLimitPerUser: number | null;
    /** Optional, so every test that predates the re-check keeps reading as "not a first-order coupon". */
    firstOrderOnly?: boolean;
  } | null;
  redemptionCounts?: { total?: number; forUser?: number };
  /** What `orders` answers `redeem`'s count with — the customer's orders *other than* this one. */
  priorOrders?: number;
  /**
   * What `SettingsService.payment()` answers. Defaults to the seeded state — COD on, online off —
   * so every test written before the `codEnabled` gate keeps reading as "the shop is open".
   */
  payment?: { codEnabled?: boolean; onlinePaymentEnabled?: boolean };
}) {
  const recorded: Recorded = {
    writes: [],
    orders: [],
    events: [],
    payments: [],
    redemptions: [],
    ledger: [],
    stockUpdates: [],
    cartItemDeletes: [],
    couponLocks: [],
    orderCounts: [],
    sequenceReads: 0,
    queued: [],
  };

  let stockCall = 0;

  const repositoryFor = (name: string) => ({
    save: (row: Order) => {
      recorded.writes.push(`${name}.save`);
      recorded.orders.push(row);
      // Mutated rather than copied, so what the service goes on to reference and what was recorded
      // are the same object — an id assigned onto a clone would leave the service holding undefined.
      return Promise.resolve(Object.assign(row, { id: 'ord-1' }));
    },
    insert: (row: Record<string, unknown>) => {
      recorded.writes.push(`${name}.insert`);
      if (name === 'OrderEvent') recorded.events.push(row as never);
      if (name === 'Payment') recorded.payments.push(row);
      if (name === 'CouponRedemption') recorded.redemptions.push(row);
      if (name === 'InventoryTransaction') recorded.ledger.push(row as never);
      return Promise.resolve({ identifiers: [] });
    },
    delete: (criteria: { cartId: string }) => {
      recorded.writes.push(`${name}.delete`);
      if (name === 'CartItem') recorded.cartItemDeletes.push(criteria);
      return Promise.resolve({ affected: 1 });
    },
    /**
     * Keyed off the **repository**, not off the shape of the `where`.
     *
     * `redeem` counts two different tables and both criteria carry a `userId`, so the older
     * `'userId' in where` discrimination answered the first-order count with a redemption figure —
     * the two checks would have been indistinguishable here, and a test could not have told which one
     * refused.
     */
    count: ({ where }: { where: Record<string, unknown> }) => {
      if (name === 'Order') {
        recorded.orderCounts.push(where);
        return Promise.resolve(options.priorOrders ?? 0);
      }
      return Promise.resolve(
        'userId' in where
          ? (options.redemptionCounts?.forUser ?? 0)
          : (options.redemptionCounts?.total ?? 0),
      );
    },
  });

  const manager = {
    getRepository: (entity: { name: string }) => repositoryFor(entity.name),
    query: (sql: string, parameters: unknown[]) => {
      if (/nextval/i.test(sql)) {
        recorded.sequenceReads += 1;
        return Promise.resolve([{ nextval: '17' }]);
      }
      if (/UPDATE "inventory"/i.test(sql)) {
        recorded.writes.push('inventory.update');
        recorded.stockUpdates.push({
          variantId: String(parameters[1]),
          qty: Number(parameters[0]),
        });
        const answer = options.stockRows?.[stockCall] ?? [{ onHand: 100, lowStockThreshold: 10 }];
        stockCall += 1;
        return Promise.resolve(answer);
      }
      if (/FOR UPDATE/i.test(sql)) {
        recorded.couponLocks.push(String(parameters[0]));
        return Promise.resolve(
          options.couponRow === undefined
            ? [{ usageLimit: null, usageLimitPerUser: null, firstOrderOnly: false }]
            : options.couponRow === null
              ? []
              : [{ firstOrderOnly: false, ...options.couponRow }],
        );
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const cartService = {
    find: jest.fn(() => Promise.resolve(options.cart === undefined ? MIXED_CART : options.cart)),
  };

  const cartRead = new CartReadService(
    { find: jest.fn().mockResolvedValue(options.settings ?? []) } as unknown as Repository<Setting>,
    { find: jest.fn() } as unknown as Repository<Product>,
    { find: jest.fn() } as unknown as Repository<ProductVariant>,
    // `null` — no business row — matching every caller in this file, which passes no `user` and so
    // resolves to the same `DEFAULT`/list-pricing viewer these tests were written against. A
    // business-specific viewer is Task 4's integration proof, over real Postgres, not this double.
    { findOne: jest.fn().mockResolvedValue(null) } as unknown as Repository<Business>,
    new CartPricingService(),
  );

  const pincodes = { resolve: jest.fn(() => Promise.resolve(options.pincode ?? SERVICEABLE)) };
  const coupons = {
    preview: jest.fn(() =>
      Promise.resolve<CouponPreview>(options.coupon ?? { eligible: false, code: 'COUPON_INVALID' }),
    ),
  };

  const settingsService = {
    payment: jest.fn(() =>
      Promise.resolve({
        codEnabled: options.payment?.codEnabled ?? true,
        onlinePaymentEnabled: options.payment?.onlinePaymentEnabled ?? false,
      }),
    ),
  };

  const notifications = {
    queue: (_manager: unknown, input: unknown) => {
      recorded.queued.push(input);
      return Promise.resolve();
    },
  };

  const service = new CheckoutService(
    { transaction: <T>(run: (m: unknown) => Promise<T>) => run(manager) } as never,
    cartService as never,
    cartRead,
    new CartPricingService(),
    pincodes as never,
    coupons as never,
    settingsService as never,
    notifications as never,
  );

  return {
    service,
    recorded,
    cartService,
    cartRead,
    pincodes,
    coupons,
    manager,
    settingsService,
    notifications,
  };
}

const OWNER = { userId: 'user-1' };

/**
 * The one order the harness recorded, and an assertion that there is exactly one.
 *
 * `noUncheckedIndexedAccess` is on, so a subscript needs unwrapping anyway; unwrapping it here also
 * pins "one placement writes one order" for every test below rather than in a test of its own.
 */
function placed(recorded: Recorded): Order {
  const [order, ...rest] = recorded.orders;
  if (!order) throw new Error('No order was written');
  if (rest.length > 0) throw new Error(`${recorded.orders.length} orders were written`);
  return order;
}

function lineOf(order: Order, index: number): Order['items'][number] {
  const line = order.items[index];
  if (!line) throw new Error(`Order has no line ${index}`);
  return line;
}

describe('CheckoutService.place — refusals', () => {
  /**
   * The request carries no lines, so an empty cart is an order for nothing rather than a defaulted
   * basket. And the number must not be burnt before the refusal: `nextval` is deliberately not rolled
   * back, so allocating first would spend a reference on every rejected attempt.
   */
  it('refuses an empty cart with 422 and does not allocate an order number', async () => {
    const { service, recorded } = harness({ cart: cartOf([]) });

    await expect(service.place(OWNER, DTO, undefined)).rejects.toMatchObject({
      code: 'CART_EMPTY',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
    expect(recorded.sequenceReads).toBe(0);
    expect(recorded.writes).toEqual([]);
  });

  it('refuses a caller who has never had a cart at all', async () => {
    const { service } = harness({ cart: null });

    await expect(service.place(OWNER, DTO, undefined)).rejects.toMatchObject({
      code: 'CART_EMPTY',
    });
  });

  /** Naming the pincode, because the customer's next action is to change it. */
  it('refuses an unserviceable pincode with 422, naming it', async () => {
    const { service, recorded } = harness({
      pincode: { isServiceable: false, etaDays: 0, shippingPaise: 0n, matchedPrefix: null },
    });

    await expect(service.place(OWNER, DTO, undefined)).rejects.toMatchObject({
      code: 'PINCODE_NOT_SERVICEABLE',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      details: { pincode: '560025' },
    });
    expect(recorded.writes).toEqual([]);
  });

  /**
   * §10.4. `PlaceOrderDto` already refuses this with `@IsIn(['cod'])`, so over HTTP the pipe answers
   * first — this branch is for a caller that reaches the service without it.
   */
  it('refuses "online" with 422 PAYMENT_METHOD_UNAVAILABLE', async () => {
    const { service, recorded } = harness({});

    await expect(
      service.place(OWNER, { ...DTO, paymentMethod: 'online' }, undefined),
    ).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_UNAVAILABLE',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
    expect(recorded.writes).toEqual([]);
  });

  /**
   * `codEnabled` was written by `settings.seed.ts` and read by **nothing**, so the only payment
   * method the shop accepts was governed by a switch with no effect: an admin who turned COD off
   * changed nothing and believed they had stopped taking orders.
   *
   * The same `PAYMENT_METHOD_UNAVAILABLE` code `"online"` gets, because from the customer's side it
   * is the same fact — the method they chose is not available. A distinct code would make a client
   * branch on which of the two the business had switched off, which is not a distinction a customer
   * can act on.
   */
  it('refuses cod with 422 PAYMENT_METHOD_UNAVAILABLE when the admin has switched COD off', async () => {
    const { service, recorded } = harness({ payment: { codEnabled: false } });

    await expect(service.place(OWNER, DTO, undefined)).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_UNAVAILABLE',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      details: { paymentMethod: 'cod' },
    });
    expect(recorded.writes).toEqual([]);
  });

  /**
   * Both settings off is a coherent state, not a contradiction to guard against: it means the
   * business is not taking orders, which is a legitimate thing for an admin to want — a supply
   * failure, a holiday, a pricing error being fixed. Nothing forces at least one method on, because
   * that would take the decision away from the person whose decision it is.
   */
  it('refuses every method when the business has switched both off', async () => {
    const { service } = harness({
      payment: { codEnabled: false, onlinePaymentEnabled: false },
    });

    await expect(service.place(OWNER, DTO, undefined)).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_UNAVAILABLE',
    });
    await expect(
      service.place(OWNER, { ...DTO, paymentMethod: 'online' }, undefined),
    ).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_UNAVAILABLE',
    });
  });

  /**
   * `"online"` stays refused whatever the setting says, and this is the assertion that stops someone
   * "completing" step 1b by gating it: flipping `onlinePaymentEnabled` would not make online payment
   * work — there is no gateway, no `Payment.reference` to record and no webhook to collect. That
   * setting gates the *card* on the checkout form, not the server's willingness to open an order it
   * cannot take money for.
   */
  it('still refuses "online" when the admin has switched online payment on', async () => {
    const { service, recorded } = harness({
      payment: { codEnabled: true, onlinePaymentEnabled: true },
    });

    await expect(
      service.place(OWNER, { ...DTO, paymentMethod: 'online' }, undefined),
    ).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_UNAVAILABLE',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
    expect(recorded.writes).toEqual([]);
  });

  /**
   * Order of the two refusals, so the settings read costs nothing on a request this service was
   * never going to accept. Asserted through the fake's call count rather than by reading the source.
   */
  it('does not read the settings for a payment method it refuses outright', async () => {
    const { service, settingsService } = harness({});

    await expect(
      service.place(OWNER, { ...DTO, paymentMethod: 'online' }, undefined),
    ).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_UNAVAILABLE',
    });

    expect(settingsService.payment).not.toHaveBeenCalled();
  });

  /** One read per placement, not one per line. */
  it('reads the payment settings exactly once for a placement it accepts', async () => {
    const { service, settingsService } = harness({});

    await service.place(OWNER, DTO, undefined);

    expect(settingsService.payment).toHaveBeenCalledTimes(1);
  });

  /**
   * The gate from `5690650`. A quote-only product has no self-service price, and until that fix the
   * server would have sold a ₹33,975 gift box to anyone who put it in a basket. Placement is the last
   * point at which that can be stopped.
   */
  it('refuses a basket containing a quote-only product, naming the line', async () => {
    const giftBox = { ...ALMONDS, slug: 'corporate-gift-box', quoteOnly: true } as Product;
    const { service, recorded } = harness({
      cart: cartOf([{ product: giftBox, variant: ALMOND_PACK, qty: 1 }]),
    });

    await expect(service.place(OWNER, DTO, undefined)).rejects.toMatchObject({
      code: 'QUOTE_REQUIRED',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      details: { lines: [{ slug: 'corporate-gift-box', code: 'QUOTE_REQUIRED' }] },
    });
    expect(recorded.writes).toEqual([]);
  });

  /**
   * The gate from `3c56549`. An unpublished product is what an admin uses to pull a line mid-season;
   * every catalogue query already filters on it, and `toValidatable` turns the unpublished relation
   * into a `NOT_FOUND` verdict rather than a priceable line.
   */
  it('refuses a basket containing an unpublished product', async () => {
    const withdrawn = { ...ALMONDS, isPublished: false } as Product;
    const { service, recorded } = harness({
      cart: cartOf([{ product: withdrawn, variant: ALMOND_PACK, qty: 1 }]),
    });

    await expect(service.place(OWNER, DTO, undefined)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      details: { lines: [{ slug: 'almonds', code: 'NOT_FOUND' }] },
    });
    expect(recorded.writes).toEqual([]);
  });

  /**
   * 409, not 422: the basket was legal when it was assembled and the customer's action is to reduce
   * the line, so retrying is sensible. Both quantities are named, so the page can say "only 120 left"
   * rather than "something went wrong".
   */
  it('refuses a line that now exceeds available stock with 409, naming the item', async () => {
    const { service, recorded } = harness({
      cart: cartOf([{ product: ALMONDS, variant: ALMOND_PACK, qty: 200 }]),
    });

    await expect(service.place(OWNER, DTO, undefined)).rejects.toMatchObject({
      code: 'OUT_OF_STOCK',
      status: HttpStatus.CONFLICT,
      details: { lines: [{ slug: 'almonds', requestedQty: 200, availableQty: 120 }] },
    });
    expect(recorded.sequenceReads).toBe(0);
    expect(recorded.writes).toEqual([]);
  });

  /** A quantity under the variant's `moq` is the cart's rule too, applied from the same code. */
  it('refuses a line below the variant minimum with 422', async () => {
    const threePackMinimum = { ...ALMOND_PACK, moq: 3 };
    const { service } = harness({
      cart: cartOf([{ product: ALMONDS, variant: threePackMinimum, qty: 1 }]),
    });

    await expect(service.place(OWNER, DTO, undefined)).rejects.toMatchObject({
      code: 'BELOW_MOQ',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
  });

  /**
   * The guarded `UPDATE` matching no row is the decrement losing a race, and it must fail the whole
   * placement rather than write a `SALE` row for stock that never moved.
   *
   * A double can only model the empty result; that the condition is genuinely evaluated inside the
   * writing statement, with no read-then-write gap, needs two real connections and is Task 7's.
   */
  it('refuses with 409 when the guarded decrement matches no row', async () => {
    const { service } = harness({ cart: SMALL_CART, stockRows: [[]] });

    await expect(service.place(OWNER, DTO, undefined)).rejects.toMatchObject({
      code: 'OUT_OF_STOCK',
      status: HttpStatus.CONFLICT,
      details: { variantId: 'var-almonds' },
    });
  });
});

describe('CheckoutService.place — the money', () => {
  /**
   * Spec §8, and the reason the basket holds two GST rates: 12% of ₹599 is ₹71.88 and 5% of ₹598 is
   * ₹29.90, so the honest figure is 10,178 paise. A single percentage of the ₹1,197 subtotal gives
   * 5,985 at 5% or 14,364 at 12% — neither is reachable by accident.
   */
  it('computes GST per line and sums it, never as a percentage of the subtotal', async () => {
    const { service, recorded } = harness({});

    await service.place(OWNER, DTO, undefined);

    const order = placed(recorded);
    expect(order.subtotalPaise).toBe(119_700n);
    expect(order.gstPaise).toBe(10_178n);
    expect(order.items.map((item) => item.gstAmountPaise)).toEqual([7_188n, 2_990n]);
  });

  /** The order's GST is the sum of its own lines' GST, or the invoice cannot be reconciled. */
  it('keeps the order total equal to subtotal − discount + gst + shipping', async () => {
    const { service, recorded } = harness({});

    await service.place(OWNER, DTO, undefined);

    const order = placed(recorded);
    expect(order.discountPaise).toBe(0n);
    expect(order.shippingPaise).toBe(0n);
    expect(order.totalPaise).toBe(129_878n);
  });

  it('applies a coupon discount and records the code it honoured', async () => {
    const { service, recorded } = harness({
      coupon: {
        eligible: true,
        couponId: 'cpn-1',
        couponCode: 'WELCOME10',
        discountPaise: 11_970n,
        eligibleSubtotalPaise: 119_700n,
      },
    });

    await service.place(OWNER, { ...DTO, couponCode: 'welcome10' }, undefined);

    const order = placed(recorded);
    expect(order.discountPaise).toBe(11_970n);
    expect(order.couponCode).toBe('WELCOME10');
    expect(order.totalPaise).toBe(117_908n);
  });

  /**
   * `Order.totalPaise` is a bigint with **no check constraint**, so a discount larger than the basket
   * would store a negative total and nothing downstream would notice. `CouponService` already clamps
   * against the eligible subtotal; this asserts placement does not simply trust the figure it is
   * handed.
   */
  it('never lets a discount exceed the subtotal', async () => {
    const { service, recorded } = harness({
      coupon: {
        eligible: true,
        couponId: 'cpn-1',
        couponCode: 'TOOBIG',
        discountPaise: 500_000n,
        eligibleSubtotalPaise: 119_700n,
      },
    });

    await service.place(OWNER, { ...DTO, couponCode: 'TOOBIG' }, undefined);

    const order = placed(recorded);
    expect(order.discountPaise).toBe(119_700n);
    expect(order.totalPaise).toBe(10_178n);
  });

  it('ignores a coupon the preview refused, without failing the order', async () => {
    const { service, recorded } = harness({ coupon: { eligible: false, code: 'COUPON_EXPIRED' } });

    await service.place(OWNER, { ...DTO, couponCode: 'GONE' }, undefined);

    expect(placed(recorded).discountPaise).toBe(0n);
    expect(placed(recorded).couponCode).toBeNull();
    expect(recorded.redemptions).toEqual([]);
  });

  /**
   * Disagreement 4, settled here: the `serviceable_pincodes` row is the charge the order uses, because
   * it is the only one of the four candidates that is per-destination and admin-editable. The settings
   * flat rate is ₹79 in this harness and the row says ₹120, so the two cannot be confused.
   */
  it('charges the pincode row for shipping, not the flat setting', async () => {
    const { service, recorded } = harness({
      cart: SMALL_CART,
      settings: [
        { key: 'freeShippingThreshold', value: 999 },
        { key: 'flatShippingRate', value: 79 },
      ],
    });

    await service.place(OWNER, DTO, undefined);

    expect(placed(recorded).shippingPaise).toBe(12_000n);
  });

  /**
   * And the free-shipping threshold still applies, which the plan's money table omits.
   *
   * `GET /cart` renders `shipping: 0` above ₹999 and the checkout page prints "Free" from that same
   * figure, so charging the pincode row regardless would bill ₹120 against a summary the customer had
   * just read as free. The decision is delegated to `CartPricingService`, which owns it for the cart
   * page, rather than restated here as a fifth copy.
   */
  it('charges no shipping once the basket clears the free-shipping threshold', async () => {
    const { service, recorded } = harness({
      settings: [
        { key: 'freeShippingThreshold', value: 999 },
        { key: 'flatShippingRate', value: 79 },
      ],
    });

    await service.place(OWNER, DTO, undefined);

    expect(placed(recorded).subtotalPaise).toBe(119_700n);
    expect(placed(recorded).shippingPaise).toBe(0n);
  });
});

describe('CheckoutService.place — the snapshots', () => {
  /**
   * `Address` the entity says *"Orders never reference this table."* An invoice has to reprint after
   * the customer has edited or deleted the address it was delivered to, so every field is copied.
   */
  it('snapshots the shipping address', async () => {
    const { service, recorded } = harness({});

    await service.place(OWNER, DTO, undefined);

    expect(placed(recorded).addressSnapshot).toEqual(SHIPPING_ADDRESS);
  });

  it('leaves the billing snapshot null when billing is the shipping address', async () => {
    const { service, recorded } = harness({});

    await service.place(OWNER, { ...DTO, billingSameAsShipping: true }, undefined);

    expect(placed(recorded).billingSnapshot).toBeNull();
  });

  it('snapshots a separate billing address when there is one', async () => {
    const billing = { ...SHIPPING_ADDRESS, line1: '4 Finance Street', pincode: '560001' };
    const { service, recorded } = harness({});

    await service.place(OWNER, { ...DTO, billingSameAsShipping: false, billing }, undefined);

    expect(placed(recorded).billingSnapshot).toEqual(billing);
  });

  /**
   * `order_items.product_id` is `ON DELETE SET NULL`, so the row is designed to outlive its product.
   * A null snapshot is an invoice that cannot be reissued — `hsn` especially, which a compliant
   * Indian GST invoice requires and which no other row can regenerate once the product is gone.
   */
  it('snapshots every column an invoice needs on each line', async () => {
    const { service, recorded } = harness({});

    await service.place(OWNER, DTO, undefined);

    expect(lineOf(placed(recorded), 1)).toMatchObject({
      productId: 'prod-almonds',
      variantId: 'var-almonds',
      productSlug: 'almonds',
      name: 'Premium California Almonds',
      hsn: '08021200',
      detail: '250g',
      size: '250g',
      grams: 250,
      kg: null,
      qty: 2,
      unitPricePaise: 29_900n,
      lineTotalPaise: 59_800n,
      gstRate: '5.00',
      gstAmountPaise: 2_990n,
    });
  });

  /**
   * A bulk line is priced from the tier ladder and is not variant-bound, so it has no `Inventory` row
   * to decrement — `verdictFor` reports its `availableQty` as null for the same reason. The per-kg rate
   * is snapshotted as the unit price, matching `orders.seed.ts`, and comes from the same tier lookup
   * that priced the line rather than a second search of the ladder.
   */
  it('prices a bulk line from its tier, snapshots the weight, and touches no inventory', async () => {
    const { service, recorded } = harness({
      cart: cartOf([
        { product: ALMONDS, variant: null, mode: OrderChannelEnum.BULK, kg: '25.00', qty: 1 },
      ]),
    });

    await service.place(OWNER, DTO, undefined);

    expect(placed(recorded).channel).toBe(OrderChannelEnum.BULK);
    expect(lineOf(placed(recorded), 0)).toMatchObject({
      variantId: null,
      detail: '25 kg',
      kg: '25.00',
      size: null,
      grams: null,
      unitPricePaise: 84_900n,
      lineTotalPaise: 2_122_500n,
      gstAmountPaise: 106_125n,
    });
    expect(recorded.stockUpdates).toEqual([]);
    expect(recorded.ledger).toEqual([]);
  });

  /** Disagreement 3: the pincode row is the only ETA with a claim to authority, so it is the one used. */
  it('takes the estimated delivery from the pincode row', async () => {
    const { service, recorded } = harness({ pincode: { ...SERVICEABLE, etaDays: 6 } });

    await service.place(OWNER, DTO, undefined);

    const order = placed(recorded);
    const days =
      (order.estimatedDelivery.getTime() - order.placedAt.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(6);
  });

  it('records the B2B block the form collects', async () => {
    const { service, recorded } = harness({});

    await service.place(
      OWNER,
      {
        ...DTO,
        companyName: 'Anand Sweets & Namkeen',
        gstin: '29ABCDE1234F1Z5',
        poNumber: 'ANS/2026/0388',
        specialInstructions: 'Goods entrance on the rear road',
      },
      undefined,
    );

    expect(placed(recorded)).toMatchObject({
      companyName: 'Anand Sweets & Namkeen',
      gstin: '29ABCDE1234F1Z5',
      poNumber: 'ANS/2026/0388',
      specialInstructions: 'Goods entrance on the rear road',
    });
  });
});

describe('CheckoutService.place — what the transaction writes', () => {
  it('allocates the order number from the sequence, inside the transaction', async () => {
    const { service, recorded } = harness({});

    await service.place(OWNER, DTO, undefined);

    expect(recorded.sequenceReads).toBe(1);
    expect(placed(recorded).orderNumber).toBe(`NN-${new Date().getFullYear()}-000017`);
  });

  /**
   * The basket is read through the transaction's own manager, not a second connection. A cart read
   * outside the transaction is a read-then-write gap: a `PUT /cart` landing between the two would be
   * priced by one snapshot and emptied from another.
   */
  it('reads the cart through the transaction manager', async () => {
    const { service, cartService, manager } = harness({});

    await service.place(OWNER, DTO, undefined);

    expect(cartService.find).toHaveBeenCalledWith(OWNER, manager);
  });

  it('opens a PENDING COD payment for the order total', async () => {
    const { service, recorded } = harness({});

    await service.place(OWNER, DTO, undefined);

    expect(recorded.payments).toEqual([
      {
        orderId: 'ord-1',
        method: PaymentMethodEnum.COD,
        status: PaymentStatusEnum.PENDING,
        amountPaise: 129_878n,
        collectedAt: null,
        reference: null,
      },
    ]);
  });

  /**
   * One event, `pending`, with a **null** `actorUserId`.
   *
   * `OrderEvent`'s docblock: *"Null for a system-generated event such as the initial `pending`"*. The
   * timeline the customer sees is these rows, and attributing the order's creation to the customer as
   * an *actor* would put their name against a step they did not perform.
   */
  it('writes exactly one pending OrderEvent, unattributed', async () => {
    const { service, recorded } = harness({});

    await service.place(OWNER, DTO, undefined);

    expect(recorded.events).toEqual([
      { orderId: 'ord-1', status: 'pending', note: null, actorUserId: null },
    ]);
  });

  it('queues order.confirmed with the order number, the shipping email and the rupee total', async () => {
    const { service, recorded } = harness({});
    // `expect.any()` is typed `any`; widened through an annotated const, as
    // `health.integration.spec.ts` does, so `no-unsafe-assignment` stays on. The figure itself is
    // `checkout.integration.spec.ts`'s to pin against the order's own total, over real JSON — here
    // only its presence and its type matter.
    const anyNumber: unknown = expect.any(Number);

    await service.place(OWNER, DTO, undefined);

    expect(recorded.queued).toEqual([
      expect.objectContaining({
        userId: 'user-1',
        channel: 'EMAIL',
        template: 'order.confirmed',
        payload: {
          orderNumber: `NN-${new Date().getFullYear()}-000017`,
          email: SHIPPING_ADDRESS.email,
          totalRupees: anyNumber,
        },
      }),
    ]);
  });

  /**
   * Ascending `variantId`, which is what makes a placement and a cancellation touching the same two
   * variants take turns rather than deadlock — `OrderStatusService` sorts its restores the same way.
   * The fixture lists `var-cashews` first, so insertion order would give the opposite sequence.
   */
  it('decrements stock in ascending variantId order, not insertion order', async () => {
    const { service, recorded } = harness({});

    await service.place(OWNER, DTO, undefined);

    expect(recorded.stockUpdates).toEqual([
      { variantId: 'var-almonds', qty: 2 },
      { variantId: 'var-cashews', qty: 1 },
    ]);
  });

  /**
   * `SUM(inventory_transactions.delta) == inventory.onHand` is asserted by
   * `schema-invariants.integration.spec.ts` and is currently clean at 0 mismatches. Every decrement
   * writes its `SALE` row in the same transaction, with a **negative** delta and a `balanceAfter` taken
   * from the `RETURNING` clause of the statement that did the writing — not from a second read, which
   * is the whole point of the ledger row.
   */
  it('writes one negative SALE ledger row per decremented line', async () => {
    const { service, recorded } = harness({ stockRows: [[{ onHand: 118 }], [{ onHand: 39 }]] });

    await service.place(OWNER, DTO, undefined);

    expect(recorded.ledger).toEqual([
      expect.objectContaining({
        variantId: 'var-almonds',
        delta: -2,
        type: InventoryTransactionType.SALE,
        balanceAfter: 118,
        orderId: 'ord-1',
      }),
      expect.objectContaining({
        variantId: 'var-cashews',
        delta: -1,
        type: InventoryTransactionType.SALE,
        balanceAfter: 39,
        orderId: 'ord-1',
      }),
    ]);
  });

  /**
   * Emptying first loses the basket if placement then fails; emptying outside the transaction loses it
   * if the process dies between the two. Both are recoverable for the business and infuriating for the
   * customer, so the delete is the last write inside the transaction.
   */
  it('empties the cart only after the order rows exist', async () => {
    const { service, recorded } = harness({});

    await service.place(OWNER, DTO, undefined);

    expect(recorded.cartItemDeletes).toEqual([{ cartId: 'cart-1' }]);
    expect(recorded.writes.indexOf('CartItem.delete')).toBeGreaterThan(
      recorded.writes.indexOf('Order.save'),
    );
    expect(recorded.writes.at(-1)).toBe('CartItem.delete');
  });

  /**
   * The redemption is inserted under `SELECT … FOR UPDATE` on the coupon row, so counting and then
   * inserting cannot both succeed for two concurrent checkouts. That two connections actually
   * serialise here is Task 8's to prove; what this asserts is that the lock is taken and the row is
   * written with the figures the order used.
   */
  it('locks the coupon row and records the redemption', async () => {
    const { service, recorded } = harness({
      coupon: {
        eligible: true,
        couponId: 'cpn-1',
        couponCode: 'WELCOME10',
        discountPaise: 11_970n,
        eligibleSubtotalPaise: 119_700n,
      },
    });

    await service.place(OWNER, { ...DTO, couponCode: 'WELCOME10' }, undefined);

    expect(recorded.couponLocks).toEqual(['cpn-1']);
    expect(recorded.redemptions).toEqual([
      { couponId: 'cpn-1', userId: 'user-1', orderId: 'ord-1', discountPaise: 11_970n },
    ]);
  });

  /**
   * The limit is re-counted **after** the lock, not before. `CouponService.preview` runs on its own
   * connection outside this transaction, so its count is advisory; the binding one is taken while the
   * row is held.
   */
  it('refuses when the coupon hit its usage limit after the preview', async () => {
    const { service } = harness({
      coupon: {
        eligible: true,
        couponId: 'cpn-1',
        couponCode: 'WELCOME10',
        discountPaise: 11_970n,
        eligibleSubtotalPaise: 119_700n,
      },
      couponRow: { usageLimit: 10, usageLimitPerUser: null },
      redemptionCounts: { total: 10 },
    });

    await expect(
      service.place(OWNER, { ...DTO, couponCode: 'WELCOME10' }, undefined),
    ).rejects.toMatchObject({
      code: 'COUPON_LIMIT_REACHED',
      status: HttpStatus.CONFLICT,
    });
  });

  /**
   * `firstOrderOnly` is re-counted under the lock too, and it used not to be — it was validated only
   * by `CouponService.preview`, outside any lock, so a coupon carrying it with no `usageLimitPerUser`
   * was redeemable twice by one customer from a double-click.
   *
   * `COUPON_FIRST_ORDER_ONLY` and not `COUPON_LIMIT_REACHED`, which is the distinction
   * `domain-error.ts` keeps the code for: no limit here will ever reset, so telling a returning
   * customer to wait is telling them the wrong thing.
   */
  it('refuses a first-order coupon when the customer already has another order', async () => {
    const { service, recorded } = harness({
      coupon: {
        eligible: true,
        couponId: 'cpn-1',
        couponCode: 'WELCOME10',
        discountPaise: 11_970n,
        eligibleSubtotalPaise: 119_700n,
      },
      couponRow: { usageLimit: null, usageLimitPerUser: null, firstOrderOnly: true },
      priorOrders: 1,
    });

    await expect(
      service.place(OWNER, { ...DTO, couponCode: 'WELCOME10' }, undefined),
    ).rejects.toMatchObject({
      code: 'COUPON_FIRST_ORDER_ONLY',
      status: HttpStatus.CONFLICT,
    });
    // Refused before the row, not after it — the insert is the last thing `redeem` does.
    expect(recorded.redemptions).toEqual([]);
  });

  /**
   * **The order being placed is excluded from its own first-order count.**
   *
   * `redeem` runs *after* `Order.save`, so by the time it counts, the customer's new order already
   * exists inside this transaction. A count without the exclusion sees it, reads one order where the
   * customer has none, and refuses **every** legitimate first-order redemption — the failure mode
   * opposite to the race, and the one a refusal test on its own cannot see. So the criterion is
   * asserted, not just the outcome.
   */
  it('excludes the order it is placing from the first-order count', async () => {
    const { service, recorded } = harness({
      coupon: {
        eligible: true,
        couponId: 'cpn-1',
        couponCode: 'WELCOME10',
        discountPaise: 11_970n,
        eligibleSubtotalPaise: 119_700n,
      },
      couponRow: { usageLimit: null, usageLimitPerUser: null, firstOrderOnly: true },
      priorOrders: 0,
    });

    await service.place(OWNER, { ...DTO, couponCode: 'WELCOME10' }, undefined);

    expect(recorded.orderCounts).toEqual([{ userId: 'user-1', id: Not('ord-1') }]);
    expect(recorded.redemptions).toEqual([
      { couponId: 'cpn-1', userId: 'user-1', orderId: 'ord-1', discountPaise: 11_970n },
    ]);
  });

  /**
   * A guest is skipped, exactly as `CouponService.preview` skips them: null `userId` means there is no
   * order history to count, and a guest is a first-order customer by definition. `preview`'s own
   * docblock argues the alternative — refuse what you cannot verify — blocks precisely the customer a
   * first-order coupon exists to attract, and the two must agree about one basket.
   *
   * `priorOrders` is set to a figure that would refuse a signed-in customer, so what the redemption
   * proves is the skip rather than an empty table.
   */
  it('skips the first-order re-check for a guest, as the preview does', async () => {
    const guestCart = { ...MIXED_CART, userId: null, guestToken: 'guest-abc' } as Cart;
    const { service, recorded } = harness({
      cart: guestCart,
      coupon: {
        eligible: true,
        couponId: 'cpn-1',
        couponCode: 'WELCOME10',
        discountPaise: 11_970n,
        eligibleSubtotalPaise: 119_700n,
      },
      couponRow: { usageLimit: null, usageLimitPerUser: null, firstOrderOnly: true },
      priorOrders: 5,
    });

    await service.place(
      { guestToken: 'guest-abc' },
      { ...DTO, couponCode: 'WELCOME10' },
      undefined,
    );

    expect(recorded.orderCounts).toEqual([]);
    expect(recorded.redemptions).toHaveLength(1);
    expect(recorded.redemptions[0]).toMatchObject({
      couponId: 'cpn-1',
      userId: null,
      orderId: 'ord-1',
    });
  });

  /**
   * A guest's basket is found by their `nn_guest_token` exactly as `GET /cart` finds it, and the order
   * is stored against no user. `orders.user_id` is nullable `SET NULL` for this reason — a guest order
   * has to survive without an account, and Task 15's reads are IDOR-scoped on the same column.
   */
  it('places a guest order against no user', async () => {
    const guestCart = { ...MIXED_CART, userId: null, guestToken: 'guest-abc' } as Cart;
    const { service, recorded, cartService, manager } = harness({ cart: guestCart });

    await service.place({ guestToken: 'guest-abc' }, DTO, undefined);

    expect(cartService.find).toHaveBeenCalledWith({ guestToken: 'guest-abc' }, manager);
    expect(placed(recorded).userId).toBeNull();
    expect(recorded.events).toHaveLength(1);
  });
});

/**
 * `POST /checkout/coupon/preview`'s service half.
 *
 * The basket comes from the **server's cart**, not the request, for the same reason placement's
 * does: spec §13. A preview that took the subtotal and the line categories from the body would let
 * a client satisfy `minOrderValuePaise` on a ₹0 order and claim any category it liked — and the
 * wire's `CartLine` carries neither a price nor a `categoryId`, so a real client could not supply
 * them honestly even if it were trusted to.
 */
describe('CheckoutService.previewCoupon', () => {
  it('measures the coupon against the caller\u2019s own cart, in paise', async () => {
    const { service, coupons, cartService } = harness({
      coupon: {
        eligible: true,
        couponId: 'cou-1',
        couponCode: 'WELCOME10',
        discountPaise: 11_970n,
        eligibleSubtotalPaise: 119_700n,
      },
    });

    await expect(service.previewCoupon(OWNER, 'welcome10', undefined)).resolves.toMatchObject({
      eligible: true,
      couponCode: 'WELCOME10',
    });

    expect(cartService.find).toHaveBeenCalledWith(OWNER);
    // ₹599 of cashews plus 2 × ₹299 of almonds. Both lines carry their real `categoryId`, which is
    // what a `CATEGORY`-scoped coupon reads, and the subtotal is summed from the same lines.
    expect(coupons.preview).toHaveBeenCalledWith(
      'welcome10',
      {
        channel: 'retail',
        lines: [
          { categoryId: 'cat-nuts', lineTotalPaise: 59_900n },
          { categoryId: 'cat-nuts', lineTotalPaise: 59_800n },
        ],
        subtotalPaise: 119_700n,
      },
      'user-1',
    );
  });

  /**
   * A refusal is returned, not thrown. The customer typed a code that did not apply; the checkout
   * page has to render *which* refusal — "add ₹500 and it works" is a different screen from "stop
   * retyping this" — and an exception collapses that into one error toast.
   */
  it('returns the refusal rather than throwing', async () => {
    const { service } = harness({
      coupon: { eligible: false, code: 'COUPON_MIN_ORDER_VALUE', minOrderValuePaise: 500_000n },
    });

    await expect(service.previewCoupon(OWNER, 'BIGSPEND', undefined)).resolves.toEqual({
      eligible: false,
      code: 'COUPON_MIN_ORDER_VALUE',
      minOrderValuePaise: 500_000n,
    });
  });

  /**
   * A sold-out line does **not** fail the preview, and it does not count towards the discount.
   *
   * Refusing here would answer a question about the coupon with an error about the basket, on the one
   * screen where the customer is trying to fix the basket. Dropping the line matches what the cart
   * page's own totals do, so the "₹X off" reported is taken from the subtotal on their screen —
   * whereas billing it would promise a discount against goods that cannot be sold.
   */
  it('drops an unpriceable line instead of refusing the whole preview', async () => {
    const soldOut = {
      ...CASHEW_PACK,
      inventory: { onHand: 0, reserved: 0 },
    } as unknown as ProductVariant;
    const { service, coupons } = harness({
      cart: cartOf([
        { product: CASHEWS, variant: soldOut, qty: 1 },
        { product: ALMONDS, variant: ALMOND_PACK, qty: 2 },
      ]),
    });

    await service.previewCoupon(OWNER, 'WELCOME10', undefined);

    expect(coupons.preview).toHaveBeenCalledWith(
      'WELCOME10',
      {
        channel: 'retail',
        lines: [{ categoryId: 'cat-nuts', lineTotalPaise: 59_800n }],
        subtotalPaise: 59_800n,
      },
      'user-1',
    );
  });

  /**
   * The channel is taken from **all** the items, refused ones included.
   *
   * `channelOf`'s rule is "any bulk line makes this a bulk order", and a bulk line under its MOQ is
   * refused — so filtering first would flip a business basket onto the retail ladder for the purpose
   * of judging a coupon's `channel` column, and a retail-only coupon would be honoured on a
   * business order.
   */
  it('reports a bulk basket as bulk even when the bulk line is the unpriceable one', async () => {
    const { service, coupons } = harness({
      cart: cartOf([
        // 5kg against a 10kg MOQ: BELOW_MOQ, so it carries no line total.
        { product: ALMONDS, variant: null, mode: OrderChannelEnum.BULK, kg: '5.00', qty: 1 },
        { product: ALMONDS, variant: ALMOND_PACK, qty: 1 },
      ]),
    });

    await service.previewCoupon(OWNER, 'BULK5', undefined);

    expect(coupons.preview).toHaveBeenCalledWith(
      'BULK5',
      {
        channel: 'bulk',
        lines: [{ categoryId: 'cat-nuts', lineTotalPaise: 29_900n }],
        subtotalPaise: 29_900n,
      },
      'user-1',
    );
  });

  /** A guest previews against their own basket and counts as a first-order customer. */
  it('previews a guest\u2019s basket against no user', async () => {
    const { service, coupons, cartService } = harness({});

    await service.previewCoupon({ guestToken: 'guest-abc' }, 'WELCOME10', undefined);

    expect(cartService.find).toHaveBeenCalledWith({ guestToken: 'guest-abc' });
    expect(coupons.preview).toHaveBeenCalledWith('WELCOME10', expect.anything(), null);
  });

  /**
   * No cart is a zero-subtotal basket, which `eligibleSubtotal` reports as `COUPON_NOT_APPLICABLE`.
   * Asserted so nobody mistakes the absence of a `CART_EMPTY` branch for an oversight: the checkout
   * page is only reachable with a basket, so this is a client already off the rails, and a refusal it
   * can render beats a branch here with nothing to test it.
   */
  it('previews an empty basket without throwing', async () => {
    const { service, coupons } = harness({ cart: null });

    await service.previewCoupon(OWNER, 'WELCOME10', undefined);

    expect(coupons.preview).toHaveBeenCalledWith(
      'WELCOME10',
      { channel: 'retail', lines: [], subtotalPaise: 0n },
      'user-1',
    );
  });

  /** Read-only: nothing is written, and no transaction is opened. */
  it('writes nothing', async () => {
    const { service, recorded } = harness({});

    await service.previewCoupon(OWNER, 'WELCOME10', undefined);

    expect(recorded.writes).toEqual([]);
    expect(recorded.sequenceReads).toBe(0);
  });
});

/**
 * Wiring, not resolution: does `place`/`previewCoupon` actually hand the caller to
 * `CartReadService.viewerFor`, so the tier it resolves for line-pricing is *this* customer's rather
 * than always `null`? `CartReadService.viewerFor`'s own suite proves what a business caller resolves
 * to; a business-specific tier actually landing in a placed order's price is Task 4's integration
 * proof, over real Postgres. This is the one thing neither of those covers — a `user` this service
 * receives but never forwards would pass every other test in this file, since `cartRead` above
 * defaults every caller to the same `DEFAULT`/list-pricing viewer regardless of who asked.
 */
describe('CheckoutService and the pricing viewer', () => {
  const CALLER: AuthenticatedUser = { id: 'user-9', role: 'BUSINESS', sessionId: 'session-9' };

  it('forwards the caller to viewerFor when placing an order', async () => {
    const { service, cartRead } = harness({});
    const viewerFor = jest.spyOn(cartRead, 'viewerFor');

    await service.place(OWNER, DTO, CALLER);

    expect(viewerFor).toHaveBeenCalledWith(CALLER);
  });

  it('forwards the caller to viewerFor when previewing a coupon', async () => {
    const { service, cartRead } = harness({});
    const viewerFor = jest.spyOn(cartRead, 'viewerFor');

    await service.previewCoupon(OWNER, 'WELCOME10', CALLER);

    expect(viewerFor).toHaveBeenCalledWith(CALLER);
  });
});
