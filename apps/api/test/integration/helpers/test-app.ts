// Same reasoning as main.ts: money columns are bigint, and Nest's response serialiser throws
// on the first one it meets. Installed here too so a later task's first money-bearing
// integration test doesn't discover the gap on its own — see src/common/money/bigint-json.ts.
import '../../../src/common/money/bigint-json';

import type { Server } from 'node:http';
import type { INestApplication, ModuleMetadata } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import helmet from 'helmet';
import { AppModule, createHttpApplication } from '../../../src/app.module';
import type { AppConfiguration } from '../../../src/common/config/app.config';

/**
 * Boots the real application module against the test container.
 *
 * Nothing about the request pipeline is re-declared here any more, and nothing should be:
 * cookie-parser, the 1 MB body limits, request tracking and the `ValidationPipe` — including the
 * `exceptionFactory` that shapes `DomainError.details` into "keyed by field path" — are all
 * registered by `AppModule` itself, exactly as the global interceptor, filter and guard already
 * were. Importing the module is what gives the tests the production pipeline; a hand-copied
 * mirror only ever gave them a pipeline that *used* to be production's.
 *
 * Three lines are the matched pair (well, trio) called out in `main.ts`: `helmet()` is mounted at
 * the application root here too, for the same reason it is in `main.ts` — `AppModule.configure()`
 * only binds under the global prefix, so helmet living there would leave unprefixed routes with no
 * security headers at all. And `setGlobalPrefix` / `enableCors` are `INestApplication` methods
 * with no middleware equivalent, so they cannot be moved into a module either. Change one file,
 * change the other two lines to match.
 *
 * Deliberately NOT mirrored: Swagger document generation and its basic-auth guard (documentation,
 * not request handling), `enableShutdownHooks()` (process lifecycle, not HTTP behaviour), and
 * `app.listen()` (supertest drives `app.getHttpServer()` directly without binding a port).
 *
 * `metadata` is merged into the testing module beside `AppModule`, for a spec that needs a probe
 * controller to exercise the pipeline (global enhancers apply to it just the same). Production
 * code must never need it.
 */
export async function createTestApp(
  metadata: ModuleMetadata = {},
): Promise<INestApplication<Server>> {
  const moduleRef = await Test.createTestingModule({
    ...metadata,
    imports: [AppModule, ...(metadata.imports ?? [])],
  }).compile();

  // Typed explicitly as `INestApplication<Server>` rather than the default
  // `INestApplication<TServer = any>` — otherwise `getHttpServer()` returns `any`, and
  // passing that into supertest's `request()` trips `@typescript-eslint/no-unsafe-argument`.
  // `Server` (`node:http`) is one of the types supertest's `App` union already accepts, so
  // this is a real, non-widened type, not a cast to `any`. Routed through `createHttpApplication`
  // so `NEST_APPLICATION_OPTIONS` cannot be forgotten here — see the comment on that helper.
  const app = await createHttpApplication<INestApplication<Server>>((options) =>
    moduleRef.createNestApplication<INestApplication<Server>>(options),
  );
  app.use(helmet());

  const config = app.get(ConfigService);
  const appConfiguration = config.getOrThrow<AppConfiguration>('app');

  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: appConfiguration.cors.origins,
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Correlation-Id', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id', 'X-Correlation-Id'],
  });

  await app.init();
  return app;
}
