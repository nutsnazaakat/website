import { registerAs } from '@nestjs/config';
import { loadEnv, type Env } from './env.schema';

/**
 * Typed configuration, grouped the way CUG groups its `AppConfig`. Read it with
 * `configService.get<AppConfiguration>('app')` and destructure — never reach for
 * `process.env` outside this module.
 *
 * Never log or serialise this object directly — `auth.jwtSecret` and `database.password` are
 * secrets. Route it through `redact()` (`src/common/logging/pii-redactor.ts`) if you must log
 * it as a whole; today nothing does, and the redactor's key-name matching already catches
 * both fields, but that is "safe today", not "safe by construction".
 */
export interface AppConfiguration {
  env: Env['NODE_ENV'];
  port: number;
  isProduction: boolean;
  database: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    schema: string;
    migrationsRun: boolean;
  };
  auth: {
    jwtSecret: string;
    accessTokenTtl: string;
    refreshTokenTtlDays: number;
    cookieDomain: string;
    cookieSecure: boolean;
  };
  cors: { origins: string[] };
  swagger: { user: string; password: string };
  logging: { level: Env['LOG_LEVEL'] };
}

export const APP_CONFIG_KEY = 'app';

export const appConfig = registerAs(APP_CONFIG_KEY, (): AppConfiguration => {
  const env = loadEnv();

  return {
    env: env.NODE_ENV,
    port: env.PORT,
    isProduction: env.NODE_ENV === 'production',
    database: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      username: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      schema: env.DB_SCHEMA,
      migrationsRun: env.DB_MIGRATIONS_RUN,
    },
    auth: {
      jwtSecret: env.JWT_SECRET,
      accessTokenTtl: env.ACCESS_TOKEN_TTL,
      refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
      cookieDomain: env.COOKIE_DOMAIN,
      cookieSecure: env.COOKIE_SECURE,
    },
    cors: { origins: env.CORS_ORIGINS },
    swagger: { user: env.SWAGGER_USER, password: env.SWAGGER_PASSWORD },
    logging: { level: env.LOG_LEVEL },
  };
});
