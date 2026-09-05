import { Global, Injectable, Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../app.module';
import { WINSTON_LOGGER } from '../../common/logging/winston-logger.service';
import { Order } from '../../entities/commerce/order.entity';
import { Payment } from '../../entities/commerce/payment.entity';
import { Shipment } from '../../entities/commerce/shipment.entity';
import { OrderStatusService } from './order-status.service';
import { OrdersController } from './orders.controller';
import { OrdersModule } from './orders.module';
import { OrdersService } from './orders.service';

/**
 * `DataSource` handed to the graph, `@Global()` because that is the only way to reach it.
 *
 * `TypeOrmModule.forRoot` is what normally provides it, and it opens a real connection during
 * `app.init()`. `overrideProvider(DataSource)` cannot stand in for it either: an override replaces a
 * provider a module *declares*, and nothing here declares one — `OrderStatusService` merely injects
 * it. Same arrangement, and the same reason, as `checkout.module.spec.ts`.
 */
@Global()
@Module({
  providers: [{ provide: DataSource, useValue: { transaction: jest.fn() } }],
  exports: [DataSource],
})
class StubDataSourceModule {}

/**
 * A stand-in for the admin console — §7.1's **separate application and repository** — which is the
 * only consumer `OrderStatusService` has and the whole reason this module exports it.
 *
 * The class does nothing but inject it, and that is the assertion: Nest's module encapsulation means
 * an importing module can resolve only what the imported module `exports`, so this constructor is the
 * one thing in the repository that can tell an exported provider from a merely-provided one.
 *
 * `moduleRef.get(OrderStatusService)` **cannot**: `TestingModule.get` runs non-strict by default and
 * walks the whole container, imported modules' private providers included, so it answers an instance
 * with the `exports` array emptied. That is exactly the mutant this file has to kill, so the probe is
 * not ceremony.
 */
@Injectable()
class AdminStatusScreens {
  constructor(readonly statuses: OrderStatusService) {}
}

/**
 * A stand-in for `BusinessesController` — Task 17's `GET /business/orders`, the first consumer
 * `OrdersService` itself has, and the whole reason it joined `OrderStatusService` in `exports`.
 */
@Injectable()
class BusinessOrdersScreen {
  constructor(readonly orders: OrdersService) {}
}

@Module({ imports: [OrdersModule], providers: [AdminStatusScreens, BusinessOrdersScreen] })
class SeparateAdminRepository {}

/**
 * `OrdersModule` compiled with its repository and the `DataSource` stubbed out.
 *
 * No database and no HTTP, so this stays inside `jest.config.ts`'s "unit tests only" contract while
 * exercising the one thing a hand-built controller test cannot: **whether Nest can build this graph
 * at all.** A missing `forFeature` entry or a provider left out of the module fails here rather than
 * at bootstrap in production.
 *
 * Still no `ConfigModule`, unlike `checkout.module.spec.ts` — but `WINSTON_LOGGER` is now stubbed,
 * and the reason is a real new dependency rather than test scaffolding. `OrdersModule` imports
 * `NotificationsModule` for `OrderStatusService`'s `order.shipped`/`order.delivered` queue, that
 * module imports the `@Global()` `LoggingModule` for `LoggingNotificationDriver`, and
 * `LoggingModule`'s `WINSTON_LOGGER` is a `useFactory` injecting `ConfigService` — never provided
 * in this graph. So `.compile()` eagerly building the driver failed with *"Nest can't resolve
 * dependencies of the Symbol(WINSTON_LOGGER) (?) … ConfigService at index [0]"*.
 * `rfqs.module.spec.ts` hit the identical shape when `RfqsModule` gained the same import and
 * answered it the same way: a one-line `useValue`, narrower than loading the real `ConfigModule`
 * with a placeholder environment, since nothing here asserts on what the logger does.
 */
const STUB_LOGGER = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

function compiling(): TestingModuleBuilder {
  return (
    Test.createTestingModule({
      imports: [StubDataSourceModule, SeparateAdminRepository],
    })
      .overrideProvider(getRepositoryToken(Order))
      .useValue({ find: jest.fn(), findOne: jest.fn() })
      // Plan 9.2: `AdminOrdersService` reads the payment and the shipments behind an order for the
      // detail route.
      .overrideProvider(getRepositoryToken(Payment))
      .useValue({ findOne: jest.fn() })
      .overrideProvider(getRepositoryToken(Shipment))
      .useValue({ find: jest.fn() })
      .overrideProvider(WINSTON_LOGGER)
      .useValue(STUB_LOGGER)
  );
}

describe('OrdersModule', () => {
  it('builds the read path behind GET /account/orders', async () => {
    const moduleRef = await compiling().compile();

    try {
      expect(moduleRef.get(OrdersController)).toBeInstanceOf(OrdersController);
      expect(moduleRef.get(OrdersService)).toBeInstanceOf(OrdersService);
      expect(moduleRef.get(OrderStatusService)).toBeInstanceOf(OrderStatusService);
    } finally {
      await moduleRef.close();
    }
  });

  /**
   * **The export, proved by consuming it from another module.**
   *
   * §7.1 puts the admin console in a separate repository, and its status screens are the only thing
   * that ever transitions an order. With `OrderStatusService` out of `exports`, the first of those
   * screens resolves nothing — *"Nest can't resolve dependencies of the AdminStatusScreens (?)"* —
   * and the cheapest way past that failure is a second transition table, which would be the third
   * copy of brief §33's vocabulary and the one that drifts out of step with
   * `RETAIL_TRANSITIONS`/`BULK_TRANSITIONS` and the `ck_orders_status` check constraint.
   *
   * Asserted through a consumer rather than by reading the `exports` array, so it is reachability
   * that is pinned and not a restatement of the source.
   */
  it('exports OrderStatusService, so the admin repository can transition an order', async () => {
    const moduleRef = await compiling().compile();

    try {
      expect(moduleRef.get(AdminStatusScreens).statuses).toBeInstanceOf(OrderStatusService);
    } finally {
      await moduleRef.close();
    }
  });

  /**
   * **`OrdersService`'s own export, Task 17 of the B2B plan.** `BusinessesController.listOrders`
   * (`GET /business/orders`) delegates to `OrdersService.list` rather than writing a second
   * query, which is the entire point of that route's own docblock — and delegating requires this
   * module to hand the provider out. Proved the same way `OrderStatusService`'s export is: by
   * consuming it from a probe module, since `TestingModule.get` is non-strict and would resolve
   * `OrdersService` even with the export deleted.
   */
  it('exports OrdersService too, so GET /business/orders can delegate rather than reimplement', async () => {
    const moduleRef = await compiling().compile();

    try {
      expect(moduleRef.get(BusinessOrdersScreen).orders).toBeInstanceOf(OrdersService);
    } finally {
      await moduleRef.close();
    }
  });

  /**
   * **Registered in `AppModule`, or both routes 404 with every unit test green.**
   *
   * Measured, because it is the one thing in this task that nothing else can see: with
   * `OrdersModule` removed from `AppModule`'s imports *and* its import line deleted, `typecheck` was
   * clean, `lint` was clean, and all 568 unit tests passed — including every assertion in
   * `orders.controller.spec.ts` about the routing table, because that reads the controller's own
   * metadata and a controller Nest was never told about still carries it. `GET /account/orders` would
   * answer 404 in production.
   *
   * This is the wishlist incident again: `GET /wishlist/slugs` shipped as a 404 past 349 unit and 155
   * integration tests. There, the missing piece was a `@Get` decorator, which a metadata test could
   * catch; here it is one line in a different file, and the only place to look for it is `AppModule`'s
   * own `imports` metadata. Read off Nest's metadata rather than restated, the same route
   * `orders.controller.spec.ts` takes into `PATH_METADATA`.
   *
   * Task 18's integration suite would also catch it, by requesting the route. This costs a
   * millisecond and fails with the reason attached.
   */
  it('is registered in AppModule, without which both routes 404', () => {
    const imported = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as unknown[];

    expect(imported).toContain(OrdersModule);
  });

  /**
   * The same instance the module built, not a second one.
   *
   * Re-providing `OrderStatusService` in the consumer instead of exporting it from here also
   * resolves — by constructing a second copy against a second `DataSource` injection — and is the
   * kind of wrong fix that reads as correct for years. `CartModule`'s three exports were nearly
   * fixed that way in Task 9. Two instances would not misbehave *today*, because the service holds
   * no state; the point is that "it resolves" and "it is the module's own provider" are different
   * claims, and only the second survives the service gaining a cache or a lock.
   */
  it('hands the consumer the module’s own provider rather than a second copy', async () => {
    const moduleRef = await compiling().compile();

    try {
      expect(moduleRef.get(AdminStatusScreens).statuses).toBe(moduleRef.get(OrderStatusService));
    } finally {
      await moduleRef.close();
    }
  });
});
