import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { AdminPricingTiersController } from './admin-pricing-tiers.controller';
import { AdminPricingTiersService } from './admin-pricing-tiers.service';

/**
 * Brief §31's B2B pricing admin — spec §6.4's `/admin/pricing-tiers` block.
 *
 * **This directory had no module until plan 9.3, and `pricing.resolver.ts` still does not need
 * one.** That file is a pair of plain functions — `resolveTiers`, `resolveTiersForWeight` — which
 * `CatalogService`, `CartReadService` and `product.mapper.ts` import directly. They hold no state
 * and take no connection, so there is nothing for the container to build; turning them into a
 * provider to keep the new controller company would change four call sites for no gain, and would
 * make a pure function that can be unit-tested against a ladder shape into something that has to be
 * resolved from a module. `orders/order-number.ts` and `mappers/order.mapper.ts` sit in exactly the
 * same relationship to `OrdersModule`.
 *
 * No `TypeOrmModule.forFeature`: `AdminPricingTiersService` takes the `DataSource` and reaches
 * `PricingTier`, `Product` and `Business` through one transaction's `EntityManager`, the same
 * arrangement `RfqsService` and `CheckoutService` use. `DataSource` is a globally-provided token
 * from the root `TypeOrmModule.forRootAsync`, so nothing here needs to ask for it either.
 *
 * **`AdminModule`, for `AuditLogService`** — every write here records a row inside its own
 * transaction. There is no cycle: `AdminModule` imports nothing at all, which is precisely what
 * makes it importable from every module that grows an admin write.
 *
 * Nothing is exported. Nothing outside this module has any business writing a price band, and the
 * day something does it should import this module rather than the provider being available by
 * default — `AdminModule` states the same rule for `DashboardService`.
 */
@Module({
  imports: [AdminModule],
  controllers: [AdminPricingTiersController],
  providers: [AdminPricingTiersService],
})
export class PricingModule {}
