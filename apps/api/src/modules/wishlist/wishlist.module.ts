import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from '../../entities/catalog/product.entity';
import { WishlistItem } from '../../entities/commerce/wishlist-item.entity';
import { CatalogModule } from '../catalog/catalog.module';
import { WishlistController } from './wishlist.controller';
import { WishlistService } from './wishlist.service';

/**
 * `CatalogModule` is imported for its exported `CatalogService`: `list()` prices the saved products
 * through the same mapper the shop uses, so the wishlist page can render the identical `ProductCard`
 * — SOLD OUT state and all — rather than a second, drifting projection of a product.
 *
 * `forFeature` lists `Product` as well as `WishlistItem` because both mutations resolve a slug to an
 * id before touching the join table. Nothing here injects a `User` repository — the FK is set from
 * the session's id, never looked up.
 *
 * `WishlistService` is exported because `AuthModule` folds a guest's saved items into the new session
 * during login and registration, beside the cart's merge and against the same guest key.
 */
@Module({
  imports: [TypeOrmModule.forFeature([WishlistItem, Product]), CatalogModule],
  controllers: [WishlistController],
  providers: [WishlistService],
  exports: [WishlistService],
})
export class WishlistModule {}
