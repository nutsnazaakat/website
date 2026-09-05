import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { appConfig } from '../../common/config/app.config';
import { Product } from '../../entities/catalog/product.entity';
import { ProductVariant } from '../../entities/catalog/product-variant.entity';
import { CartItem } from '../../entities/commerce/cart-item.entity';
import { Cart } from '../../entities/commerce/cart.entity';
import { CouponRedemption } from '../../entities/commerce/coupon-redemption.entity';
import { Coupon } from '../../entities/commerce/coupon.entity';
import { Order } from '../../entities/commerce/order.entity';
import { ServiceablePincode } from '../../entities/commerce/serviceable-pincode.entity';
import { Business } from '../../entities/identity/business.entity';
import { IdempotencyKey } from '../../entities/ops/idempotency-key.entity';
import { Setting } from '../../entities/ops/setting.entity';
import { CartPricingService } from '../cart/cart-pricing.service';
import { CartReadService } from '../cart/cart-read.service';
import { CartService } from '../cart/cart.service';
import { SettingsService } from '../settings/settings.service';
import { CheckoutIdempotencyInterceptor } from './checkout-idempotency.interceptor';
import { CheckoutController } from './checkout.controller';
import { CheckoutModule } from './checkout.module';
import { CheckoutService } from './checkout.service';

/**
 * Every entity any module in this graph asks a repository for. Listed rather than derived, so adding
 * an injected repository without adding it to a `forFeature` shows up here as a resolution failure
 * instead of at boot in production.
 */
const ENTITIES = [
  Coupon,
  CouponRedemption,
  Order,
  ServiceablePincode,
  IdempotencyKey,
  Cart,
  CartItem,
  Product,
  ProductVariant,
  Setting,
  Business,
];

/**
 * `DataSource` handed to the whole graph, `@Global()` because that is the only way to reach it.
 *
 * `TypeOrmModule.forRoot` is what normally provides it, and it opens a real connection during
 * `app.init()`. `overrideProvider(DataSource)` cannot stand in for it either: an override replaces a
 * provider that a module declares, and nothing in this graph declares one — `CartService` and
 * `CheckoutService` merely inject it. Verified by the failure it produced: *"Nest can't resolve
 * dependencies of the CartService (CartRepository, ProductRepository, ProductVariantRepository, ?)
 * … argument DataSource at index [3]"*.
 */
@Global()
@Module({
  providers: [{ provide: DataSource, useValue: { transaction: jest.fn() } }],
  exports: [DataSource],
})
class StubDataSourceModule {}

/**
 * `CheckoutModule` compiled with every repository and the `DataSource` stubbed out.
 *
 * No database and no HTTP, so this stays inside `jest.config.ts`'s "unit tests only" contract while
 * still exercising the one thing a hand-built controller test cannot: **whether Nest can actually
 * build this graph.** Every collaborator is resolved through the real `@Module` metadata — the real
 * `CartModule` and `SettingsModule` imports included — so a missing export or a missing `forFeature`
 * entry fails here rather than at bootstrap.
 */
function compiling(): TestingModuleBuilder {
  let builder: TestingModuleBuilder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [appConfig], ignoreEnvFile: true }),
      StubDataSourceModule,
      CheckoutModule,
    ],
  });

  for (const entity of ENTITIES) {
    builder = builder.overrideProvider(getRepositoryToken(entity)).useValue({ find: jest.fn() });
  }

  return builder;
}

describe('CheckoutModule', () => {
  /**
   * `test/setup.ts` sets only `NODE_ENV` and `JWT_SECRET`, but `appConfig` parses the whole
   * environment in one pass and refuses to boot on a missing variable — and `CartController`, which
   * this graph instantiates, injects `ConfigService`. Placeholders: no connection is ever opened,
   * because every repository and the `DataSource` are overridden. Same arrangement as
   * `sessions.service.spec.ts`'s module test.
   */
  const PLACEHOLDER_ENV: Record<string, string> = {
    DB_HOST: 'localhost',
    DB_USER: 'unit',
    DB_PASSWORD: 'unit',
    DB_NAME: 'unit',
    CORS_ORIGINS: 'http://localhost:5173',
    SWAGGER_USER: 'docs',
    SWAGGER_PASSWORD: 'docs',
    LOG_LEVEL: 'error',
  };
  const saved = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const [key, value] of Object.entries(PLACEHOLDER_ENV)) {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    }
  });

  // Restored, because Jest workers share one `process.env` across every spec file they run.
  afterAll(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /**
   * The two wiring corrections this task had to make, both of which would otherwise stop the
   * application at bootstrap — and neither of which any other test in this repository can see.
   *
   * `CartModule` provides `CartService`, `CartReadService` and `CartPricingService` but its `exports`
   * array held **`CartService` alone**, while `CheckoutService`'s constructor takes all three. So
   * importing `CartModule` resolved one of the three and Nest refused to start on the other two. The
   * fix is two entries in `CartModule`'s `exports` — *not* re-providing them here, which also
   * resolves, by creating a second instance of each, and is the kind of wrong fix that reads as
   * correct for years.
   *
   * And there is no `OrdersModule` to import: it is Task 17's, and `order.mapper.ts` exports plain
   * functions rather than a provider, so `toAccountOrder` needs no module at all.
   */
  it('compiles, so both cart collaborators are genuinely exported', async () => {
    const moduleRef = await compiling().compile();

    try {
      expect(moduleRef.get(CheckoutService)).toBeInstanceOf(CheckoutService);
      expect(moduleRef.get(CheckoutController)).toBeInstanceOf(CheckoutController);
      // Resolved through `CartModule`'s exports. `strict: false` by default, so `get` reaches into
      // the imported module — which is exactly the reachability being asserted.
      expect(moduleRef.get(CartService)).toBeInstanceOf(CartService);
      expect(moduleRef.get(CartReadService)).toBeInstanceOf(CartReadService);
      expect(moduleRef.get(CartPricingService)).toBeInstanceOf(CartPricingService);
      expect(moduleRef.get(SettingsService)).toBeInstanceOf(SettingsService);
    } finally {
      await moduleRef.close();
    }
  });

  /**
   * **The interceptor resolves.** This is the assertion the `INTERCEPTORS_METADATA` test in
   * `checkout.controller.spec.ts` cannot make, and the failure mode it protects against is silent:
   * `InterceptorsContextCreator.getInterceptorInstance` looks the class up in the hosting module and
   * returns `null` when it is not there, and `createConcreteContext` then **filters the null out**.
   * A `CheckoutIdempotencyInterceptor` whose `IdempotencyKey` repository could not be resolved would
   * therefore be dropped from the route with no error anywhere — leaving `POST /checkout/orders`
   * non-idempotent, a double-click placing two orders, and the route's decorator still present for
   * the metadata test to find.
   *
   * `IdempotencyKey` being in this module's `forFeature` is the whole of what makes it resolvable,
   * and that is one line nothing else in the repository reads.
   */
  it('can build the idempotency interceptor placement depends on', async () => {
    const moduleRef = await compiling().compile();

    try {
      expect(moduleRef.get(CheckoutIdempotencyInterceptor)).toBeInstanceOf(
        CheckoutIdempotencyInterceptor,
      );
    } finally {
      await moduleRef.close();
    }
  });
});
