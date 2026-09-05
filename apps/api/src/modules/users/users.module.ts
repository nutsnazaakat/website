import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Address } from '../../entities/identity/address.entity';
import { Business } from '../../entities/identity/business.entity';
import { User } from '../../entities/identity/user.entity';
import { AdminCustomersController } from './admin-customers.controller';
import { AdminCustomersService } from './admin-customers.service';
import { UsersService } from './users.service';

/**
 * `Business` and `Address` joined `forFeature` with plan 9.3's customer surfaces:
 * `AdminCustomersService` injects a repository for each so `GET /admin/customers/:id` can answer
 * brief §35's address book and business record. Neither module that owns those entities exports a
 * repository for another module to inject, and `forFeature` is how a repository token is obtained —
 * it is not a claim of ownership over the table, which is why `AddressesModule` and
 * `BusinessesModule` both keep theirs. `BusinessesModule` already registers the identical pair for
 * the mirror-image reason.
 *
 * **`AdminCustomersService` is not exported.** Nothing outside this module has any business
 * reading the whole customer base, and the day something does it should import this module rather
 * than the provider being available by default — `AdminModule` states the same rule for
 * `DashboardService`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User, Business, Address])],
  controllers: [AdminCustomersController],
  providers: [UsersService, AdminCustomersService],
  exports: [UsersService],
})
export class UsersModule {}
