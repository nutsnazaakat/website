import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminProduct, AdminVariant, Paginated } from '@nutwala/shared';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { UserRole } from '../../entities/enums';
import { AdminProductsService } from './admin-products.service';
import { AdminVariantsService } from './admin-variants.service';
import { AdminProductQueryDto } from './dto/admin-product-query.dto';
import { CreateProductDto, UpdateProductDto } from './dto/save-product.dto';
import { CreateVariantDto } from './dto/save-variant.dto';

/**
 * The admin half of the catalogue — spec §6.4's `/admin/products` block, brief §30.
 *
 * **A second controller beside `CatalogController`, not extra handlers on it.** No class mixes
 * scopes in this codebase, and here that is a safety property rather than tidiness: `RolesGuard`
 * resolves `@Roles()` with handler metadata overriding class metadata, so an admin route living on
 * a `@Public()`-heavy controller would depend on somebody remembering a per-handler decorator, and
 * a route that loses one is not refused — it is silently opened to every authenticated customer.
 * `@Roles(UserRole.ADMIN)` at the **class** makes every handler this controller ever grows guarded
 * by default, and `test/integration/admin-routes-guarded.integration.spec.ts` discovers it through
 * the booted application and fails the build if the decorator moves or changes.
 *
 * The enum, never the string: the token carries `ADMIN` while an auth response body carries
 * `admin` via `toAuthUser`, so `@Roles('admin')` compiles and refuses every admin —
 * `inventory.controller.ts` states the trap and the guard spec proves it.
 *
 * **`actorUserId` is assigned after the DTO spread**, everywhere below. The audit trail's "who"
 * comes from the signed token and must not be overridable by a body field, whatever the validation
 * pipe strips: `whitelist` would drop an `actorUserId` in the body today, but the spread order is
 * what makes that a property of this code rather than of the pipe's configuration.
 *
 * **Route order.** No literal path under `products/` is declared here, so nothing can be shadowed
 * by `:id` — the trap spec §6.1 records for `/catalog/products/facets`. `:id/publish`,
 * `:id/unpublish` and `:id/variants` are two-segment paths and cannot collide with the
 * single-segment `:id`. Adding a literal such as `products/export` later would have to go *above*
 * the `:id` handlers, and `ParseUUIDPipe` is a second line of defence: a non-uuid segment reaching
 * `:id` is a 400 rather than a lookup for a product nobody named.
 */
@ApiTags('admin')
@Roles(UserRole.ADMIN)
@Controller('admin/products')
export class AdminProductsController {
  constructor(
    private readonly products: AdminProductsService,
    private readonly variants: AdminVariantsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List products, unpublished included (brief §30)' })
  list(@Query() query: AdminProductQueryDto): Promise<Paginated<AdminProduct>> {
    return this.products.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One product by id, with every variant, active or not' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AdminProduct> {
    return this.products.get(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a product. Always unpublished — see POST :id/publish' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateProductDto,
  ): Promise<AdminProduct> {
    return this.products.create({ ...dto, actorUserId: user.id });
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a product. An omitted field is left unchanged' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProductDto,
  ): Promise<AdminProduct> {
    return this.products.update(id, { ...dto, actorUserId: user.id });
  }

  /**
   * `204`, no body.
   *
   * There is nothing to return — the row is gone — and a `200 { success: true, data: null }` would
   * invite a client to look for the deleted product in it. The refusal path is where the
   * information is: a 409 carrying `ENTITY_IN_USE` and what referenced the row.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a product. Refused with 409 if it has been ordered or stocked' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.products.remove(id, user.id);
  }

  /**
   * `200`, not `201`: publishing changes an existing product rather than creating anything, and
   * `@HttpCode` is needed because Nest defaults every `@Post` to 201. `CatalogController`'s
   * `bulk/quote-preview` does the same for the same reason.
   *
   * Idempotent: publishing an already-published product answers its current state and writes
   * nothing, including no audit row.
   */
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish a product to the storefront' })
  publish(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AdminProduct> {
    return this.products.publish(id, user.id);
  }

  @Post(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw a product from the storefront, keeping everything else' })
  unpublish(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AdminProduct> {
    return this.products.unpublish(id, user.id);
  }

  /**
   * Declared here rather than on `AdminVariantsController` because the path is
   * `admin/products/:id/variants` — a Nest controller has one base path, and spec §6.4 puts variant
   * *creation* under the product and variant update and delete at `admin/variants/:id`. Both
   * controllers call the one `AdminVariantsService`, so the split is in the URL only.
   */
  @Post(':id/variants')
  @ApiOperation({ summary: 'Add a variant, creating its inventory row in the same transaction' })
  createVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateVariantDto,
  ): Promise<AdminVariant> {
    return this.variants.create(id, { ...dto, actorUserId: user.id });
  }
}
