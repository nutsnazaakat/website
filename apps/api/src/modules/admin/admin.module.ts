// backend/src/modules/admin/admin.module.ts
import { Module } from '@nestjs/common';
import { AdminAuditLogsController } from './admin-audit-logs.controller';
import { AdminAuditLogsService } from './admin-audit-logs.service';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AuditLogService } from './audit-log.service';
import { DashboardService } from './dashboard.service';

/**
 * Groups the admin-only surface that has no customer-facing counterpart. Existing modules that gain
 * admin routes keep their own second controller instead of moving here, so no class mixes scopes.
 *
 * No `TypeOrmModule.forFeature` — `NotificationsModule`'s reasoning verbatim: `AuditLogService`
 * takes no repository of its own, and `record()`'s `manager` is always the caller's own open
 * transaction, through which `AuditLog` is reached.
 *
 * `AuditLogService` is exported because almost none of its callers live here. Every admin write in
 * plans 9.1–9.4 — products, variants, categories, orders, coupons, reviews, settings — records a
 * row inside its own transaction, and those services belong to the modules that own their
 * aggregates. Registered from the start rather than when the first caller appears: a provider that
 * exists but is in no module type-checks perfectly and fails only at boot, and the whole point of
 * this milestone's first two tasks is not leaving that kind of thing to be remembered later.
 */
/**
 * `DashboardService` takes only the `DataSource` — every figure is an aggregate query and it owns
 * no table — so it needs no `forFeature` either. It is **not** exported: nothing outside this
 * module has any business recomputing brief §29's figures, and the day something does, it should
 * import this module rather than the provider being available by default.
 */
/**
 * `AdminAuditLogsService` is the **read** half of `audit_logs`, added by plan 9.4, and it is not
 * exported for the same reason `DashboardService` is not: nothing outside this module has any
 * business reading the trail, and the day something does it should import this module rather than
 * find the provider available by default. It takes only the `DataSource` — no `forFeature` — and
 * only ever reads. Keeping the writer (`AuditLogService`, exported because almost none of its
 * callers live here) and the reader in one module, with opposite export rules, is what makes
 * "there is one write path onto this table" a property of the wiring rather than of a docblock.
 */
@Module({
  controllers: [AdminDashboardController, AdminAuditLogsController],
  providers: [AuditLogService, DashboardService, AdminAuditLogsService],
  exports: [AuditLogService],
})
export class AdminModule {}
