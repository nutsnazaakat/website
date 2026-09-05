import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Cart } from '../../entities/commerce/cart.entity';
import { CartItem } from '../../entities/commerce/cart-item.entity';
import { Business } from '../../entities/identity/business.entity';
import { Product } from '../../entities/catalog/product.entity';
import { ProductVariant } from '../../entities/catalog/product-variant.entity';
import { Setting } from '../../entities/ops/setting.entity';
import { CartController } from './cart.controller';
import { CartPricingService } from './cart-pricing.service';
import { CartReadService } from './cart-read.service';
import { CartService } from './cart.service';

/**
 * All three services are exported, for two unrelated reasons.
 *
 * `CartService` is exported because `AuthModule` folds a guest basket into the new session during
 * login and registration.
 *
 * `CartReadService` and `CartPricingService` are exported because `CheckoutModule` imports this
 * module and `CheckoutService`'s constructor takes all three: placement re-applies the cart page's
 * own gates from the same `verdictFor`, and delegates the free-shipping decision to the service that
 * owns it for the cart page rather than restating the rule. Exporting only `CartService` resolved
 * one of the three and made Nest refuse to start on the other two. **Not** re-provided inside
 * `CheckoutModule`, which would resolve by creating a second instance of each.
 *
 * `Business` is registered so `CartReadService.viewerFor` can read a signed-in customer's segment —
 * a repository import, not a provider concern, matching `CatalogModule`'s identical addition
 * (Milestone 7, Task 3) and for the identical reason: `resolveTiers`/`resolveTiersForWeight`
 * (Tasks 2 and 4) are plain functions the service imports directly and need nothing from the
 * container. This is not the export mismatch this module already carries a docblock about above —
 * that bug was a module exporting fewer providers than a consumer's constructor needed; this is a
 * repository obtained by listing an entity in `forFeature`, the opposite shape of dependency.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Cart, CartItem, Product, ProductVariant, Setting, Business])],
  controllers: [CartController],
  providers: [CartService, CartReadService, CartPricingService],
  exports: [CartService, CartReadService, CartPricingService],
})
export class CartModule {}
