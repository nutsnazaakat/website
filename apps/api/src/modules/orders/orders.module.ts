import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from '../../entities/commerce/order.entity';
import { Payment } from '../../entities/commerce/payment.entity';
import { Shipment } from '../../entities/commerce/shipment.entity';
import { AdminModule } from '../admin/admin.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminOrdersController } from './admin-orders.controller';
import { AdminOrdersService } from './admin-orders.service';
import { OrderStatusService } from './order-status.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

/**
 * The module that finally puts `modules/orders/` behind a URL.
 *
 * `order-number.ts`, `order-status.service.ts`, `orders.service.ts` and `mappers/order.mapper.ts`
 * were all built and tested before this file existed, and until now **none of them was registered in
 * any module** — `CheckoutService` reaches `nextOrderNumber` and `toAccountOrder` as plain function
 * imports, which need no provider, and `OrderStatusService` had no consumer at all.
 *
 * **`OrderStatusService` is exported, and that export is the point of this line existing.** §7.1 puts
 * the admin console in a **separate application and repository**, and its status screens are the only
 * thing that transitions an order. Exported, that repository's plan wires those screens to this
 * implementation — the single server-side consumer of `@nutwala/shared`'s `RETAIL_TRANSITIONS` /
 * `BULK_TRANSITIONS`, with the stock consequence and the `OrderEvent` write in one transaction, under
 * `order-status.service.spec.ts`. Unexported, the first admin screen resolves nothing, and the
 * cheapest way out is a second transition table — the third copy of brief §33's vocabulary, and the
 * one that drifts. `orders.module.spec.ts` proves the export by *consuming* it from a probe module
 * rather than by reading the array, because `TestingModule.get` is non-strict by default and reaches
 * unexported providers of imported modules, so a `get(OrderStatusService)` would pass with the
 * export deleted.
 *
 * **`OrdersService` is exported too, as of Task 17 of the B2B plan — and the reasoning above
 * needs updating rather than deleting, because it was correct when it was written.** Nothing
 * outside this module read an order at the time: `CheckoutController` reloads its placed order
 * through its own `Order` repository rather than a read service that would scope the row to a
 * customer the guest path does not have, and that is still true today. What changed is
 * `BusinessesController.listOrders` (`GET /business/orders`), which is deliberately *not* a
 * second implementation of "this caller's orders, filtered to bulk" — it delegates to
 * `OrdersService.list` so it inherits the IDOR scoping, the `placedAt DESC` ordering and the
 * `ITEMS_IN_ORDER` clause `toAccountOrder` throws without, exactly as `OrdersController.list`
 * does for the unfiltered read. An export nothing imports is still an invitation to reach past
 * the controller; an export exactly one other module imports, for exactly this reason, is not.
 *
 * `Payment` and `Shipment` joined `forFeature` with plan 9.2's COD collection and shipment
 * creation: `AdminOrdersService` injects both repositories to read what sits behind an order for
 * `GET /admin/orders/:orderNumber`. Both writes go through the transaction's own
 * `manager.getRepository(...)` and need no token — the registrations are for the reads.
 *
 * `forFeature` lists exactly what is injected: `OrdersService` takes `Repository<Order>`, and
 * `OrderStatusService` takes the `DataSource` and does everything through one transaction's
 * `EntityManager` — so `OrderEvent` and `InventoryTransaction` are reached with
 * `manager.getRepository(...)` and need no registration here. Both are on the `DataSource`'s entity
 * glob already; `forFeature` is about injectable repository tokens, not about which entities exist.
 */
/**
 * **`AdminModule`, for `AuditLogService`.** Plan 9.2 puts the `audit_logs` row for an admin status
 * change inside `OrderStatusService.transition`'s own transaction — the only place it can be atomic
 * with the change, since nothing else holds that transaction — so the service now injects it.
 * `InventoryModule` imports the same module for the same reason and there is no cycle:
 * `AdminModule` imports nothing at all, which is precisely what makes it importable from every
 * module that grows an admin write.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Order, Payment, Shipment]), NotificationsModule, AdminModule],
  controllers: [OrdersController, AdminOrdersController],
  providers: [OrdersService, OrderStatusService, AdminOrdersService],
  exports: [OrderStatusService, OrdersService],
})
export class OrdersModule {}
