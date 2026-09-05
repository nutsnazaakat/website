import { Global, Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../app.module';
import { WINSTON_LOGGER } from '../../common/logging/winston-logger.service';
import { AdminRfqsController } from './admin-rfqs.controller';
import { AdminRfqsService } from './admin-rfqs.service';
import { RfqsController } from './rfqs.controller';
import { RfqsModule } from './rfqs.module';
import { RfqsService } from './rfqs.service';

/**
 * `RfqsService` takes the `DataSource` directly rather than any `@InjectRepository`, so this is
 * the only thing `RfqsModule`'s graph needs stubbed — no `TypeOrmModule.forFeature` entity to
 * fake, unlike `checkout.module.spec.ts`'s `StubDataSourceModule`, which this mirrors for the
 * identical reason: a real connection must not open during a unit-level compile.
 */
@Global()
@Module({
  providers: [{ provide: DataSource, useValue: { transaction: jest.fn() } }],
  exports: [DataSource],
})
class StubDataSourceModule {}

/**
 * `RfqsModule` now imports `NotificationsModule`, which imports the `@Global()` `LoggingModule`
 * for `LoggingNotificationDriver`'s `WinstonLoggerService` dependency. `LoggingModule`'s own
 * `WINSTON_LOGGER` provider is a `useFactory` that injects `ConfigService` — never provided in
 * this graph, since nothing here imports Nest's `ConfigModule` — so `.compile()` eagerly building
 * `LoggingNotificationDriver` (a singleton provider) failed with *"Nest can't resolve dependencies
 * of the Symbol(WINSTON_LOGGER) (?) … ConfigService at index [0]"* until this override was added.
 * `checkout.module.spec.ts` hits the identical shape for `CartController`'s own `ConfigService`
 * dependency and resolves it by loading the real `ConfigModule` with placeholder env vars; a
 * one-line `useValue` here is the narrower fix, since nothing in this file's assertions cares what
 * the logger actually does.
 */
const STUB_LOGGER = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

/**
 * `AppModule` actually **imports** `RfqsModule` — measured, not assumed. Plan 3's Task 17 found
 * that deleting a module from `AppModule.imports` left typecheck, eslint and every unit test
 * green while both its endpoints 404'd, because a routing assertion reads the *controller's* own
 * metadata and a controller Nest was never told about still carries it. Compiling the real module
 * graph is the one check that would have caught that, and it is what this file exists to be.
 */
describe('RfqsModule', () => {
  it('compiles, resolving the controller and its service', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StubDataSourceModule, RfqsModule],
    })
      .overrideProvider(WINSTON_LOGGER)
      .useValue(STUB_LOGGER)
      .compile();

    try {
      expect(moduleRef.get(RfqsController)).toBeInstanceOf(RfqsController);
      expect(moduleRef.get(RfqsService)).toBeInstanceOf(RfqsService);
      // Plan 9.3's second controller. A separate class from `RfqsController`, whose create routes
      // are `@Public()` — and which must never load the `rfq_notes` relation this one returns.
      expect(moduleRef.get(AdminRfqsController)).toBeInstanceOf(AdminRfqsController);
      expect(moduleRef.get(AdminRfqsService)).toBeInstanceOf(AdminRfqsService);
    } finally {
      await moduleRef.close();
    }
  });

  /**
   * **Registered in `AppModule`, or both routes 404 with every unit test in this file green.**
   * `orders.module.spec.ts`'s own lesson, measured the same way there: deleting a module from
   * `AppModule.imports` leaves typecheck, eslint and this file's own compile test all green,
   * because compiling `RfqsModule` in isolation, as the test above does, cannot see whether the
   * *application* was ever told to mount it. Only `AppModule`'s own metadata can.
   */
  it('is registered in AppModule, without which both routes 404', () => {
    const imported = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as unknown[];
    expect(imported).toContain(RfqsModule);
  });
});
