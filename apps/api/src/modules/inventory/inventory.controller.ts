import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminInventoryRow, AdminInventoryTransaction, Paginated } from '@nutwala/shared';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { UserRole } from '../../entities/enums';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { InventoryLedgerQueryDto, InventoryQueryDto } from './dto/inventory-query.dto';
import { UpdateThresholdDto } from './dto/update-threshold.dto';
import { InventoryService } from './inventory.service';

/**
 * The first admin-only route in the service. `RolesGuard` is global and reads the role from the
 * signed token, so this is enforced server-side regardless of what any client believes — which is
 * what makes the admin console being a separate application a deployment choice rather than a
 * security boundary.
 *
 * `@Roles(UserRole.ADMIN)` carries the database enum, not the wire role. There are two role
 * vocabularies in this codebase — the token carries `ADMIN`, an auth response body carries `admin`
 * via `toAuthUser` — and `RolesGuard` narrows the claim against the enum's real values. A `'admin'`
 * string literal here would compile and refuse every admin.
 *
 * **Plan 9.2 extended this controller rather than adding an `AdminInventoryController` beside it**,
 * and the reason is the opposite of the "second controller" rule that governs the rest of the admin
 * surface. That rule exists because no class may mix scopes — `AdminProductsController` is separate
 * from `CatalogController` because one is admin-only and the other is public, and a shared class
 * would leave `@Roles()` to be remembered per handler. This class is already `admin/inventory` and
 * already `@Roles(UserRole.ADMIN)` at class level, so a second controller would be two classes at
 * one base path with one scope between them: two places for the next handler to be added and two
 * chances for one of them to lose the decorator, with nothing gained. Every handler below inherits
 * the class decorator, which `test/integration/admin-routes-guarded.integration.spec.ts` verifies
 * through the booted application.
 *
 * **Route order.** `@Get()` carries no path, and the two `:variantId/...` routes are two segments
 * where `PATCH :variantId` is one, so nothing here can shadow anything: Express cannot match
 * `/admin/inventory/:variantId` against a two-segment request. That is the same argument
 * `admin-products.controller.ts` makes for `:id/publish`. A *literal* first segment added later —
 * `inventory/export`, say — would have to be declared above the `:variantId` routes, which is the
 * trap `OrdersController` carries a warning about in two places.
 */
@ApiTags('admin')
@Roles(UserRole.ADMIN)
@Controller('admin/inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @ApiOperation({
    summary: 'Stock across the catalogue — current, reserved, available, low, out (brief §32)',
  })
  list(@Query() query: InventoryQueryDto): Promise<Paginated<AdminInventoryRow>> {
    return this.inventory.list(query);
  }

  @Get(':variantId/transactions')
  @ApiOperation({ summary: "One variant's stock ledger, newest first (brief §32)" })
  transactions(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Query() query: InventoryLedgerQueryDto,
  ): Promise<Paginated<AdminInventoryTransaction>> {
    return this.inventory.transactions(variantId, query);
  }

  @Patch(':variantId')
  @ApiOperation({ summary: 'Adjust stock for a variant and record why' })
  adjust(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AdjustStockDto,
  ): Promise<{ onHand: number; balanceAfter: number }> {
    // `actorUserId` after the spread, deliberately: the audit trail's "who" comes from the signed
    // token and must not be overridable by a body field, whatever the validation pipe strips.
    return this.inventory.adjust({ variantId, ...dto, actorUserId: user.id });
  }

  /**
   * A separate route from the adjustment above, not a field on it: a threshold change moves no
   * stock, writes no ledger row, and has no reserved floor to breach. `InventoryService.setThreshold`
   * carries the full reasoning, including why it queues no `stock.low`.
   *
   * `actorUserId` after the spread, as everywhere: the audit row's "who" comes from the signed token
   * and must not be overridable by a body field.
   */
  @Patch(':variantId/threshold')
  @ApiOperation({ summary: "Change a variant's low-stock threshold. Audited, no ledger row" })
  setThreshold(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateThresholdDto,
  ): Promise<AdminInventoryRow> {
    return this.inventory.setThreshold(variantId, { ...dto, actorUserId: user.id });
  }
}
