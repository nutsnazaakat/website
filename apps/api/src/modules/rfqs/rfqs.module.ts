import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminRfqsController } from './admin-rfqs.controller';
import { AdminRfqsService } from './admin-rfqs.service';
import { RfqsController } from './rfqs.controller';
import { RfqStatusService } from './rfq-status.service';
import { RfqsService } from './rfqs.service';

/**
 * No `TypeOrmModule.forFeature` here — `RfqsService` and `RfqStatusService` both take the
 * `DataSource` and reach `Rfq`/`Product` through one transaction's `EntityManager`, the same
 * arrangement `CheckoutService` uses. `DataSource` is a globally-provided token from the root
 * `TypeOrmModule.forRootAsync` in `AppModule`, so nothing here needs to ask for it either.
 *
 * `NotificationsModule` is imported for both services' sake: `RfqsService.create` queues
 * `rfq.received` (Task 8 of this plan) and `RfqStatusService.transition` queues
 * `rfq.status-changed` on every legal move.
 *
 * **`RfqStatusService` is exported, and that export is the point of this line existing.**
 * §7.1 puts the admin console in a separate application and repository, and its status screens
 * are the only thing that will transition an RFQ. Exported, that repository's own plan wires
 * those screens to this implementation — the single server-side consumer of `@nutwala/shared`'s
 * `RFQ_TRANSITIONS`. `RfqsService` stays unexported: nothing outside this module reads or writes
 * an RFQ through it today.
 *
 * `AdminRfqsService` takes the `DataSource` for the same reason `RfqsService` does, so there is
 * still no `forFeature` here. It is **not** exported: nothing outside this module has any business
 * reading the shop's whole enquiry queue.
 *
 * `AdminRfqsController` is a second controller beside `RfqsController`, whose two create routes are
 * `@Public()` — no class in this codebase mixes scopes, and here that is a disclosure property
 * rather than tidiness: this controller returns `rfq_notes`, which the public one must never load.
 */
/**
 * **`AdminModule`, for `AuditLogService`.** Plan 9.3 puts the `audit_logs` row for an admin RFQ
 * status change inside `RfqStatusService.transition`'s own transaction — the only place it can be
 * atomic with the change, since nothing else holds that transaction — so the service now injects
 * it, and `AdminRfqsService` injects it for the field edits and the note writes.
 * `OrdersModule` and `InventoryModule` import the same module for the same reason, and there is no
 * cycle: `AdminModule` imports nothing at all, which is precisely what makes it importable from
 * every module that grows an admin write.
 */
@Module({
  imports: [NotificationsModule, AdminModule],
  controllers: [RfqsController, AdminRfqsController],
  providers: [RfqsService, RfqStatusService, AdminRfqsService],
  exports: [RfqStatusService],
})
export class RfqsModule {}
