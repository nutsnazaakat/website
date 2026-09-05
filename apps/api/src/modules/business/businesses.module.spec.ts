import { Global, Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../app.module';
import { WINSTON_LOGGER } from '../../common/logging/winston-logger.service';
import { Order } from '../../entities/commerce/order.entity';
import { Payment } from '../../entities/commerce/payment.entity';
import { Shipment } from '../../entities/commerce/shipment.entity';
import { Address } from '../../entities/identity/address.entity';
import { Business } from '../../entities/identity/business.entity';
import { User } from '../../entities/identity/user.entity';
import { OrdersService } from '../orders/orders.service';
import { AdminBusinessesController } from './admin-businesses.controller';
import { AdminBusinessesService } from './admin-businesses.service';
import { BusinessStatsService } from './business-stats.service';
import { BusinessesController } from './businesses.controller';
import { BusinessesModule } from './businesses.module';
import { BusinessesService } from './businesses.service';

/**
 * `BusinessStatsService` takes the `DataSource` directly, exactly as `RfqsService` does — no
 * `TypeOrmModule.forFeature` entity to fake, but still something to stub, since a real
 * connection must not open during a unit-level compile. `rfqs.module.spec.ts`'s own
 * `StubDataSourceModule`.
 */
@Global()
@Module({
  providers: [{ provide: DataSource, useValue: { query: jest.fn(), getRepository: jest.fn() } }],
  exports: [DataSource],
})
class StubDataSourceModule {}

/**
 * `BusinessesModule` imports `OrdersModule` so `GET /business/orders` can delegate to
 * `OrdersService`, and `OrdersModule` now imports `NotificationsModule` for
 * `OrderStatusService`'s `order.shipped`/`order.delivered` queue. That pulls in the `@Global()`
 * `LoggingModule`, whose `WINSTON_LOGGER` is a `useFactory` injecting a `ConfigService` this graph
 * never provides — so `.compile()` failed building `LoggingNotificationDriver` until this stub
 * arrived. Same fix, same reason, as `rfqs.module.spec.ts` and `orders.module.spec.ts`.
 */
const STUB_LOGGER = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

/**
 * `AppModule` actually **imports** `BusinessesModule`, and the plan for this task calls that out
 * by name: the module already existed, imported only by `AuthModule`, so `GET`/`PUT /business/me`
 * would 404 with typecheck, lint and every unit test green if this import were the one missed —
 * `RfqsModule`'s own spec measured the identical failure mode for the identical reason. Only
 * `AppModule`'s own metadata can see whether the application was ever told to mount it.
 */
describe('BusinessesModule', () => {
  it('compiles, resolving the controller and both its services', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StubDataSourceModule, BusinessesModule],
    })
      .overrideProvider(getRepositoryToken(Business))
      .useValue({ find: jest.fn(), findOne: jest.fn(), update: jest.fn() })
      .overrideProvider(getRepositoryToken(Address))
      .useValue({ find: jest.fn(), findOne: jest.fn() })
      // Plan 9.3: `AdminBusinessesService` reads the account behind each business for its email,
      // and the admin named as its `assigned_salesperson_id`.
      .overrideProvider(getRepositoryToken(User))
      .useValue({ find: jest.fn() })
      .overrideProvider(getRepositoryToken(Order))
      .useValue({ find: jest.fn(), findOne: jest.fn() })
      // Reached through `OrdersModule`, which this module imports for `OrdersService`: plan 9.2
      // added `Payment` to that module's `forFeature` for `AdminOrdersService`'s detail read.
      .overrideProvider(getRepositoryToken(Payment))
      .useValue({ findOne: jest.fn() })
      .overrideProvider(getRepositoryToken(Shipment))
      .useValue({ find: jest.fn() })
      .overrideProvider(WINSTON_LOGGER)
      .useValue(STUB_LOGGER)
      .compile();

    try {
      expect(moduleRef.get(BusinessesController)).toBeInstanceOf(BusinessesController);
      expect(moduleRef.get(BusinessesService)).toBeInstanceOf(BusinessesService);
      expect(moduleRef.get(BusinessStatsService)).toBeInstanceOf(BusinessStatsService);
      // Plan 9.3's second controller. A separate class from `BusinessesController`, which stays
      // `@Roles(UserRole.BUSINESS)` — see its docblock for why merging them is a permissions
      // hazard rather than a tidiness question.
      expect(moduleRef.get(AdminBusinessesController)).toBeInstanceOf(AdminBusinessesController);
      expect(moduleRef.get(AdminBusinessesService)).toBeInstanceOf(AdminBusinessesService);
      // `OrdersModule` — Task 17's import, without which `GET /business/orders` cannot resolve
      // `OrdersService` at all, not merely delegate to the wrong instance of it.
      expect(moduleRef.get(OrdersService)).toBeInstanceOf(OrdersService);
    } finally {
      await moduleRef.close();
    }
  });

  it('is registered in AppModule, without which both routes 404', () => {
    const imported = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as unknown[];
    expect(imported).toContain(BusinessesModule);
  });
});
