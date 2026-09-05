import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminVariant } from '@nutwala/shared';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { UserRole } from '../../entities/enums';
import { AdminVariantsService } from './admin-variants.service';
import { UpdateVariantDto } from './dto/save-variant.dto';

/**
 * `PATCH` and `DELETE /admin/variants/:id` — spec §6.4.
 *
 * A third controller rather than two more handlers on `AdminProductsController`, purely because a
 * Nest controller has one base path and §6.4 addresses a variant at the top level once it exists:
 * `admin/products/:id/variants` to create, `admin/variants/:id` to change. Both call the one
 * `AdminVariantsService`, so nothing about the rules is split — only the URL.
 *
 * `@Roles(UserRole.ADMIN)` at the class, carrying the database enum. Everything
 * `admin-products.controller.ts`'s docblock says about why applies here unchanged, and this class
 * is discovered by the same guard-coverage spec.
 */
@ApiTags('admin')
@Roles(UserRole.ADMIN)
@Controller('admin/variants')
export class AdminVariantsController {
  constructor(private readonly variants: AdminVariantsService) {}

  @Patch(':id')
  @ApiOperation({ summary: 'Update a variant. An omitted field is left unchanged' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateVariantDto,
  ): Promise<AdminVariant> {
    // `actorUserId` after the spread: the audit trail's "who" comes from the signed token and must
    // not be overridable by a body field.
    return this.variants.update(id, { ...dto, actorUserId: user.id });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a variant. Refused with 409 if it holds stock, or has been ordered or stocked',
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.variants.remove(id, user.id);
  }
}
