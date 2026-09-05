import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Address } from '../../entities/identity/address.entity';
import { Business } from '../../entities/identity/business.entity';
import { User } from '../../entities/identity/user.entity';
import { OrdersModule } from '../orders/orders.module';
import { AdminBusinessesController } from './admin-businesses.controller';
import { AdminBusinessesService } from './admin-businesses.service';
import { BusinessStatsService } from './business-stats.service';
import { BusinessesController } from './businesses.controller';
import { BusinessesService } from './businesses.service';

/**
 * `Address` joined `forFeature` in Task 15: `BusinessesService.update` validates
 * `billingAddressId`/`shippingAddressId` against the caller's own address book before writing
 * either, and `getProfile` resolves both references the same way — both need
 * `Repository<Address>`, and `AddressesModule` does not export one for another module to inject.
 *
 * `BusinessStatsService` (Task 16) needs no entry here: like `RfqsService`, it takes the
 * `DataSource` directly rather than an injected repository, so there is nothing for
 * `forFeature` to register on its behalf.
 *
 * `OrdersModule` joined `imports` in Task 17: `GET /business/orders` delegates to
 * `OrdersService.list` rather than writing a second query, and `OrdersModule` now exports it
 * for exactly this consumer — see that module's own docblock.
 *
 * `User` joined `forFeature` with plan 9.3's admin surfaces: `AdminBusinessesService` reads the
 * account behind each business (for its email, which `businesses` has no column for) and the admin
 * named as its `assigned_salesperson_id`. `UsersModule` exports `UsersService`, not a repository,
 * and `forFeature` is how a repository token is obtained — it is not a claim of ownership over the
 * table, which is why `UsersModule` keeps its own registration.
 *
 * **`AdminBusinessesController` is a second controller, not extra handlers on
 * `BusinessesController`.** That class is `@Roles(UserRole.BUSINESS)` and stays that way; see the
 * admin controller's own docblock for why merging the two would be a permissions hazard rather than
 * a tidiness question.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Business, Address, User]), OrdersModule],
  controllers: [BusinessesController, AdminBusinessesController],
  providers: [BusinessesService, BusinessStatsService, AdminBusinessesService],
  exports: [BusinessesService],
})
export class BusinessesModule {}
