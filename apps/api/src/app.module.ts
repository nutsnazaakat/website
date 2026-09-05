import {
  HttpException,
  HttpStatus,
  Module,
  ValidationPipe,
  type INestApplication,
  type MiddlewareConsumer,
  type NestApplicationOptions,
  type NestModule,
  type ValidationPipeOptions,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { ValidationError } from 'class-validator';
import cookieParser from 'cookie-parser';
import { json, urlencoded, type RequestHandler } from 'express';
import { appConfig, type AppConfiguration } from './common/config/app.config';
import { CsrfBootstrapMiddleware } from './common/auth/csrf-bootstrap.middleware';
import { CsrfGuard } from './common/auth/csrf.guard';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { RolesGuard } from './common/auth/roles.guard';
import { DomainError } from './common/errors/domain-error';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { LoggingModule } from './common/logging/logging.module';
import { RequestTrackingMiddleware } from './common/middleware/request-tracking.middleware';
import { PostgresVersionAssertionService } from './common/db/postgres-version-assertion.service';
import { buildTypeOrmOptions } from './database/typeorm.options';
import { AddressesModule } from './modules/addresses/addresses.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { BusinessesModule } from './modules/business/businesses.module';
import { CartModule } from './modules/cart/cart.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CheckoutModule } from './modules/checkout/checkout.module';
import { ContentModule } from './modules/content/content.module';
import { CouponsModule } from './modules/coupons/coupons.module';
import { HealthModule } from './modules/health/health.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { ProfileModule } from './modules/profile/profile.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { RfqsModule } from './modules/rfqs/rfqs.module';
import { SettingsModule } from './modules/settings/settings.module';
import { SupportTicketsModule } from './modules/support-tickets/support-tickets.module';
import { UsersModule } from './modules/users/users.module';
import { WishlistModule } from './modules/wishlist/wishlist.module';

/** 1 MB cap so an oversized payload is rejected before it reaches a handler. Spec §13. */
const BODY_LIMIT = '1mb';

/**
 * Preserves the HTTP status body-parser puts on its own failures.
 *
 * body-parser rejects an oversized or malformed payload with a plain `Error` carrying a numeric
 * `status` — 413 for over the limit, 400 for broken JSON. Mounted with `app.use()` that error
 * reached Express's final handler, which honours `err.status` and answers 413 as HTML. Mounted as
 * module middleware it reaches `GlobalExceptionFilter` instead, and the filter treats anything that
 * is not an `HttpException` as a 500 — so without this translation, moving the parsers into the
 * module would turn every oversized upload into "Internal server error", logged at error level with
 * a stack. Wrapping keeps the status and returns it inside the standard error envelope.
 */
function preservingStatus(parser: RequestHandler): RequestHandler {
  return (req, res, next) =>
    parser(req, res, (error?: unknown) => {
      if (
        error instanceof Error &&
        !(error instanceof HttpException) &&
        'status' in error &&
        typeof error.status === 'number'
      ) {
        // `cause` keeps the original error, and its stack, attached to the exception for direct
        // inspection — not currently logged: `GlobalExceptionFilter` only attaches the exception to
        // the log entry on its >=500 branch, and every status body-parser raises here (413, 400)
        // is 4xx, so nothing reads this back out today.
        next(new HttpException(error.message, error.status, { cause: error }));
        return;
      }
      next(error);
    });
}

/**
 * Options every entry point must create the application with — `main.ts` in production and
 * `test/integration/helpers/test-app.ts` under Jest.
 *
 * `bodyParser: false` is load-bearing, not a preference. platform-express registers its own
 * `json`/`urlencoded` parsers during `app.init()` — with body-parser's default 100 kB limit and
 * *before* module middleware is bound. body-parser skips a request whose body another parser
 * already read, so whichever parser is registered first wins: leaving the platform default on
 * would silently demote the 1 MB limit to 100 kB. Exported from here rather than copied
 * into each caller so the coupling cannot drift.
 */
export const NEST_APPLICATION_OPTIONS: NestApplicationOptions = { bodyParser: false };

/**
 * The one call each entry point makes to produce its `INestApplication` — `NestFactory.create` in
 * `main.ts`, `moduleRef.createNestApplication` in the test harness — differ in what builds the app,
 * not in what it must be built with. Routing both through this helper, instead of asking each call
 * site to remember `...NEST_APPLICATION_OPTIONS`, makes forgetting it impossible rather than merely
 * reviewable: `create` only ever receives the merged options, so there is no path to a bare
 * `NestFactory.create(AppModule, someOtherOptions)` that quietly drops `bodyParser: false` and lets
 * platform-express's own 100 kB parsers win — silently, and only for payloads between 100 kB and
 * the configured 1 MB, so a code-review pass over a diff that "looks right" would not catch it.
 *
 * `extraOptions` layers over `NEST_APPLICATION_OPTIONS`, not the other way round: `main.ts` needs
 * `bufferLogs: true`, which has nothing to do with the coupling this guards against, so a caller is
 * free to add to the merged options. `bodyParser` is not something either entry point has a
 * legitimate reason to override, so nothing here lets a caller win a conflict on that key.
 *
 * `create` may return synchronously or asynchronously — `NestFactory.create` is async,
 * `moduleRef.createNestApplication` is not — so both entry points can pass their own call as-is.
 */
export async function createHttpApplication<T extends INestApplication>(
  create: (options: NestApplicationOptions) => T | Promise<T>,
  extraOptions: NestApplicationOptions = {},
): Promise<T> {
  return create({ ...NEST_APPLICATION_OPTIONS, ...extraOptions });
}

/**
 * Turns class-validator's `ValidationError[]` into a `DomainError` whose `details` is
 * `field -> messages`, nested properties reached by dotted path.
 *
 * Without it, Nest collapses every validation failure into one flat `message: string[]`, so
 * `ApiError.details` — documented as "keyed by field path" — would only ever carry a single
 * `_errors` bucket. That is the shape every client integration gets written against, and changing
 * it later is a breaking change, so it has to be right the first time.
 *
 * Exported so it can be asserted on directly. The cases HTTP can reach are covered by
 * `test/integration/request-pipeline.integration.spec.ts`; the constraint-less node below is not
 * reachable through a request with the validators this service uses today.
 */
export function validationExceptionFactory(errors: ValidationError[]): DomainError {
  const details: Record<string, string[]> = {};

  const collect = (list: ValidationError[], prefix = ''): void => {
    for (const error of list) {
      const path = prefix ? `${prefix}.${error.property}` : error.property;
      const messages = Object.values(error.constraints ?? {});
      const children = error.children ?? [];

      if (messages.length > 0) {
        details[path] = messages;
      } else if (children.length === 0) {
        // Neither constraints nor children, which a custom validator or a group-scoped one can
        // produce. Without this branch the property would be dropped from `details` entirely, so
        // a client honouring the "keyed by field path" contract could not tell which field was
        // rejected — the guarantee failing for precisely the field that failed.
        details[path] = ['Invalid value'];
      }

      if (children.length > 0) collect(children, path);
    }
  };

  collect(errors);
  return new DomainError('VALIDATION_FAILED', 'Validation failed', HttpStatus.BAD_REQUEST, details);
}

/**
 * The global `ValidationPipe`'s options, exported so a DTO spec can validate through the pipe
 * production really runs rather than through a hand-rolled copy of these five settings.
 *
 * Without the export, such a spec builds its own `ValidationPipe` and asserts a DTO's decorators
 * against *its own* configuration — so a `skipMissingProperties` added here, or a dropped
 * `forbidNonWhitelisted`, would leave every one of those tests green while the server accepted what
 * they claim it rejects. `validationExceptionFactory` above is exported for the same reason and is
 * already read back by `request-pipeline.integration.spec.ts`.
 *
 * `whitelist` strips unknown properties and `forbidNonWhitelisted` rejects them outright — together
 * they are the mass-assignment defence from spec §13. `enableImplicitConversion: false` is why every
 * numeric and boolean query parameter in this service carries an explicit `@Transform`: nothing else
 * coerces a query string.
 */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
  exceptionFactory: validationExceptionFactory,
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      // `load-env.ts` has already applied dotenv with override, so ConfigModule must not
      // re-read a file and undo it.
      ignoreEnvFile: true,
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildTypeOrmOptions(config.getOrThrow<AppConfiguration>('app')),
    }),
    // Baseline limit for every route. `AuthController` tightens this per-route with `@Throttle`
    // against this same `default` named throttler — 3/hour on register, 5/15min on login,
    // 10/min on refresh — which only takes effect because `ThrottlerGuard` below is global.
    ThrottlerModule.forRoot({
      /**
       * The object form, not the bare array, because `errorMessage` only exists here — on
       * `ThrottlerModuleOptions` — and not on an individual `ThrottlerOptions` entry.
       *
       * Overridden because the library's default message is the literal string
       * `'ThrottlerException: Too Many Requests'`, and the sign-in and registration forms render
       * `error.message` straight into the page. A shopper who mistyped their password five times
       * would have been shown a class name.
       *
       * The message has to carry its own advice, because a 429 envelope has no machine-readable
       * `code` — `ThrottlerException` is not a `DomainError` — so a client cannot branch on it to
       * supply better wording of its own.
       */
      errorMessage: 'Too many attempts. Please wait a few minutes and try again.',
      throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
    }),
    LoggingModule,
    HealthModule,
    AddressesModule,
    AdminModule,
    AuthModule,
    BusinessesModule,
    CartModule,
    CatalogModule,
    CheckoutModule,
    ContentModule,
    CouponsModule,
    InventoryModule,
    NotificationsModule,
    OrdersModule,
    // New in plan 9.3, for brief §31's `/admin/pricing-tiers`. `modules/pricing/` held only
    // `pricing.resolver.ts` before — plain functions its four call sites import directly, which
    // needed no module and still do not.
    PricingModule,
    ProfileModule,
    ReviewsModule,
    RfqsModule,
    // Imported here as well as by `CheckoutModule`, so its two controllers are registered by a
    // module the application composes directly rather than reaching them through a consumer's
    // import graph — the routes exist either way, but the wiring says what they belong to.
    SettingsModule,
    SupportTicketsModule,
    // Listed explicitly as of plan 9.3, when it gained its first controller. It was reachable only
    // through `AuthModule` and `ProfileModule` before, which registers its providers correctly and
    // its routes by accident — a module whose HTTP surface depends on somebody else's `imports`
    // line is one refactor away from its routes silently disappearing.
    UsersModule,
    WishlistModule,
  ],
  providers: [
    PostgresVersionAssertionService,
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    /**
     * Array order is execution order for same-kind enhancers, and all four orderings here are
     * load-bearing rather than tidy.
     *
     * `ThrottlerGuard` is first so a flood is refused before anything expensive happens — and
     * being global is what makes `AuthController`'s per-route `@Throttle` limits real. A
     * `@Throttle()` with no `ThrottlerGuard` reaching the route is decoration, and it looks
     * identical from the outside.
     *
     * `CsrfGuard` precedes `JwtAuthGuard` so a forged request is rejected without spending the
     * session lookup. The visible consequence is that an unauthenticated state-changing request
     * with no CSRF token answers 403 rather than 401 — the cheaper rejection, and it leaks less.
     *
     * `RolesGuard` follows `JwtAuthGuard`, because it reads the `request.user` that the JWT guard
     * is what puts there; ahead of it, it would have no role to check and every `@Roles()` route
     * would 403.
     *
     * `CookieService.issue()` runs only in login, register and refresh, so for a long time
     * `nn_csrf` existed only for clients that had authenticated, and **every state-changing request
     * from an anonymous visitor was refused**. That was survivable while the only public POSTs were
     * the three carrying `@SkipCsrf()`; the guest cart made it fatal. `CsrfBootstrapMiddleware`,
     * registered in `configure()` below, now issues the cookie to anonymous visitors too — the
     * normal way a double-submit is bootstrapped, and deliberately *not* a growing `@SkipCsrf()`
     * exemption list. Plan 3's contact form, RFQ submission and newsletter signup are covered by
     * the same middleware.
     *
     * It narrows the window rather than closing it, and that is correct: the cookie is set on the
     * *response*, so a client's very first request — having had nothing to echo — is still refused.
     * A guard that accepted a pair it had just issued would hand the same pair to a cross-site POST.
     */
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    /**
     * The request pipeline lives here, beside the interceptor, filter and guard, rather than in
     * `main.ts`. `main.ts` is not loaded by the integration tests, so anything configured there
     * is untested — and the `exceptionFactory` used below had to be hand-copied into the test harness
     * to compensate, which is how the tests end up asserting a validation shape production no
     * longer returns.
     */
    { provide: APP_PIPE, useValue: new ValidationPipe(VALIDATION_PIPE_OPTIONS) },
  ],
})
export class AppModule implements NestModule {
  /**
   * Plain Express middleware is accepted here alongside Nest's `NestMiddleware` classes, so the
   * whole pipeline is declared in one ordered list instead of half of it living in `main.ts`.
   *
   * Order is the order of the arguments, and it matters three times over. Bodies and cookies must
   * be parsed before any guard, interceptor or handler reads `req.body` or `req.cookies`.
   * `CsrfBootstrapMiddleware` must sit **after `cookieParser()`** — it decides whether to mint a
   * token by reading `request.cookies`, which does not exist before that, so ahead of the parser it
   * would see no cookie on any request and rotate every visitor's token on every request, turning
   * each subsequent write from a signed-in customer into a 403. It sits before the body parsers
   * because it needs nothing from the body. And request
   * tracking goes first, ahead of the parsers, even though `main.ts` used to install it last: it
   * reads only the method, URL and headers, so nothing it needs is parsed yet, and running it first
   * is what puts a request id on a body-parser failure. Behind the parsers, a rejected 1 MB upload
   * was logged and returned with `requestId: "unknown"` — untraceable, in the one case where the
   * caller most wants to be told which request was dropped.
   *
   * One consequence worth knowing: middleware registered here is mounted under the global
   * prefix (`/api/v1/{*path}` plus `/api/v1` itself), not at the server root the way `app.use()`
   * mounted it. Every request this service actually handles is under that prefix, so nothing here
   * needs to reach further than that.
   *
   * `helmet()` is deliberately NOT in this list, even though it is middleware and everything else
   * here is. Mounted here it would inherit the same prefix scoping, and that would silently strip
   * every security header from `/`, `/api-docs` and any unprefixed 404 — a routing side effect,
   * not a design choice, and one with no offsetting benefit for those routes. It is mounted
   * instead at the application root in `main.ts` (and mirrored in
   * `test/integration/helpers/test-app.ts`); see the comment there.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(
        RequestTrackingMiddleware,
        cookieParser(),
        CsrfBootstrapMiddleware,
        preservingStatus(json({ limit: BODY_LIMIT })),
        preservingStatus(urlencoded({ extended: true, limit: BODY_LIMIT })),
      )
      // `'/{*path}'` and not `'*'`: both match every path under the prefix, but `'*'` is
      // Express 4 syntax that Nest only rewrites after logging `Unsupported route path`, and a
      // boot log full of noise is how a real warning gets missed.
      .forRoutes('/{*path}');
  }
}
