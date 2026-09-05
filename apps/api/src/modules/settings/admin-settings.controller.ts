import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminSetting } from '@nutwala/shared';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/auth/jwt.strategy';
import { UserRole } from '../../entities/enums';
import { AdminSettingsService } from './admin-settings.service';
import { ReplaceSettingsDto } from './dto/replace-settings.dto';

/**
 * `/admin/settings` — spec §6.4, brief §26 and §37.
 *
 * **A second controller beside `SettingsController`**, which serves the public subset at
 * `GET /settings`. No class mixes scopes: that one is `@Public()`, this one is
 * `@Roles(UserRole.ADMIN)` at the class carrying the database enum.
 *
 * There is no `:key` route, and §6.4 lists none: `GET` answers the whole table and `PUT` takes as
 * many keys as the caller wants, so a per-key route would be a second way to do the same thing with
 * its own audit path to keep in step.
 */
@ApiTags('admin')
@Roles(UserRole.ADMIN)
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(private readonly settings: AdminSettingsService) {}

  /** `GET /admin/settings` — every row, private ones included. That is the difference from `GET /settings`. */
  @Get()
  @ApiOperation({ summary: 'Every setting, private ones included, ordered by key' })
  list(): Promise<AdminSetting[]> {
    return this.settings.list();
  }

  /**
   * `PUT /admin/settings` — write the keys named, leave the rest alone.
   *
   * Not a whole-table replace despite the verb; `ReplaceSettingsDto` records why a literal PUT
   * would delete fourteen settings the first time a console saved one form section. A key that does
   * not already exist is a **404** naming it, rather than a silently created row nothing reads.
   *
   * No `@HttpCode`: Nest answers a `PUT` with 200 by default, which is right here — the body is the
   * settings as they now stand, so the console re-renders the committed values and their
   * `updatedAt` from the response.
   */
  @Put()
  @ApiOperation({ summary: 'Update settings by key. An unknown key is refused (brief §26, §37)' })
  replace(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReplaceSettingsDto,
  ): Promise<AdminSetting[]> {
    // `actorUserId` after the spread: `settings.updated_by_user_id` and the audit row's "who" both
    // come from the signed token, never from a body field.
    return this.settings.replace({ ...dto, actorUserId: user.id });
  }
}
