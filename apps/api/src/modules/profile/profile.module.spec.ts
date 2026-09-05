import { Global, Injectable, Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../../app.module';
import { Address } from '../../entities/identity/address.entity';
import { Business } from '../../entities/identity/business.entity';
import { User } from '../../entities/identity/user.entity';
import { ProfileController } from './profile.controller';
import { ProfileModule } from './profile.module';
import { ProfileService } from './profile.service';

/**
 * `DataSource` handed to the graph, `@Global()` because that is the only way to reach it.
 *
 * `TypeOrmModule.forRoot` is what normally provides it, and it opens a real connection during
 * `app.init()`. `overrideProvider(DataSource)` cannot stand in for it either: an override replaces a
 * provider a module *declares*, and nothing here declares one. Same arrangement, and the same reason,
 * as `orders.module.spec.ts` — with one addition: `ProfileModule` and `UsersModule` each declare
 * `TypeOrmModule.forFeature([User])`, and both of those factories resolve this token, which is what
 * makes "two `forFeature`s for one entity" a second injectable token rather than a second connection.
 */
@Global()
@Module({
  providers: [{ provide: DataSource, useValue: { getRepository: jest.fn() } }],
  exports: [DataSource],
})
class StubDataSourceModule {}

/**
 * A stand-in for a future module that decided to edit a customer's profile directly.
 *
 * `@Injectable()` is load-bearing and not decoration: without a decorator TypeScript emits no
 * `design:paramtypes` for the constructor, so Nest sees a class with **no dependencies**, builds it
 * happily, and the assertion below passes whether or not the service is exported.
 */
@Injectable()
class ReachesPastTheController {
  constructor(readonly profile: ProfileService) {}
}

@Module({ imports: [ProfileModule], providers: [ReachesPastTheController] })
class SomeOtherFeature {}

/**
 * `ProfileModule` compiled with its repository and the `DataSource` stubbed out.
 *
 * No database and no HTTP, so this stays inside `jest.config.ts`'s "unit tests only" contract while
 * exercising the one thing a hand-built controller test cannot: **whether Nest can build this graph at
 * all.** `ProfileService` has two dependencies that come from two different places — an
 * `@InjectRepository(User)` token from this module's own `forFeature`, and `UsersService` from an
 * imported module's `exports` — so either half being wrong fails here rather than at bootstrap in
 * production, where the symptom is the whole application refusing to start.
 */
function compiling(): TestingModuleBuilder {
  return (
    Test.createTestingModule({ imports: [StubDataSourceModule, ProfileModule] })
      .overrideProvider(getRepositoryToken(User))
      .useValue({ update: jest.fn(), findOne: jest.fn() })
      /**
       * Reached through `UsersModule`, which this module imports for `UsersService`. Plan 9.3 added
       * both entities to that module's `forFeature` so `AdminCustomersService` can answer brief
       * §35's address book and business record — and an unoverridden `forFeature` token resolves
       * its repository off the stub `DataSource`, which has no connection to build one from.
       */
      .overrideProvider(getRepositoryToken(Business))
      .useValue({ findOne: jest.fn() })
      .overrideProvider(getRepositoryToken(Address))
      .useValue({ find: jest.fn() })
  );
}

describe('ProfileModule', () => {
  it('builds the profile behind its two routes', async () => {
    const moduleRef = await compiling().compile();

    try {
      expect(moduleRef.get(ProfileController)).toBeInstanceOf(ProfileController);
      expect(moduleRef.get(ProfileService)).toBeInstanceOf(ProfileService);
    } finally {
      await moduleRef.close();
    }
  });

  /**
   * **Registered in `AppModule`, or both routes 404 with every unit test green.**
   *
   * This is the wishlist incident, then the orders one, then the addresses one: with the module
   * written, wired and fully specced but absent from `AppModule`'s `imports`, `typecheck` is clean,
   * `lint` is clean, every unit test passes — including this file's sibling routing-table assertions,
   * because those read the controller's own metadata and a controller Nest was never told about still
   * carries it — and `GET /account/profile` answers 404 in production. The only place to look is
   * `AppModule`'s own metadata, so that is what this reads.
   */
  it('is registered in AppModule, without which both routes 404', () => {
    const imported = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as unknown[];

    expect(imported).toContain(ProfileModule);
  });

  /**
   * **Nothing is exported, and that is a decision rather than an omission.**
   *
   * No other module reads or writes a customer's profile: `AuthModule` reaches the same row through
   * `UsersService`, which it already imports, and the admin console is §7.1's separate application. An
   * export nothing imports is an invitation to reach past the controller and its `@CurrentUser()`
   * scoping, which is the only thing making this row the caller's own.
   *
   * Asserted by *consuming* it from another module rather than by reading the `exports` array, because
   * `TestingModule.get` is non-strict by default and reaches an imported module's private providers —
   * a bare `get(ProfileService)` passes either way, which is why `orders.module.spec.ts` proves its own
   * export the same way round.
   */
  it('keeps the service unreachable from another module', async () => {
    await expect(
      Test.createTestingModule({ imports: [StubDataSourceModule, SomeOtherFeature] })
        .overrideProvider(getRepositoryToken(User))
        .useValue({ update: jest.fn(), findOne: jest.fn() })
        .compile(),
    ).rejects.toThrow(/ReachesPastTheController/);
  });
});
