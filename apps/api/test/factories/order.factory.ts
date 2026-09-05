import { toPaise } from '@nutwala/shared';
import type { DataSource } from 'typeorm';
import { Order, type AddressSnapshot } from '../../src/entities/commerce/order.entity';
import { OrderEvent } from '../../src/entities/commerce/order-event.entity';
import { OrderItem } from '../../src/entities/commerce/order-item.entity';
import { Payment } from '../../src/entities/commerce/payment.entity';
import { OrderChannelEnum, PaymentMethodEnum, PaymentStatusEnum } from '../../src/entities/enums';

/**
 * A minimal order, written directly.
 *
 * Deliberately not "place one through `POST /checkout/orders`", for the reason
 * `user.factory.ts` gives about registration: placement decrements stock, writes ledger rows,
 * resolves coupons and pincodes, and needs a signed-in cart — so a fixture built out of it drags
 * five other subsystems into a test about something else, and cannot express the states this
 * milestone most needs (`cancelled`, `refunded`, an order whose product is about to be deleted).
 * `src/database/seeds/orders.seed.ts` writes its six historical orders the same way and for the
 * same reason.
 *
 * **It writes no `InventoryTransaction` either**, matching `seedOrders`: a `SALE` row would have to
 * be matched by a reduction in `Inventory.onHand` to keep `SUM(delta) = onHand` true, and
 * `schema-invariants.integration.spec.ts` asserts exactly that invariant. Every variant therefore
 * stays at whatever `seedCatalog` gave it.
 *
 * Money arrives in **rupees** and is converted once, here, through `toPaise` — a test that wrote
 * paise literals would be the first place in this codebase to spell money twice.
 */
const ADDRESS: AddressSnapshot = {
  fullName: 'Asha Rao',
  phone: '9876543210',
  email: 'fixture@demo.in',
  line1: '12 Residency Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560025',
};

export interface OrderItemInput {
  productSlug: string;
  name: string;
  qty: number;
  /** Rupees per unit, GST-exclusive. */
  unitRupees: number;
  /** Set to bind the line to a real catalogue row, which is what makes a delete refuse. */
  productId?: string;
  variantId?: string;
  detail?: string;
}

export interface OrderInput {
  /** One of `@nutwala/shared`'s brief §33 statuses. `orders.status` is a varchar, not an enum. */
  status: string;
  /** Rupees, GST-inclusive — the figure the dashboard's revenue cards sum. */
  totalRupees: number;
  channel?: OrderChannelEnum;
  userId?: string | null;
  placedAt?: Date;
  items?: OrderItemInput[];
  orderNumber?: string;
  /**
   * The tracking timeline, oldest first — **opt-in, and empty by default.**
   *
   * A real order always has at least its opening `pending` event, written by
   * `CheckoutService.place`, so an order with no events is not a state production can reach. It is
   * still the default here because every fixture written before plan 9.2 relies on it, and adding a
   * row to all of them retrospectively would change what those tests are measuring rather than what
   * they set up. Pass it where the timeline is the point — `GET /admin/orders/:orderNumber` renders
   * these rows, and so does the customer's own tracking page, from the same table.
   *
   * `at` exists because `@CreateDateColumn` stamps transaction-start time, so several events
   * inserted together share one timestamp exactly and `toAccountOrder`'s oldest-first sort has
   * nothing to separate them by.
   */
  events?: { status: string; note?: string; at?: Date }[];
  /**
   * The `payments` row — **opt-in, and absent by default**, for the same reason `events` is.
   *
   * `CheckoutService.place` opens exactly one `PENDING` COD payment per order (spec §10.4), so a
   * real order always has one; the default stays off so no fixture written before plan 9.2 gains a
   * row it was not counting. Pass it where the payment is the point — `POST
   * /admin/orders/:orderNumber/payment/collect` is the only thing that moves it.
   *
   * `amountPaise` is not settable: it is the order's own `totalPaise`, and a fixture able to
   * disagree with it would be a fixture able to set up a state placement cannot produce.
   */
  payment?: { method?: PaymentMethodEnum; status?: PaymentStatusEnum };
}

/**
 * Distinct per call **and across spec files**, because `orders.order_number` carries a unique
 * index — and because a module-level counter is not enough here.
 *
 * Jest hands every spec *file* a fresh module registry regardless of `maxWorkers`, so a plain
 * `let sequence = 0` restarts at zero in each one and all five order-creating files mint the
 * identical `NN-2026-900001`, `NN-2026-900002`, … Between tests that is invisible, because
 * `cleanDatabase` truncates. It stops being invisible the moment a row survives the clean
 * (`docs/known-issues.md` item 1): a later file's request then addresses **a different file's
 * order**, with a different channel and a different status, and the failure looks like a broken
 * state machine rather than a leaked row. Two such failures were diagnosed on 2026-08-27 —
 * a retail order answering 200 where 422 was expected, and a bulk order answering 422 where 200
 * was, both because the number resolved to somebody else's row.
 *
 * `globalThis` survives the registry reset, and the integration suite runs `--runInBand`, so one
 * counter spans the whole run. The `9` prefix stays: it keeps these clear of the seeder's real
 * `NN-2026-100000+` numbers, and the run would have to mint 99,998 orders to reach
 * `NN-2026-999999`, which several specs use as their "no such order" sentinel.
 */
const counter = globalThis as { __nutwalaOrderSequence?: number };

export async function createTestOrder(dataSource: DataSource, input: OrderInput): Promise<Order> {
  const repository = dataSource.getRepository(Order);
  counter.__nutwalaOrderSequence = (counter.__nutwalaOrderSequence ?? 0) + 1;
  const sequence = counter.__nutwalaOrderSequence;
  const placedAt = input.placedAt ?? new Date();

  const order = await repository.save(
    repository.create({
      orderNumber: input.orderNumber ?? `NN-2026-9${String(sequence).padStart(5, '0')}`,
      userId: input.userId ?? null,
      businessId: null,
      channel: input.channel ?? OrderChannelEnum.RETAIL,
      status: input.status,
      paymentMethod: PaymentMethodEnum.COD,
      paymentStatus: PaymentStatusEnum.PENDING,
      // The dashboard reads `totalPaise` only, so the components are left consistent-looking
      // rather than arithmetically derived: a fixture that computed GST would be asserting
      // `gstOn`, which `shared/src/money.test.ts` already owns.
      subtotalPaise: toPaise(input.totalRupees),
      discountPaise: 0n,
      gstPaise: 0n,
      shippingPaise: 0n,
      totalPaise: toPaise(input.totalRupees),
      couponCode: null,
      addressSnapshot: ADDRESS,
      billingSnapshot: null,
      placedAt,
      estimatedDelivery: new Date(placedAt.getTime() + 3 * 24 * 60 * 60 * 1000),
      items: (input.items ?? []).map((item) =>
        dataSource.getRepository(OrderItem).create({
          productId: item.productId ?? null,
          variantId: item.variantId ?? null,
          productSlug: item.productSlug,
          name: item.name,
          hsn: '0802',
          detail: item.detail ?? '1kg',
          size: null,
          grams: null,
          kg: null,
          qty: item.qty,
          unitPricePaise: toPaise(item.unitRupees),
          lineTotalPaise: toPaise(item.unitRupees * item.qty),
          gstRate: '5',
          gstAmountPaise: 0n,
        }),
      ),
    }),
  );

  if (input.payment !== undefined) {
    await dataSource.getRepository(Payment).insert({
      orderId: order.id,
      method: input.payment.method ?? PaymentMethodEnum.COD,
      status: input.payment.status ?? PaymentStatusEnum.PENDING,
      amountPaise: toPaise(input.totalRupees),
      collectedAt: null,
      reference: null,
    });
  }

  if (input.events !== undefined && input.events.length > 0) {
    await dataSource.getRepository(OrderEvent).insert(
      input.events.map((event, index) => ({
        orderId: order.id,
        status: event.status,
        note: event.note ?? null,
        // A minute apart by default, so the sort has something to work with — see `events` above.
        createdAt: event.at ?? new Date(placedAt.getTime() + index * 60_000),
        actorUserId: null,
      })),
    );
  }

  return order;
}
