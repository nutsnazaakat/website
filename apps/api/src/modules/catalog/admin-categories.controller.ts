import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminCategory } from '@nutwala/shared';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { UserRole } from '../../entities/enums';
import { AdminCategoriesService } from './admin-categories.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/save-category.dto';

/**
 * `GET`, `POST` and `PATCH /admin/categories` — spec §6.4, brief §7.
 *
 * **No `DELETE`, deliberately.** §6.4 lists exactly these three verbs for this resource.
 * `AdminCategoriesService`'s docblock has the fuller reasoning and the report: `products.category_id`
 * is `ON DELETE RESTRICT`, so a category holding products cannot be deleted anyway, and
 * `isPublished: false` through the PATCH below is what "take it off the storefront" actually means.
 *
 * `@Roles(UserRole.ADMIN)` at the class, carrying the database enum — see
 * `admin-products.controller.ts` for why both halves matter.
 */
@ApiTags('admin')
@Roles(UserRole.ADMIN)
@Controller('admin/categories')
export class AdminCategoriesController {
  constructor(private readonly categories: AdminCategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'Every category, unpublished included, in display order' })
  list(): Promise<AdminCategory[]> {
    return this.categories.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create a category' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCategoryDto,
  ): Promise<AdminCategory> {
    // `actorUserId` after the spread — the audit trail's "who" is the signed token's, never a
    // body field's.
    return this.categories.create({ ...dto, actorUserId: user.id });
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a category. An omitted field is left unchanged' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateCategoryDto,
  ): Promise<AdminCategory> {
    return this.categories.update(id, { ...dto, actorUserId: user.id });
  }
}
