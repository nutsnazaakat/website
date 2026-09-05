import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminCoupon, Paginated } from '@nutwala/shared';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { UserRole } from '../../entities/enums';
import { AdminCouponsService } from './admin-coupons.service';
import { AdminCouponQueryDto } from './dto/admin-coupon-query.dto';
import { CreateCouponDto, UpdateCouponDto } from './dto/save-coupon.dto';

/**
 * `/admin/coupons` — spec §6.4, brief §36.
 *
 * **`:code`, not `:id`.** `AdminCouponsService`'s docblock carries the full case and the correction
 * §6.4 needs; in short, the code is the only handle anything else in this system uses for a coupon.
 *
 * `@Roles(UserRole.ADMIN)` at the **class**, carrying the database enum. Both halves matter: at the
 * class, every handler this controller ever grows is guarded by default rather than by somebody
 * remembering; and the enum, because the token carries `ADMIN` while an auth response body carries
 * `admin`, so `@Roles('admin')` compiles and refuses every admin.
 *
 * **Declaration order is routing order.** Nest registers handlers in prototype order and Express
 * matches the first that fits, so a literal sibling of `:code` — an `/admin/coupons/export`, say —
 * would have to be declared **above** the `@Get()` list and the `:code` routes, or the pattern
 * swallows it. There is none today, which is exactly when one gets added and nobody can work out
 * why it 404s.
 *
 * There is no `GET /admin/coupons/:code`, and §6.4 lists none: the list returns every field of the
 * shape, so a detail route would answer with something the caller already holds.
 */
@ApiTags('admin')
@Roles(UserRole.ADMIN)
@Controller('admin/coupons')
export class AdminCouponsController {
  constructor(private readonly coupons: AdminCouponsService) {}

  @Get()
  @ApiOperation({ summary: 'Coupons, newest first, paginated (brief §36)' })
  list(@Query() query: AdminCouponQueryDto): Promise<Paginated<AdminCoupon>> {
    return this.coupons.list(query);
  }

  @Post()
  @ApiOperation({ summary: 'Create a coupon' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCouponDto,
  ): Promise<AdminCoupon> {
    // `actorUserId` after the spread — the audit trail's "who" is the signed token's, never a body
    // field's, whatever the validation pipe strips.
    return this.coupons.create({ ...dto, actorUserId: user.id });
  }

  /**
   * `PATCH /admin/coupons/:code`. An omitted field is left unchanged; an explicit `null` clears a
   * nullable one. `code` itself cannot be changed — `UpdateCouponDto` records why.
   *
   * No `ParseUUIDPipe`, unlike the catalogue's `:id` routes: the parameter is a coupon code, so a
   * uuid pipe here would reject every real reference. The service uppercases it, as
   * `CouponService.preview` does, so `save10` and `SAVE10` address one row.
   */
  @Patch(':code')
  @ApiOperation({ summary: 'Update a coupon. An omitted field is left unchanged' })
  update(
    @Param('code') code: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateCouponDto,
  ): Promise<AdminCoupon> {
    return this.coupons.update(code, { ...dto, actorUserId: user.id });
  }

  /**
   * `DELETE /admin/coupons/:code` — refused with `409 ENTITY_IN_USE` once the coupon has been
   * redeemed, per spec §5a.
   *
   * `@HttpCode(HttpStatus.NO_CONTENT)`, matching `DELETE /admin/products/:id`: there is nothing
   * left to return, and a 200 with an empty envelope would suggest otherwise.
   */
  @Delete(':code')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a coupon. Refused once it has been redeemed (spec §5a)' })
  remove(@Param('code') code: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.coupons.remove(code, user.id);
  }
}
