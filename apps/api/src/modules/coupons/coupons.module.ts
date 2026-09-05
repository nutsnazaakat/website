import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { AdminCouponsController } from './admin-coupons.controller';
import { AdminCouponsService } from './admin-coupons.service';

/**
 * The coupon **administration** surface — spec §6.4's `/admin/coupons` block, brief §36.
 *
 * **A module of its own rather than a second controller inside `CheckoutModule`**, which is where
 * `CouponService` lives. The convention this codebase follows is that a module gaining admin routes
 * keeps its own second controller — but `CheckoutModule` does not own coupons, it *consumes* them:
 * `CouponService.preview` is one step of placing an order, and `CheckoutModule`'s own docblock
 * describes its `forFeature` as "exactly what is injected and nothing more" for the checkout flow.
 * Managing campaigns is not part of that flow, and `checkout.module.spec.ts` compiles that graph
 * deliberately, so widening it with an unrelated admin surface would put checkout's tested wiring in
 * the blast radius of every future coupon change.
 *
 * No `TypeOrmModule.forFeature`: `AdminCouponsService` injects the `DataSource` and reaches every
 * repository through one transaction's `EntityManager`, the pattern `AdminCategoriesService` and
 * `SupportTicketsService` both use. So `Coupon` being registered in `CheckoutModule` as well is not
 * a duplicate registration — nothing here asks for a repository token at all.
 *
 * `AdminModule` is imported for `AuditLogService`, which is exported from there precisely because
 * almost none of its callers live in it.
 */
@Module({
  imports: [AdminModule],
  controllers: [AdminCouponsController],
  providers: [AdminCouponsService],
})
export class CouponsModule {}
