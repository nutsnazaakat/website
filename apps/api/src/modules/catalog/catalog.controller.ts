import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  CatalogFacets,
  Category,
  Combo,
  Paginated,
  Product,
  QuotePreviewResponse,
} from '@nutwala/shared';
import { OptionalUser } from '../../common/auth/decorators/current-user.decorator';
import { Public } from '../../common/auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { CatalogFacetsService } from './catalog.facets.service';
import { CatalogService } from './catalog.service';
import { CombosService } from './combos.service';
import { ProductQueryDto } from './dto/product-query.dto';
import { QuotePreviewDto } from './dto/quote-preview.dto';

/**
 * Every route here is `@Public()`. `JwtAuthGuard` is global, so without it the shop would 401 for
 * anyone not signed in — which is most visitors.
 *
 * `CsrfGuard` is also global but exempts safe methods, so these GETs need no CSRF token.
 *
 * **Declaration order is routing order.** Nest registers handlers in the order the class declares
 * them and Express matches the first that fits, so any literal path under `products/` must be
 * declared *above* `products/:slug` or the slug pattern swallows it — `GET products/bestsellers`
 * would reach `getProduct('bestsellers')` and answer 404 for a product nobody named. There is no
 * decorator for this; the order below is the whole mechanism, and
 * `catalog.controller.spec.ts` fails if it is disturbed.
 *
 * `@Public()` and `@OptionalUser()` together are why a signed-in business gets their own prices on
 * a route a guest can also read. `JwtAuthGuard` runs passport on a `@Public()` route and swallows a
 * failure, so `request.user` is populated for a valid session and absent otherwise; `@CurrentUser()`
 * would throw for every guest instead — measured as a 500 on every anonymous request when it
 * happened on the wishlist. `@OptionalUser()` is how the routes below read the difference without
 * either caller being turned away, the same arrangement the cart and checkout use.
 */
@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly facets: CatalogFacetsService,
    private readonly combos: CombosService,
  ) {}

  @Public()
  @Get('products')
  @ApiOperation({ summary: 'List published products with filters, sort and pagination' })
  listProducts(
    @Query() query: ProductQueryDto,
    @OptionalUser() user: AuthenticatedUser | undefined,
  ): Promise<Paginated<Product>> {
    return this.catalog.listProducts(query, user);
  }

  /**
   * Declared above `products/:slug`, or Express matches `facets` as a slug and every facets request
   * becomes a 404 for a product nobody named. Route order is the whole mechanism; there is no
   * decorator for it, and `catalog.controller.spec.ts` is what keeps it that way.
   */
  @Public()
  @Get('products/facets')
  @ApiOperation({ summary: 'Filter options and price bounds across the whole published catalogue' })
  productFacets(): Promise<CatalogFacets> {
    return this.facets.facets();
  }

  @Public()
  @Get('products/bestsellers')
  @ApiOperation({ summary: 'Products badged BESTSELLER' })
  bestsellers(
    @Query() query: ProductQueryDto,
    @OptionalUser() user: AuthenticatedUser | undefined,
  ): Promise<Paginated<Product>> {
    return this.catalog.listProducts({ ...query, bestsellerOnly: true }, user);
  }

  @Public()
  @Get('products/:slug')
  @ApiOperation({ summary: 'One product by slug' })
  product(
    @Param('slug') slug: string,
    @OptionalUser() user: AuthenticatedUser | undefined,
  ): Promise<Product> {
    return this.catalog.getProduct(slug, user);
  }

  @Public()
  @Get('products/:slug/related')
  @ApiOperation({ summary: 'Products in the same category, excluding this one' })
  related(
    @Param('slug') slug: string,
    @OptionalUser() user: AuthenticatedUser | undefined,
  ): Promise<Paginated<Product>> {
    return this.catalog.listRelated(slug, user);
  }

  @Public()
  @Get('categories')
  @ApiOperation({ summary: 'Published categories in display order' })
  categories(): Promise<Category[]> {
    return this.catalog.listCategories();
  }

  @Public()
  @Get('categories/:slug')
  @ApiOperation({ summary: 'One category by slug' })
  category(@Param('slug') slug: string): Promise<Category> {
    return this.catalog.getCategory(slug);
  }

  /** Position-independent: `combos` collides with no pattern declared above it. */
  @Public()
  @Get('combos')
  @ApiOperation({ summary: 'Assembled combo boxes with their savings' })
  listCombos(): Promise<Combo[]> {
    return this.combos.list();
  }

  /**
   * Position-independent, like `combos` above: `bulk/products` shares no first path segment with
   * `products/:slug`, so it cannot be shadowed by it and declaration order carries no risk here.
   */
  @Public()
  @Get('bulk/products')
  @ApiOperation({ summary: 'Published products with a resolvable bulk ladder, for the caller' })
  listBulkProducts(
    @Query() query: ProductQueryDto,
    @OptionalUser() user: AuthenticatedUser | undefined,
  ): Promise<Paginated<Product>> {
    return this.catalog.listBulkProducts(query, user);
  }

  /**
   * `POST`, not `GET`: the answer depends on the caller's own pricing viewer and must not be
   * cached or replayed for a different signed-in customer, the same reasoning `CheckoutController`
   * gives for the coupon preview.
   */
  @Public()
  @Post('bulk/quote-preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'A priced quote for one product at one weight, for the caller' })
  quotePreview(
    @Body() dto: QuotePreviewDto,
    @OptionalUser() user: AuthenticatedUser | undefined,
  ): Promise<QuotePreviewResponse> {
    return this.catalog.quotePreview(dto, user);
  }
}
