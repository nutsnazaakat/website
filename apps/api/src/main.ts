// Must be first: dotenv override has to run before any module reads process.env.
import './load-env';
// Must precede any response serialisation, because money columns are bigint.
import './common/money/bigint-json';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import basicAuth from 'express-basic-auth';
import helmet from 'helmet';
import { AppModule, createHttpApplication } from './app.module';
import type { AppConfiguration } from './common/config/app.config';
import { WinstonLoggerService } from './common/logging/winston-logger.service';

/**
 * Bootstrap only. The request pipeline — cookie-parser, the 1 MB body limits, the
 * `ValidationPipe` with its `exceptionFactory`, request tracking — lives in `AppModule`, so the
 * integration tests exercise the real thing by importing that module instead of re-declaring it.
 * Only genuinely process-level concerns belong in this file. `helmet()` is the one exception —
 * see the comment beside it below.
 */
async function bootstrap(): Promise<void> {
  const app = await createHttpApplication((options) => NestFactory.create(AppModule, options), {
    bufferLogs: true,
  });

  // Mounted at the application root, not as `AppModule` middleware, and deliberately so:
  // `AppModule.configure()` only binds under the global prefix (`/api/v1/{*path}` and
  // `/api/v1`), so helmet living there would leave `/`, `/api-docs` and any unprefixed 404
  // without a single security header — not just a relaxed CSP, none at all. `helmet()` takes no
  // configuration in this service, so mirroring this one line here and in
  // `test/integration/helpers/test-app.ts` carries none of the drift risk that justified
  // centralising the `ValidationPipe` in `AppModule` instead: there is no config to drift.
  app.use(helmet());

  const config = app.get(ConfigService);
  const appConfiguration = config.getOrThrow<AppConfiguration>('app');

  // Transient-scoped, so resolve rather than get — same as cug.
  const logger = await app.resolve(WinstonLoggerService);
  app.useLogger(logger.setContext('Bootstrap'));

  // BEFORE FIRST DEPLOYMENT: whatever proxy, load balancer or CDN ends up in front of this
  // service, `app.set('trust proxy', <hops or predicate matching it>)` must be set to match it.
  // `ThrottlerGuard` tracks by `req.ip`; behind an untrusted proxy every request reports the
  // proxy's address, so the global 120/min collapses into one bucket shared by all callers — a
  // self-inflicted denial of service. It is deliberately NOT set here: with nothing in front,
  // trusting `X-Forwarded-For` lets any client claim a fresh IP per request and skip throttling
  // altogether, which is the worse of the two failures.

  // Kept here, and mirrored in `test/integration/helpers/test-app.ts`: both are
  // `INestApplication` calls with no middleware form, so neither can move into `AppModule`.
  // The two files are a matched pair for these two settings only — change one, change the other.
  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: appConfiguration.cors.origins,
    // Required for the session cookies to be sent at all.
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Correlation-Id', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id', 'X-Correlation-Id'],
  });

  // Docs behind basic auth, as cug does. Never exposed unauthenticated.
  app.use(
    ['/api-docs', '/api-docs-json'],
    basicAuth({
      challenge: true,
      users: { [appConfiguration.swagger.user]: appConfiguration.swagger.password },
    }),
  );

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Nuts & Nazaakat API')
      .setDescription('Storefront, account and admin API')
      .setVersion('1.0')
      .addCookieAuth('nn_access_token')
      .build(),
  );
  SwaggerModule.setup('api-docs', app, document, { jsonDocumentUrl: 'api-docs-json' });

  app.enableShutdownHooks();

  await app.listen(appConfiguration.port);
  logger.log('Backend started', {
    port: appConfiguration.port,
    env: appConfiguration.env,
    prefix: 'api/v1',
  });
}

bootstrap().catch((error: unknown) => {
  // `console.error` on purpose, not winston: if `NestFactory.create` is what threw, the DI
  // container does not exist and neither does the logger. This is the one error path in the
  // service that cannot be structured JSON; the alternative is the raw unhandled-rejection stack
  // dump Node prints, with no message of our own around it.
  console.error('Bootstrap failed', error);
  process.exit(1);
});
