import { Global, Injectable, Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../app.module';
import { AddressesController } from './addresses.controller';
import { AddressesModule } from './addresses.module';
import { AddressesService } from './addresses.service';

/**
 * `DataSource` handed to the graph, `@Global()` because that is the only way to reach it.
 *
 * In production `TypeOrmModule.forRoot`'s core module is `@Global()` and provides it, which is why
 * `AddressesModule` imports nothing. Here that module would open a real connection during
 * `app.init()`, and `overrideProvider(DataSource)` cannot stand in for it either: an override replaces
 * a provider a module *declares*, and nothing in this graph declares one — `AddressesService` merely
 * injects it. Same arrangement, and the same reason, as `orders.module.spec.ts`.
 */
@Global()
@Module({
  providers: [
    { provide: DataSource, useValue: { transaction: jest.fn(), getRepository: jest.fn() } },
  ],
  exports: [DataSource],
})
class StubDataSourceModule {}

/**
 * `AddressesModule` compiled with the `DataSource` stubbed out.
 *
 * No database and no HTTP, so this stays inside `jest.config.ts`'s "unit tests only" contract while
 * exercising the one thing a hand-built controller test cannot: **whether Nest can build this graph at
 * all.** A provider left out of the module, or a constructor that gains an `@InjectRepository(Address)`
 * without a matching `TypeOrmModule.forFeature([Address])`, fails here rather than at bootstrap in
 * production — where the symptom is the whole application refusing to start.
 */
function compiling(): TestingModuleBuilder {
  return Test.createTestingModule({ imports: [StubDataSourceModule, AddressesModule] });
}

/**
 * A stand-in for a future module that decided to read the address book directly.
 *
 * `@Injectable()` is load-bearing and not decoration: without a decorator TypeScript emits no
 * `design:paramtypes` for the constructor, so Nest sees a class with **no dependencies**, builds it
 * happily, and the assertion below passes whether or not the service is exported.
 */
@Injectable()
class ReachesPastTheController {
  constructor(readonly addresses: AddressesService) {}
}

@Module({ imports: [AddressesModule], providers: [ReachesPastTheController] })
class SomeOtherFeature {}

describe('AddressesModule', () => {
  it('builds the address book behind its five routes', async () => {
    const moduleRef = await compiling().compile();

    try {
      expect(moduleRef.get(AddressesController)).toBeInstanceOf(AddressesController);
      expect(moduleRef.get(AddressesService)).toBeInstanceOf(AddressesService);
    } finally {
      await moduleRef.close();
    }
  });

  /**
   * **Registered in `AppModule`, or all five routes 404 with every unit test green.**
   *
   * This is the wishlist incident and then the orders one again: with the module written, wired and
   * fully specced but absent from `AppModule`'s `imports`, `typecheck` is clean, `lint` is clean, every
   * unit test passes — including this file's routing-table assertions, because those read the
   * controller's own metadata and a controller Nest was never told about still carries it — and
   * `GET /account/addresses` answers 404 in production. The only place to look is `AppModule`'s own
   * metadata, so that is what this reads.
   */
  it('is registered in AppModule, without which all five routes 404', () => {
    const imported = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as unknown[];

    expect(imported).toContain(AddressesModule);
  });

  /**
   * **Nothing is exported, and that is a decision rather than an omission.**
   *
   * No other module reads a customer's address book: checkout takes its address from the request body
   * and snapshots it — `address.entity.ts` says orders never reference this table — and the admin
   * console is §7.1's separate application. An export nothing imports is an invitation to reach past
   * the controller and its `@CurrentUser()` scoping, which is the whole IDOR defence here, so a
   * consumer that resolves `AddressesService` from outside must fail to compile.
   *
   * Asserted by *consuming* it from another module rather than by reading the `exports` array, because
   * `TestingModule.get` is non-strict by default and reaches an imported module's private providers —
   * a bare `get(AddressesService)` passes either way, which is why `orders.module.spec.ts` proves its
   * own export the same way round.
   */
  it('keeps the service unreachable from another module', async () => {
    await expect(
      Test.createTestingModule({ imports: [StubDataSourceModule, SomeOtherFeature] }).compile(),
    ).rejects.toThrow(/ReachesPastTheController/);
  });
});
