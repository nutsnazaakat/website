import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Category } from '../../entities/catalog/category.entity';
import { Inventory } from '../../entities/catalog/inventory.entity';
import { Business } from '../../entities/identity/business.entity';
import { Product } from '../../entities/catalog/product.entity';
import { ProductVariant } from '../../entities/catalog/product-variant.entity';
import { AdminModule } from '../admin/admin.module';
import { AdminCategoriesController } from './admin-categories.controller';
import { AdminCategoriesService } from './admin-categories.service';
import { AdminProductsController } from './admin-products.controller';
import { AdminProductsService } from './admin-products.service';
import { AdminVariantsController } from './admin-variants.controller';
import { AdminVariantsService } from './admin-variants.service';
import { CatalogController } from './catalog.controller';
import { CatalogFacetsService } from './catalog.facets.service';
import { CatalogService } from './catalog.service';
import { COMBO_COMPOSITIONS } from './combo-composition';
import { COMBO_COMPOSITION_SOURCE, CombosService } from './combos.service';

/**
 * The catalogue read stack.
 *
 * `forFeature` lists the entities a provider here injects a repository for. For `CatalogService`
 * that is `Product`, `Category` and `Business` alone — the variants, images, inventory rows and
 * pricing tiers every storefront response carries arrive through its joins off `Product`.
 * `ProductVariant` and `Inventory` were added by the admin write paths (Milestone 9), which reach
 * both directly.
 *
 * `CatalogFacetsService`'s route is declared above `products/:slug` — see the comment in
 * `catalog.controller.ts`.
 *
 * The combo composition arrives as a value provider rather than being imported by `CombosService`
 * directly, so its spec can inject its own fixtures instead of the real six.
 * `WinstonLoggerService` needs no entry here: `LoggingModule` is `@Global()` and exports it. Do not
 * provide the `WINSTON_LOGGER` symbol here either — `LoggingModule` provides it without exporting
 * it.
 *
 * `Business` is registered so `CatalogService.viewerFor` can read a signed-in customer's segment —
 * a repository import, not a provider concern: `resolveTiers` (Milestone 7, Task 2) is a plain
 * function `CatalogService`'s mapper call imports directly and needs nothing from the container.
 * `BusinessesModule` is not imported here for the same reason `CartModule`'s wiring bug (Milestone
 * 7's plan, Task 3) is worth reading before assuming: that bug was `CartModule` exporting one of
 * three providers it should have, a mismatch between a module's `providers` and its `exports`. This
 * is the opposite kind of dependency — a repository, obtained by listing the entity in
 * `forFeature`, not a service obtained through another module's `exports`.
 *
 * **The admin controllers live here rather than in `AdminModule`, and that is plan 9.1's stated
 * architecture rather than convenience:** "existing modules that gain admin routes get a second
 * controller alongside their public one rather than mixing scopes in one class." `AdminModule` is
 * for the admin-only surface with no customer-facing counterpart — the dashboard — while products,
 * variants and categories are this module's aggregates, and moving them would put their write paths
 * a module away from the read paths they must agree with (`toAdminProduct` delegates to
 * `toWireProduct` precisely so `soldOut` has one derivation).
 *
 * `AdminModule` is imported for `AuditLogService`, which it exports for exactly this reason: almost
 * none of its callers live there. The variant write path creates the `Inventory` row in the same
 * transaction, which is what keeps a new variant visible to the sold-out logic.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Product, ProductVariant, Category, Inventory, Business]),
    AdminModule,
  ],
  controllers: [
    CatalogController,
    AdminProductsController,
    AdminVariantsController,
    AdminCategoriesController,
  ],
  providers: [
    CatalogService,
    CatalogFacetsService,
    CombosService,
    AdminProductsService,
    AdminVariantsService,
    AdminCategoriesService,
    { provide: COMBO_COMPOSITION_SOURCE, useValue: COMBO_COMPOSITIONS },
  ],
  exports: [CatalogService],
})
export class CatalogModule {}
