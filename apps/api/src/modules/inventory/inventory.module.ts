import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Inventory } from '../../entities/catalog/inventory.entity';
import { InventoryTransaction } from '../../entities/catalog/inventory-transaction.entity';
import { AdminModule } from '../admin/admin.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

/**
 * `InventoryService` is exported because checkout (Plan 3) decrements stock through the same ledger
 * rather than writing the column itself — the invariant `SUM(delta) == onHand` only holds if every
 * writer goes through one place.
 */
@Module({
  /**
   * `forFeature` declares the two tables this module owns. Nothing here is injected today —
   * `InventoryService` takes the `DataSource` and reaches both repositories through the
   * transaction's `EntityManager`, which is the only way the column write and the ledger row can
   * share a transaction — so removing this line changes no behaviour: measured, with both suites
   * still green. It is kept as the declaration of ownership, not as wiring something depends on.
   */
  /**
   * `AdminModule` for `AuditLogService`, which `setThreshold` writes through. No cycle: `AdminModule`
   * imports nothing — its two providers take only the `DataSource` and the caller's `EntityManager`
   * — which is what makes it importable from any module that gains an admin write.
   */
  imports: [
    TypeOrmModule.forFeature([Inventory, InventoryTransaction]),
    NotificationsModule,
    AdminModule,
  ],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
