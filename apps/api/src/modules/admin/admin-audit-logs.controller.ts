import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminAuditLogEntry, Paginated } from '@nutwala/shared';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { UserRole } from '../../entities/enums';
import { AdminAuditLogsService } from './admin-audit-logs.service';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';

/**
 * `GET /admin/audit-logs` — spec §6.4's last row.
 *
 * In `AdminModule` rather than beside an aggregate's own controller, which is exactly what that
 * module is for: "the admin-only surface that has no customer-facing counterpart". There is no
 * public audit log and there never will be.
 *
 * `@Roles(UserRole.ADMIN)` at the class, carrying the database enum. One handler today, and the
 * decorator is at the class anyway — that is the whole convention: every handler this controller
 * ever grows is guarded by default rather than by somebody remembering.
 *
 * **Read-only, and there is no write route by design.** A trail an admin can edit is not a trail.
 * `AuditLogService.record` is the only writer, and it runs inside the caller's own transaction so
 * the row and the change it describes commit or roll back together.
 */
@ApiTags('admin')
@Roles(UserRole.ADMIN)
@Controller('admin/audit-logs')
export class AdminAuditLogsController {
  constructor(private readonly auditLogs: AdminAuditLogsService) {}

  /**
   * Filterable by actor, entity type, entity id, action and date range; paginated; newest first.
   *
   * **Stock movements are not in this trail** — `AdminAuditLogsService`'s docblock and
   * `AdminAuditLogEntry`'s both say so and why. An operator looking for who adjusted stock wants
   * `GET /admin/inventory/:variantId/transactions`, which is brief §32's history in full.
   */
  @Get()
  @ApiOperation({
    summary:
      'Admin actions, newest first. Stock movements live in the inventory ledger, not here (spec §5)',
  })
  list(@Query() query: AuditLogQueryDto): Promise<Paginated<AdminAuditLogEntry>> {
    return this.auditLogs.list(query);
  }
}
