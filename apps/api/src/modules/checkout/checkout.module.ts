import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CouponRedemption } from '../../entities/commerce/coupon-redemption.entity';
import { Coupon } from '../../entities/commerce/coupon.entity';
import { Order } from '../../entities/commerce/order.entity';
import { ServiceablePincode } from '../../entities/commerce/serviceable-pincode.entity';
import { IdempotencyKey } from '../../entities/ops/idempotency-key.entity';
import { CartModule } from '../cart/cart.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../settings/settings.module';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { CouponService } from './coupon.service';
import { PincodeService } from './pincode.service';

/**
 * The first module to put any of the checkout services behind a URL.
 *
 * **`CartModule` is imported, not partially re-provided.** `CheckoutService` injects `CartService`,
 * `CartReadService` and `CartPricingService`; `CartModule` exported only the first until this task
 * added the other two, so importing it used to resolve one of three and Nest refused to start on the
 * rest. Re-providing the two here would also resolve — by creating a **second instance** of each,
 * which is the wrong fix and the kind that reads as correct for years. (Task 7's probe module does
 * re-provide them, deliberately, because a test module must not mutate a production one to work.
 * That is not a precedent for production wiring.)
 *
 * **There is no `OrdersModule` to import.** It is created in Task 17, and it is unnecessary here:
 * `order.mapper.ts` follows `cart-line.mapper.ts` and exports **plain functions**, so
 * `toAccountOrder` is an import rather than a provider.
 *
 * `forFeature` lists exactly what is injected and nothing more:
 *
 * | Entity | Injected by |
 * | --- | --- |
 * | `Coupon`, `CouponRedemption`, `Order` | `CouponService` |
 * | `ServiceablePincode` | `PincodeService` |
 * | `Order` | `CheckoutController`, to reload a placed order with its relations |
 * | `IdempotencyKey` | `CheckoutIdempotencyInterceptor` |
 *
 * `CheckoutService` injects no repository at all — it takes the `DataSource` and does everything
 * through one transaction's `EntityManager`.
 *
 * **`CheckoutIdempotencyInterceptor` is deliberately not in `providers`, and not imported here at
 * all.** Nest registers any class
 * named by `@UseInterceptors()` as an *injectable* of the module hosting the controller — that is
 * what `IdempotencyKey` is in the `forFeature` list for — and listing it in `providers` as well would
 * put it in both collections and build it twice. Measured, because the alternative reading is
 * frightening enough to invite the belt-and-braces version: with the class in neither `providers` nor
 * anywhere else, removing `IdempotencyKey` from `forFeature` still fails at compile with *"Nest can't
 * resolve dependencies of the CheckoutIdempotencyInterceptor (?) … IdempotencyKeyRepository at index
 * [0]"*. So the boot-time check is real either way, and it matters: an enhancer whose dependencies
 * cannot be resolved is otherwise dropped from the route by
 * `InterceptorsContextCreator.getInterceptorInstance` returning null and `createConcreteContext`
 * filtering it out — **silently**, leaving placement non-idempotent with the route's decorator still
 * in place for a metadata test to find. `checkout.module.spec.ts` compiles this module for exactly
 * that reason.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Coupon, CouponRedemption, Order, ServiceablePincode, IdempotencyKey]),
    CartModule,
    SettingsModule,
    NotificationsModule,
  ],
  controllers: [CheckoutController],
  providers: [CheckoutService, CouponService, PincodeService],
})
export class CheckoutModule {}
