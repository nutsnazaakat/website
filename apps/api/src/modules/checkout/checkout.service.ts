import { HttpStatus, Injectable } from '@nestjs/common';
import {
  applyFlat,
  gstOn,
  sumPaise,
  toPaise,
  toRupees,
  type CartValidationCode,
  type CartValidationLine,
  type Paise,
} from '@nutwala/shared';
import { DataSource, Not, type DeepPartial, type EntityManager } from 'typeorm';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { DomainError, ErrorCodes } from '../../common/errors/domain-error';
import { InventoryTransaction } from '../../entities/catalog/inventory-transaction.entity';
import { CartItem } from '../../entities/commerce/cart-item.entity';
import { CouponRedemption } from '../../entities/commerce/coupon-redemption.entity';
import { OrderEvent } from '../../entities/commerce/order-event.entity';
import { OrderItem } from '../../entities/commerce/order-item.entity';
import { Order, type AddressSnapshot } from '../../entities/commerce/order.entity';
import { Payment } from '../../entities/commerce/payment.entity';
import {
  InventoryTransactionType,
  NotificationChannel,
  OrderChannelEnum,
  PaymentMethodEnum,
  PaymentStatusEnum,
} from '../../entities/enums';
import { CartPricingService } from '../cart/cart-pricing.service';
import {
  bulkTierFor,
  CartReadService,
  toPricedLine,
  verdictFor,
  type ValidatableLine,
} from '../cart/cart-read.service';
import { CartService } from '../cart/cart.service';
import { checkLowStock } from '../inventory/check-low-stock';
import { NotificationsService } from '../notifications/notifications.service';
import { nextOrderNumber } from '../orders/order-number';
import type { PricingViewer } from '../pricing/pricing.resolver';
import { SettingsService } from '../settings/settings.service';
import {
  CouponService,
  type CouponAccepted,
  type CouponBasket,
  type CouponPreview,
} from './coupon.service';
import { PincodeService } from './pincode.service';
import type { AddressDto, PlaceOrderDto } from './dto/place-order.dto';

/** Who the basket belongs to — a signed-in customer, or a guest holding an `nn_guest_token`. */
export interface CartOwner {
  userId?: string;
  guestToken?: string;
}

/** A line that cleared every gate, with the figures its `order_items` row will carry. */
interface BilledLine {
  item: CartItem;
  line: ValidatableLine;
  unitPricePaise: Paise;
  lineTotalPaise: Paise;
  gstAmountPaise: Paise;
}

/** A verdict that refused its line. The `code` is narrowed so the refusal can switch on it. */
type Refusal = CartValidationLine & { code: CartValidationCode };

/**
 * The address as it was at checkout, copied field by field.
 *
 * Not a spread. `addressSnapshot` is `jsonb`, so a spread would silently carry every field the DTO
 * gains in future into the stored invoice — including ones that are not part of an address at all.
 * `line2` is omitted rather than stored as null, matching `AddressSnapshot`'s optional field.
 */
function toSnapshot(address: AddressDto): AddressSnapshot {
  return {
    fullName: address.fullName,
    phone: address.phone,
    email: address.email,
    line1: address.line1,
    ...(address.line2 === undefined ? {} : { line2: address.line2 }),
    city: address.city,
    state: address.state,
    pincode: address.pincode,
  };
}

@Injectable()
export class CheckoutService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly cart: CartService,
    private readonly cartRead: CartReadService,
    private readonly pricing: CartPricingService,
    private readonly pincodes: PincodeService,
    private readonly coupons: CouponService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Places one COD order, in one `READ COMMITTED` transaction.
   *
   * **The basket comes from the server's cart, never from the request.** Spec §13: *"Server recomputes
   * subtotal, GST, shipping, discount and total from the database; client-supplied money is ignored
   * entirely."* `PlaceOrderDto` carries the address, the payment method, the coupon code and the B2B
   * block — nothing that decides money. A body carrying lines would let a client name its own basket
   * at the last step, and the cart it had been shown would be decorative.
   *
   * A consequence worth stating: placement therefore **requires** a cart, so an empty one is a 422
   * rather than an order for nothing. The guest path works unchanged, because a guest's cart is found
   * by their `nn_guest_token` exactly as `GET /cart` finds it.
   *
   * Every gate the cart page applies is applied again here, from the same `verdictFor` — §10.1's
   * *"checked at add-to-cart for feedback and re-checked authoritatively at checkout"*. A second copy
   * of those rules would let the cart page and the checkout disagree about one basket, and the
   * customer would meet the disagreement while trying to pay.
   *
   * Returns the saved `Order` with its lines, not a wire shape: `shared`'s placement types are Task
   * 11's and the entity-to-wire mapper is Task 16's, and a third mapping invented here is what those
   * two would then have to agree with.
   *
   * **`events` on the returned entity is `undefined`, and a caller mapping it must reload first.**
   * The first `pending` `OrderEvent` is inserted separately and after `save`, so the entity handed
   * back has no `events` relation at all — while TypeORM types `Order.events` as a non-optional
   * array, which makes `toAccountOrder(await place(...))` typecheck perfectly and answer with an
   * empty `timeline`: a brand-new order rendering a confirmation with no history.
   * `CheckoutController.reload` is what closes that, and the mapper throws rather than answering
   * without the relation. Not fixed by reloading here, because this return value is what Tasks 6, 7
   * and 8's suites and both concurrency proofs assert against.
   */
  async place(
    owner: CartOwner,
    dto: PlaceOrderDto,
    user: AuthenticatedUser | undefined,
  ): Promise<Order> {
    // Resolved once, outside the transaction: it is one read of the caller's own `businesses` row,
    // unrelated to what the transaction is about to lock, and doing it once here rather than inside
    // `assess` is what keeps a placement and a coupon preview using the identical lookup rather than
    // each growing its own.
    const viewer = await this.cartRead.viewerFor(user);
    return this.dataSource.transaction(async (manager) => {
      // Read through the transaction's manager, so the basket that is priced, decremented against and
      // emptied is one snapshot rather than three.
      const cart = await this.cart.find(owner, manager);
      const items = cart?.items ?? [];

      if (cart === null || items.length === 0) {
        throw new DomainError(
          ErrorCodes.CART_EMPTY,
          'Your basket is empty, so there is nothing to order.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      const pincode = await this.pincodes.resolve(dto.shipping.pincode);
      if (!pincode.isServiceable) {
        throw new DomainError(
          ErrorCodes.PINCODE_NOT_SERVICEABLE,
          `We do not deliver to ${dto.shipping.pincode} yet.`,
          HttpStatus.UNPROCESSABLE_ENTITY,
          { pincode: dto.shipping.pincode },
        );
      }

      const methods = await this.settings.payment();
      if (!(
        (dto.paymentMethod === 'cod' && methods.codEnabled) ||
        (dto.paymentMethod === 'online' && methods.onlinePaymentEnabled)
      )) {
        throw new DomainError(
          ErrorCodes.PAYMENT_METHOD_UNAVAILABLE,
          'This payment method is currently unavailable. Please choose another method.',
          HttpStatus.UNPROCESSABLE_ENTITY,
          { paymentMethod: dto.paymentMethod },
        );
      }

      const assessed = this.assess(items, viewer);

      this.refuseBrokenLines(assessed.map(({ verdict }) => verdict));

      const billed = assessed.map(({ item, line, verdict }) => this.bill(item, line, verdict));
      const subtotalPaise = sumPaise(billed.map((line) => line.lineTotalPaise));
      // Spec §8: per line, then summed. Never a percentage of the aggregate, because an invoice whose
      // tax does not equal the sum of its lines' tax cannot be reconciled. The order's figure is the
      // sum of the very rows it is about to store, so the two cannot drift.
      const gstPaise = sumPaise(billed.map((line) => line.gstAmountPaise));

      const channel = this.channelOf(items);

      const coupon = await this.honouredCoupon(dto, billed, subtotalPaise, channel, owner);
      /**
       * Clamped again here, with `shared`'s own `applyFlat` rather than a comparison written out.
       *
       * `CouponService` already caps a discount at the subtotal it was measured against, so this can
       * only bind if that changes — but `orders.total_paise` is a bigint with **no** check
       * constraint, so a discount larger than the basket would store a negative total and nothing
       * downstream would notice. The clamp is one call and the failure it prevents is unrecoverable.
       */
      const discountPaise = coupon === null ? 0n : applyFlat(subtotalPaise, coupon.discountPaise);

      const shippingPaise = await this.shippingFor(assessed, pincode.shippingPaise);
      const totalPaise = subtotalPaise - discountPaise + gstPaise + shippingPaise;

      const placedAt = new Date();
      // Allocated only now, after every refusal has had its chance. `nextval` is deliberately not
      // rolled back, so allocating earlier would burn a customer-visible reference on every rejected
      // attempt — see `order-number.ts`.
      const orderNumber = await nextOrderNumber(manager, placedAt);

      const draft: DeepPartial<Order> = {
        orderNumber,
        userId: owner.userId ?? null,
        // Left null deliberately. Linking an order to a `Business` row is Milestone 7's B2B work; the
        // company details this order was placed with are snapshotted on the order itself, which is
        // what an invoice needs and what `orders.seed.ts` records.
        businessId: null,
        channel,
        status: 'pending',
        paymentMethod:
          dto.paymentMethod === 'online' ? PaymentMethodEnum.ONLINE : PaymentMethodEnum.COD,
        paymentStatus: PaymentStatusEnum.PENDING,
        subtotalPaise,
        discountPaise,
        gstPaise,
        shippingPaise,
        totalPaise,
        couponCode: coupon?.couponCode ?? null,
        addressSnapshot: toSnapshot(dto.shipping),
        // Null means "the same as shipping", which is what `billingSameAsShipping` says. Copying the
        // shipping address into both would make the two indistinguishable from a customer who typed
        // the same address twice, and Task 21's address book needs to tell those apart.
        billingSnapshot:
          dto.billingSameAsShipping === false && dto.billing !== undefined
            ? toSnapshot(dto.billing)
            : null,
        companyName: dto.companyName ?? null,
        gstin: dto.gstin ?? null,
        poNumber: dto.poNumber ?? null,
        specialInstructions: dto.specialInstructions ?? null,
        placedAt,
        // Disagreement 3: four things claim to be the ETA and the pincode row is the only one that is
        // per-destination and admin-editable, so it is the one an order records.
        estimatedDelivery: new Date(placedAt.getTime() + pincode.etaDays * 24 * 60 * 60 * 1000),
        cancelledAt: null,
        cancelReason: null,
        items: billed.map((line) => this.toOrderItem(line)),
      };

      // `save`, not `insert`: `Order.items` carries `cascade: ['insert']`, so the lines are written
      // with the order in one statement pair rather than needing the id first.
      const order = await manager.getRepository(Order).save(draft);

      await this.decrementStock(manager, order, billed);

      if (coupon !== null) {
        await this.redeem(manager, {
          couponId: coupon.couponId,
          userId: owner.userId ?? null,
          orderId: order.id,
          discountPaise,
        });
      }

      await manager.getRepository(Payment).insert({
        orderId: order.id,
        method: dto.paymentMethod === 'online' ? PaymentMethodEnum.ONLINE : PaymentMethodEnum.COD,
        status: PaymentStatusEnum.PENDING,
        amountPaise: totalPaise,
        collectedAt: null,
        reference: null,
      });

      /**
       * The first event is inserted **directly, not through `OrderStatusService`** — and this is
       * deliberate, so nobody "fixes" the inconsistency later.
       *
       * `transition()` validates a move *from* a current status. Nothing transitions *to* `pending`:
       * it is the state an order is born in, and `nextStatuses(channel, x)` never returns it. Routing
       * this through the service would mean inventing a pseudo-status to come from, which would
       * corrupt the transition map for every other caller. Do **not** add a `created → pending` edge
       * to `shared` to make this symmetrical.
       *
       * `actorUserId` is null because `OrderEvent`'s own docblock says so — *"Null for a
       * system-generated event such as the initial `pending`"*. The timeline the customer reads is
       * these rows, and attributing the order's creation to them as an *actor* would put their name
       * against a step they did not perform.
       */
      await manager.getRepository(OrderEvent).insert({
        orderId: order.id,
        status: 'pending',
        // No note. `ORDER_STATUS_LABEL` already renders "Pending", and every seeded `pending` event
        // carries none — a note exists to say something the status does not.
        note: null,
        actorUserId: null,
      });

      /**
       * The basket is emptied **last, inside the transaction**.
       *
       * Emptying first loses it if placement then fails; emptying after the transaction commits loses
       * it if the process dies between the two. Both are recoverable for the business and infuriating
       * for the customer. The `carts` row itself stays, so the next basket reuses it rather than
       * racing `upsertCart` for the unique key.
       */
      await manager.getRepository(CartItem).delete({ cartId: cart.id });

      /**
       * Queued **last, inside the same transaction**, mirroring why the basket is emptied last:
       * a placement that fails after this point does not exist, so nothing should have been
       * queued for it either. `totalPaise` is converted with `toRupees` before it reaches the
       * payload, not left as a `bigint` — Postgres's driver can `JSON.stringify` a `jsonb` column
       * fine, but a raw `BigInt` inside that payload throws `TypeError: Do not know how to
       * serialize a BigInt` first, since `bigint` has no native JSON representation. This is the
       * one call site in this milestone with money in its payload; every other trigger's payload
       * carries only strings, ids, and plain small integers.
       */
      await this.notifications.queue(manager, {
        userId: order.userId,
        channel: NotificationChannel.EMAIL,
        template: dto.paymentMethod === 'online' ? 'order.awaiting-payment' : 'order.confirmed',
        payload: {
          orderNumber: order.orderNumber,
          email: dto.shipping.email,
          totalRupees: toRupees(order.totalPaise),
        },
      });

      return order;
    });
  }

  /**
   * The coupon's verdict against the caller's **own** basket, for `POST /checkout/coupon/preview`.
   *
   * Read-only, and read from the server's cart for the same reason `place` is: spec §13, *"Server
   * recomputes subtotal, GST, shipping, discount and total from the database; client-supplied money
   * is ignored entirely."* A preview that took the subtotal and the line categories from the request
   * would let a client claim a basket it does not have — satisfying `minOrderValuePaise` on a ₹0
   * order, or claiming the almond category to unlock a category-scoped coupon — and would answer
   * "₹500 off" about a basket placement is then going to price differently. The wire's `CartLine`
   * carries neither a price nor a `categoryId` (deliberately: prices are resolved live), so the
   * client could not supply those figures honestly even if it were trusted to.
   *
   * **No `refuseBrokenLines`.** A sold-out or quote-only line is the cart page's business to report;
   * refusing the preview over it would answer a question about the coupon with an error about the
   * basket, on the one screen where the customer is trying to fix the basket. The unpriceable lines
   * are dropped instead, which is exactly what `CartPricingService` does for the totals the customer
   * is looking at — so the "₹500 off" this reports is taken from the subtotal on their screen.
   *
   * The channel comes from **all** the items, refused ones included, because `channelOf`'s rule is
   * "any bulk line makes this a bulk order" and dropping a quote-required bulk line would flip a
   * business basket onto the retail ladder for the purpose of judging a coupon's `channel` column.
   *
   * An empty basket answers `COUPON_NOT_APPLICABLE` rather than `CART_EMPTY`, because
   * `eligibleSubtotal` reports null for a zero subtotal. The checkout page is only reachable with a
   * basket, so this is a client that is already off the rails; a refusal it can render is a better
   * answer than a branch here with nothing to test it.
   */
  async previewCoupon(
    owner: CartOwner,
    code: string,
    user: AuthenticatedUser | undefined,
  ): Promise<CouponPreview> {
    const cart = await this.cart.find(owner);
    const items = cart?.items ?? [];
    const viewer = await this.cartRead.viewerFor(user);
    const assessed = this.assess(items, viewer);

    // `code === undefined` is the whole priceability test, and it is sound rather than convenient:
    // every branch of `verdictFor` that sets a code also sets `lineTotal: null`, and every branch
    // that leaves a total sets no code — so this is exactly the set of lines `bill` can price.
    const billed = assessed
      .filter(({ verdict }) => verdict.code === undefined)
      .map(({ item, line, verdict }) => this.bill(item, line, verdict));

    return this.coupons.preview(
      code,
      this.couponBasket(
        billed,
        sumPaise(billed.map((line) => line.lineTotalPaise)),
        this.channelOf(items),
      ),
      owner.userId ?? null,
    );
  }

  /**
   * Every stored line paired with the verdict the cart page's own gates give it.
   *
   * Paired with its row in one pass. Two same-length arrays joined on a subscript afterwards is a
   * silent misalignment waiting for the first `filter` anyone adds — and `previewCoupon` adds
   * exactly that filter — where a misaligned pair would snapshot one product's name against
   * another's price.
   *
   * `viewer` is resolved once by the caller (`place`, `previewCoupon`) and passed in rather than
   * resolved here per line — the same reason `CartReadService.evaluate` takes already-built
   * `ValidatableLine`s rather than resolving its own viewer, and the reason both of this file's
   * callers use `this.cartRead.viewerFor` rather than each growing an independent lookup: two
   * independently-resolved answers to "who is buying" is exactly how a placement's stored line
   * total could disagree with the coupon preview the same customer saw a moment before.
   */
  private assess(
    items: readonly CartItem[],
    viewer: PricingViewer | null,
  ): { item: CartItem; line: ValidatableLine; verdict: CartValidationLine }[] {
    return items.map((item) => {
      const line = this.cartRead.toValidatable(item, viewer);
      return { item, line, verdict: verdictFor(line) };
    });
  }

  /**
   * A basket with any bulk line is a bulk order: `CheckoutForm` puts exactly that basket on the
   * business track, and `Order.channel` decides which transition ladder the order is judged against
   * for the rest of its life.
   */
  private channelOf(items: readonly CartItem[]): OrderChannelEnum {
    return items.some((item) => item.mode === OrderChannelEnum.BULK)
      ? OrderChannelEnum.BULK
      : OrderChannelEnum.RETAIL;
  }

  /**
   * The basket as a coupon rule reads it — the two things `CouponService` needs and nothing else.
   *
   * Shared by the preview endpoint and by placement rather than written out at both, because the
   * two must measure one basket the same way: a category id read from a different place, or a
   * subtotal summed over a different set of lines, is how "the code worked when I applied it" and
   * "the code was not honoured on my order" come to both be true.
   */
  private couponBasket(
    billed: readonly BilledLine[],
    subtotalPaise: Paise,
    channel: OrderChannelEnum,
  ): CouponBasket {
    return {
      channel: channel === OrderChannelEnum.BULK ? 'bulk' : 'retail',
      lines: billed.map((line) => ({
        categoryId: line.item.product.categoryId,
        lineTotalPaise: line.lineTotalPaise,
      })),
      subtotalPaise,
    };
  }

  /**
   * Refuses the whole placement when any line's verdict has a code, before anything is written.
   *
   * Every offending line is reported, not just the first: the checkout page annotates a basket it is
   * showing, and naming one bad line while hiding the state of the others is what makes a customer fix
   * them one round trip at a time. The **status** and the reported `code` come from the decisive line,
   * and stock wins when several codes are present — the same precedence `verdictFor` applies within a
   * single line, and for the same reason: "remove this, there is none left" is actionable where
   * "raise the quantity" is not.
   *
   * 409 for stock and 422 for everything else. The basket was legal when it was assembled, so a stock
   * refusal is a conflict the caller can sensibly retry after changing the quantity; a quote-only or
   * withdrawn product is not.
   */
  private refuseBrokenLines(verdicts: readonly CartValidationLine[]): void {
    const offending = verdicts.filter((verdict): verdict is Refusal => verdict.code !== undefined);
    const [first] = offending;
    if (first === undefined) return;

    const decisive = offending.find((verdict) => verdict.code === 'OUT_OF_STOCK') ?? first;
    const named = offending.map((verdict) => verdict.slug).join(', ');

    throw new DomainError(
      // Keyed straight off the verdict code. `cart-read.service.ts` carries a compile-time proof that
      // every `CartValidationCode` is a real `ErrorCode`, so this lookup cannot miss and a second
      // hand-written map here would be the thing that drifts.
      ErrorCodes[decisive.code],
      `Your basket has changed since it was priced: ${named}. Review it and place the order again.`,
      decisive.code === 'OUT_OF_STOCK' ? HttpStatus.CONFLICT : HttpStatus.UNPROCESSABLE_ENTITY,
      { lines: offending },
    );
  }

  /**
   * One line's money, in paise, from the verdict that already priced it.
   *
   * The line total is **not** recomputed: `verdictFor` decided whether the line is billable and for how
   * much, and a second derivation here would be a second answer that drifts the first time a pricing
   * rule changes. The rupee round trip is exact for every total reachable through `CartLineDto`'s own
   * bounds — measured in `toPricedLine`'s docblock — so nothing is lost between the figure the customer
   * was shown and the figure that is billed.
   *
   * `unitPricePaise` is the one figure a verdict does not carry, and it is read from the source that
   * priced the line rather than divided back out of the total: for a retail line the variant's own
   * price, for a bulk line the per-kg rate of the tier the weight landed in, via the same `bulkTierFor`
   * the verdict used. Division would lose paise whenever the total is not divisible — 8,499 paise
   * across 10 units of 0.01kg comes back 9 paise short — and the rate is what a GST invoice prints.
   */
  private bill(item: CartItem, line: ValidatableLine, verdict: CartValidationLine): BilledLine {
    // Unreachable: `refuseBrokenLines` has already thrown for any line without a total. Loud rather
    // than a zero-priced line, which would be an order for goods nobody was charged for.
    if (verdict.lineTotal === null || line.product === null) {
      throw new Error(`Line ${verdict.id} cleared validation without a price`);
    }

    const lineTotalPaise = toPaise(verdict.lineTotal);
    const unitPricePaise =
      item.mode === OrderChannelEnum.BULK
        ? this.perKgPaise(line, item)
        : this.variantPricePaise(item);

    return {
      item,
      line,
      unitPricePaise,
      lineTotalPaise,
      gstAmountPaise: gstOn(lineTotalPaise, line.product.gstRate),
    };
  }

  private variantPricePaise(item: CartItem): Paise {
    // A retail line with no variant is a `NOT_FOUND` verdict, so this cannot fire after the gate.
    if (item.variant === null) throw new Error(`Retail line ${item.id} has no variant`);
    return item.variant.pricePaise;
  }

  private perKgPaise(line: ValidatableLine, item: CartItem): Paise {
    const tier =
      line.product === null ? null : bulkTierFor(line.product.bulkTiers, Number(item.kg ?? 0));
    // A bulk line in no tier, or in an unpriced one, is a `QUOTE_REQUIRED` verdict.
    if (tier?.pricePerKgPaise === undefined || tier.pricePerKgPaise === null) {
      throw new Error(`Bulk line ${item.id} was priced without a tier`);
    }
    return tier.pricePerKgPaise;
  }

  /**
   * The line as `order_items` stores it — every snapshot column filled.
   *
   * `product_id` and `variant_id` are both `ON DELETE SET NULL`, so this row is designed to outlive the
   * catalogue rows it points at. An invoice has to reprint years later after the product has been
   * renamed and repriced, which is why `name`, `hsn`, `detail`, `unitPricePaise` and `gstRate` are
   * copies rather than joins. A snapshot left null is an invoice that cannot be reissued — `hsn`
   * especially, which a compliant Indian GST invoice requires and which nothing else can regenerate.
   */
  private toOrderItem(billed: BilledLine): DeepPartial<OrderItem> {
    const { item } = billed;
    const bulk = item.mode === OrderChannelEnum.BULK;

    return {
      productId: item.productId,
      variantId: item.variantId,
      productSlug: item.product.slug,
      name: item.product.name,
      hsn: item.product.hsn,
      // `${Number(kg)} kg` and not the raw column: `kg` is `numeric(8,2)`, so `pg` hands back
      // `'25.00'` and the detail would read "25.00 kg" where the cart page, the mock and the seeder
      // all say "25 kg".
      detail: bulk ? `${Number(item.kg ?? 0)} kg` : (item.variant?.size ?? ''),
      size: bulk ? null : (item.variant?.size ?? null),
      grams: bulk ? null : (item.variant?.grams ?? null),
      kg: bulk ? item.kg : null,
      qty: item.qty,
      unitPricePaise: billed.unitPricePaise,
      lineTotalPaise: billed.lineTotalPaise,
      // The product's own `numeric(5,2)` string, copied verbatim rather than reformatted, so the rate
      // on the invoice is character-for-character the rate the catalogue held.
      gstRate: item.product.gstRate,
      gstAmountPaise: billed.gstAmountPaise,
    };
  }

  /**
   * Disagreement 4, settled: the order's shipping is the `serviceable_pincodes` row, because it is the
   * only one of the four candidate figures that is per-destination and admin-editable.
   *
   * **The free-shipping threshold still applies**, and that is a departure from the plan's money table,
   * which names only the pincode row. `GET /cart` reports `shipping: 0` once the subtotal clears
   * `freeShippingThreshold`, and the checkout summary prints "Free" from that figure — so charging the
   * row regardless would bill a customer for delivery they had just been shown as free, on a basket
   * every seeded order of the same size records as free. The decision is delegated to
   * `CartPricingService`, which owns it for the cart page, rather than restated here as a fifth copy of
   * the rule.
   *
   * There is no fallback to the `flatShippingRate` setting, and that is not an omission: `resolve`
   * answers `matchedPrefix: null` only together with `isServiceable: false`, which placement has
   * already refused. A "no prefix matched" branch here would be unreachable code pretending to be a
   * policy.
   */
  private async shippingFor(
    assessed: readonly { line: ValidatableLine; verdict: CartValidationLine }[],
    perDestinationPaise: Paise,
  ): Promise<Paise> {
    const totals = this.pricing.totals(
      assessed.map(({ line, verdict }) => toPricedLine(line, verdict)),
      await this.cartRead.shippingSettings(),
    );
    return totals.shipping === 0 ? 0n : perDestinationPaise;
  }

  /**
   * The coupon's verdict, or null when there is no code or the code was refused.
   *
   * A refused coupon does **not** fail the order. The customer typed a code that turned out not to
   * apply; throwing away a placed order over it would be a worse outcome than the discount they did not
   * get, and `POST /checkout/coupon/preview` exists so the form learns about the refusal before this
   * point. What the order records is the coupon it actually honoured.
   */
  private async honouredCoupon(
    dto: PlaceOrderDto,
    billed: readonly BilledLine[],
    subtotalPaise: Paise,
    channel: OrderChannelEnum,
    owner: CartOwner,
  ): Promise<CouponAccepted | null> {
    if (dto.couponCode === undefined || dto.couponCode.trim() === '') return null;

    const preview = await this.coupons.preview(
      dto.couponCode,
      this.couponBasket(billed, subtotalPaise, channel),
      owner.userId ?? null,
    );

    return preview.eligible ? preview : null;
  }

  /**
   * Stock down and the ledger row that explains it, per line, in ascending `variantId`.
   *
   * **Ascending, not insertion order.** Two transactions touching the same two variants in opposite
   * orders is the textbook deadlock, and a placement racing a cancellation is exactly that pair —
   * `OrderStatusService` sorts its restores the same way, so whichever gets the first variant also gets
   * the second and one waits instead of both dying. A unit double cannot see a deadlock; what it can
   * see is the sequence of statements, which is what the spec pins.
   *
   * A **bulk line has no variant** and therefore no `inventory` row to decrement — it is priced per kg
   * off a tier ladder, and `verdictFor` reports its `availableQty` as null for the same reason. Those
   * lines are skipped rather than refused. A raw `UPDATE … WHERE variant_id = NULL` matches nothing
   * anyway, which would turn every bulk order into a 409 about stock that was never tracked.
   */
  private async decrementStock(
    manager: EntityManager,
    order: Order,
    billed: readonly BilledLine[],
  ): Promise<void> {
    const decrementable = billed
      .filter(
        (line): line is BilledLine & { item: CartItem & { variantId: string } } =>
          line.item.variantId !== null && line.item.mode !== OrderChannelEnum.BULK,
      )
      .sort((a, b) => a.item.variantId.localeCompare(b.item.variantId));

    for (const line of decrementable) {
      await this.sell(manager, {
        orderId: order.id,
        orderNumber: order.orderNumber,
        variantId: line.item.variantId,
        qty: line.item.qty,
      });
    }
  }

  /**
   * One line's stock off the shelf, plus its `SALE` row.
   *
   * The conditional `UPDATE … RETURNING` shape `OrderStatusService.putStockBack` already uses, and
   * deliberately not `InventoryService.adjust`'s update-then-read: `balanceAfter` is then the value the
   * writing statement actually wrote rather than one read back afterwards, which is the entire point of
   * the ledger row. One round trip, and no window between the two in which a concurrent write can land.
   * `updatedAt` is set by hand because raw SQL bypasses `@UpdateDateColumn`.
   *
   * `onHand - qty >= reserved` is evaluated *inside* the writing statement, so there is no
   * read-then-write gap for two customers racing for the last bag: under `READ COMMITTED` the second
   * `UPDATE` blocks on the first, re-evaluates its own predicate against the committed row, and matches
   * nothing. Zero rows is therefore a real refusal — spec §10.2 — and it fails the whole placement
   * rather than writing a `SALE` row for stock that never moved, which is precisely how
   * `SUM(delta) == onHand` drifts. That the two statements genuinely serialise needs two connections,
   * and `test/integration/checkout-concurrency.integration.spec.ts` proves it.
   *
   * **The data-modifying CTE is load-bearing, not decoration — do not unwrap it.** TypeORM's Postgres
   * driver special-cases the two commands that report an affected count: for `UPDATE` and `DELETE`,
   * `query()` answers `[rows, rowCount]` rather than `rows` (`PostgresQueryRunner.query`, the
   * `switch (raw.command)`). So a bare `UPDATE … RETURNING` made `rows[0]` the *rows array*,
   * `rows[0]?.onHand` `undefined`, and **every successful decrement threw `OUT_OF_STOCK`** — no COD
   * order with a retail line could be placed at all. The unit doubles could not see it: they answer
   * `[{ onHand }]`, which is the shape a `SELECT` returns and the shape this now really gets.
   * Wrapping the write in a CTE makes the statement's command `SELECT` while leaving it **one
   * statement** whose predicate is still evaluated inside the write, so the safety property is
   * untouched and the driver quirk is gone rather than encoded in a tuple type.
   */
  private async sell(
    manager: EntityManager,
    input: { orderId: string; orderNumber: string; variantId: string; qty: number },
  ): Promise<void> {
    const rows = await manager.query<{ onHand: number; lowStockThreshold: number }[]>(
      `WITH sold AS (
         UPDATE "inventory"
            SET "onHand" = "onHand" - $1, "updatedAt" = now()
          WHERE "variant_id" = $2
            AND "onHand" - $1 >= "reserved"
        RETURNING "onHand", "lowStockThreshold"
       )
       SELECT "onHand", "lowStockThreshold" FROM sold`,
      [input.qty, input.variantId],
    );

    const onHand = rows[0]?.onHand;
    const lowStockThreshold = rows[0]?.lowStockThreshold;

    if (onHand === undefined) {
      throw new DomainError(
        ErrorCodes.OUT_OF_STOCK,
        'One of your items sold out while you were checking out. Review your basket and try again.',
        HttpStatus.CONFLICT,
        { variantId: input.variantId, qty: input.qty },
      );
    }

    await manager.getRepository(InventoryTransaction).insert({
      variantId: input.variantId,
      // Negative, because the ledger is signed and `SUM(delta)` has to equal `onHand`. A `SALE` row
      // with a positive delta would keep the sign of the movement in the `type` column only, where no
      // sum can read it.
      delta: -input.qty,
      type: InventoryTransactionType.SALE,
      reason: `Order ${input.orderNumber}`,
      orderId: input.orderId,
      // A customer buying is not an actor in the admin sense, and the order already records who
      // placed it. Same convention as the first `OrderEvent`.
      actorUserId: null,
      balanceAfter: Number(onHand),
    });

    await checkLowStock(manager, this.notifications, {
      variantId: input.variantId,
      delta: -input.qty,
      onHand: Number(onHand),
      lowStockThreshold: Number(lowStockThreshold),
    });
  }

  /**
   * The redemption row, written under `SELECT … FOR UPDATE` on the coupon.
   *
   * Every rule that has to count something — both usage limits **and** `firstOrderOnly` — is
   * re-evaluated *after* the lock, and that is the whole point: `CouponService.preview` runs on its own
   * connection outside this transaction, so each of its counts is advisory by the time the order is
   * being written. Counting and then inserting is a read-then-write race two concurrent checkouts
   * can both win — the last use of a 100-use coupon becoming the 101st and 102nd — and holding the
   * coupon row is what makes the second wait for the first's committed count.
   *
   * 409 rather than 422: the coupon was genuinely valid when the customer applied it, so "someone else
   * took the last one" is a conflict, and retrying without the code is the sensible next request.
   *
   * `uq_coupon_redemptions_coupon_order` is the backstop underneath all of this, so a retried checkout
   * cannot double-count one order's use. **That two connections actually serialise here is Task 8's to
   * prove.**
   */
  private async redeem(
    manager: EntityManager,
    input: {
      couponId: string;
      userId: string | null;
      orderId: string;
      discountPaise: Paise;
    },
  ): Promise<void> {
    const rows = await manager.query<
      { usageLimit: number | null; usageLimitPerUser: number | null; firstOrderOnly: boolean }[]
    >(
      `SELECT "usageLimit", "usageLimitPerUser", "firstOrderOnly"
         FROM "coupons" WHERE "id" = $1 FOR UPDATE`,
      [input.couponId],
    );

    const limits = rows[0];
    if (limits === undefined) {
      // The row went away between the preview and the lock. `CouponRedemption.coupon` is `RESTRICT`,
      // so inserting against it would fail on the constraint anyway — this is the same refusal with a
      // code the client can read.
      throw new DomainError(
        ErrorCodes.COUPON_INVALID,
        'That coupon is no longer available.',
        HttpStatus.CONFLICT,
        { couponId: input.couponId },
      );
    }

    const redemptions = manager.getRepository(CouponRedemption);

    /**
     * `firstOrderOnly`, re-checked here **excluding the order this placement has already saved.**
     *
     * The column was validated only by `CouponService.preview`, on another connection and before this
     * transaction opened, so its answer is advisory by now for exactly the reason the two usage limits'
     * answers are. The hole that left was worse than theirs, because nothing downstream closed it: a
     * coupon carrying `firstOrderOnly` and **no** `usageLimitPerUser` could be redeemed twice by one
     * customer from a double-click — both previews found no prior order, and the column was never read
     * again. `WELCOME10` escapes that only by also carrying `usageLimitPerUser: 1`, which is why
     * `coupons.seed.ts` no longer describes that column as redundant.
     *
     * **`Not(input.orderId)` is the whole fix, not a defensive extra.** `redeem` is called from `place`
     * *after* the order row is saved, so the customer's own in-flight order is already visible to this
     * count; counting it would refuse every legitimate first-order redemption there has ever been.
     *
     * Every other semantic is `preview`'s, and its docblock is the reason for each: **orders, not
     * redemptions**, because a first order that used no coupon was still a first order; **no status
     * filter**, because excluding cancellations makes place-then-cancel restore the eligibility; and
     * **skipped for a guest**, who has no order history to count and is a first-order customer by
     * definition. Widening any of the three here would make the preview and the redemption disagree
     * about one basket.
     *
     * That two connections genuinely serialise on this is what makes the count binding: the second
     * placement blocks on the coupon row until the first commits, so the first's order is committed and
     * visible by the time the second counts. `checkout-concurrency.integration.spec.ts` proves it.
     *
     * `COUPON_FIRST_ORDER_ONLY` and **not** `refuseCoupon`: `domain-error.ts` keeps this code separate
     * precisely because `COUPON_LIMIT_REACHED` would tell a returning customer to wait for a limit that
     * is never going to reset. 409 like its neighbours — the coupon was valid when they applied it.
     */
    if (limits.firstOrderOnly && input.userId !== null) {
      const earlierOrders = await manager.getRepository(Order).count({
        where: { userId: input.userId, id: Not(input.orderId) },
      });
      if (earlierOrders > 0) {
        throw new DomainError(
          ErrorCodes.COUPON_FIRST_ORDER_ONLY,
          'That coupon is for a first order only, and another of your orders has just been placed. Remove it and place the order again.',
          HttpStatus.CONFLICT,
          { couponId: input.couponId },
        );
      }
    }

    if (limits.usageLimit !== null) {
      const used = await redemptions.count({ where: { couponId: input.couponId } });
      if (used >= limits.usageLimit) this.refuseCoupon(input.couponId);
    }

    if (limits.usageLimitPerUser !== null && input.userId !== null) {
      const usedByUser = await redemptions.count({
        where: { couponId: input.couponId, userId: input.userId },
      });
      if (usedByUser >= limits.usageLimitPerUser) this.refuseCoupon(input.couponId);
    }

    await redemptions.insert({
      couponId: input.couponId,
      userId: input.userId,
      orderId: input.orderId,
      discountPaise: input.discountPaise,
    });
  }

  private refuseCoupon(couponId: string): never {
    throw new DomainError(
      ErrorCodes.COUPON_LIMIT_REACHED,
      'That coupon has just been fully redeemed. Remove it and place the order again.',
      HttpStatus.CONFLICT,
      { couponId },
    );
  }
}
