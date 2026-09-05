import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Setting } from '../../entities/ops/setting.entity';
import { AdminModule } from '../admin/admin.module';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminSettingsService } from './admin-settings.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/**
 * Settings, over HTTP at last — spec §6.1's public `GET /settings` and §6.4's
 * `GET`/`PUT /admin/settings`.
 *
 * **This module used to carry no controller, and that was recorded as deliberate.** Its previous
 * docblock said "nothing exposes settings over HTTP yet… `GET /settings/public` is Milestone 8's",
 * and Milestone 8 never did it — so `isPublic` shipped with no consumer outside the entity, the
 * migration and the seed, which is indistinguishable from a flag that does not work. Plan 9.4
 * builds both halves. The public route is spelled `GET /settings`, per spec §6.1, not the
 * `/settings/public` that note anticipated: §6.1 is the contract the front-ends read.
 *
 * A module rather than providing `SettingsService` straight into `CheckoutModule`, so a second
 * consumer imports it instead of re-providing it — which resolves, by creating a second instance,
 * and is the kind of wrong fix that reads as correct for years.
 *
 * `AdminModule` is imported for `AuditLogService`. Note the consequence: `CheckoutModule` imports
 * this module, so `AdminModule` now sits in checkout's graph too and `checkout.module.spec.ts`
 * compiles it. That is fine and was verified rather than assumed — `AuditLogService` injects
 * nothing at all and `DashboardService` takes only the `DataSource`, which that spec already
 * provides globally.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Setting]), AdminModule],
  controllers: [SettingsController, AdminSettingsController],
  providers: [SettingsService, AdminSettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
