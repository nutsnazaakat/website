import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminSupportTicketsController } from './admin-support-tickets.controller';
import { AdminSupportTicketsService } from './admin-support-tickets.service';
import { SupportTicketsController } from './support-tickets.controller';
import { SupportTicketsService } from './support-tickets.service';

/**
 * The contact form's `POST /contact`, and — as of plan 9.4 — brief §38's admin triage queue.
 *
 * No `TypeOrmModule.forFeature`: both services take the `DataSource` and do everything through one
 * transaction's `EntityManager`, `RfqsModule`'s own pattern. `AdminSupportTicketsService` reads
 * `User` that way too, for a note author's name and for the assignee role check, so nothing here
 * needs a repository token.
 *
 * `AdminModule` is imported for `AuditLogService`.
 *
 * **Two controllers, no class mixing scopes**: `SupportTicketsController` is `@Controller('contact')`
 * with one `@Public()` route, and `AdminSupportTicketsController` is `@Roles(ADMIN)` at the class.
 */
@Module({
  imports: [NotificationsModule, AdminModule],
  controllers: [SupportTicketsController, AdminSupportTicketsController],
  providers: [SupportTicketsService, AdminSupportTicketsService],
})
export class SupportTicketsModule {}
