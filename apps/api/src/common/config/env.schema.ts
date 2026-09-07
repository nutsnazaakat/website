import { z } from 'zod';

/**
 * One parse-and-narrow of `process.env` at boot.
 *
 * CUG and Gateway read configuration with inline `config.get('X', 'default')` calls and a
 * few IIFE throws for must-have secrets. That works, but a typo in a rarely-read variable
 * only surfaces on the request that needs it. Parsing everything once means a misconfigured
 * service refuses to start and prints every problem together.
 *
 * This is the one place in the backend that uses zod; the DTO layer stays on class-validator.
 * zod earns its keep here specifically for cross-field refinement (rejecting a wildcard
 * `CORS_ORIGINS`), the string-to-array transform, and coercion-with-defaults, all expressed in
 * a single file whose only exported boundary type (`Env`) is a plain TS type. Do not reach for
 * zod outside this module — request/response DTOs must keep using class-validator.
 */

const trimmedBoolean = (value: unknown) => (typeof value === 'string' ? value.trim() : value);

const booleanish = z
  .preprocess(trimmedBoolean, z.enum(['true', 'false']))
  .transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4400),

  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),
  DB_SCHEMA: z.string().min(1).default('public'),
  /**
   * Off by default, matching Gateway: an unreviewed migration must never auto-apply when a
   * process restarts.
   */
  DB_MIGRATIONS_RUN: booleanish.default('false'),
  DB_SSL: booleanish.default('false'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  RAZORPAY_KEY_ID: z.string().default(''),
  RAZORPAY_KEY_SECRET: z.string().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().default(''),
  RESEND_API_KEY: z.string().default(''),
  EMAIL_FROM: z.string().default(''),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().min(2).default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_DOMAIN: z.string().default('localhost'),
  COOKIE_SECURE: booleanish.default('false'),

  CORS_ORIGINS: z
    .string()
    .min(1)
    .refine((value) => !value.split(',').some((origin) => origin.trim() === '*'), {
      message:
        'CORS_ORIGINS must not contain a wildcard: credentialed requests require an explicit allowlist',
    })
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  SWAGGER_USER: z.string().min(1),
  SWAGGER_PASSWORD: z.string().min(1),

  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug', 'verbose']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

const PLACEHOLDER_MARKER = 'replace_me';

/**
 * The password `docker-compose.yml` and `.env.example` both commit in plain text for the
 * local dev container. Anyone with repo access already knows it, which is exactly the same
 * threat shape as the placeholder `JWT_SECRET` below — so production must refuse to boot
 * with it still in place.
 */
const COMMITTED_DEV_DB_PASSWORD = 'nutwala_dev_only';

export function loadEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;
  if (Boolean(env.RAZORPAY_KEY_ID) !== Boolean(env.RAZORPAY_KEY_SECRET)) {
    throw new Error('Set both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
  }
  if (env.RAZORPAY_KEY_ID && !env.RAZORPAY_WEBHOOK_SECRET) {
    throw new Error('RAZORPAY_WEBHOOK_SECRET is required when online payments are configured');
  }
  if (env.RESEND_API_KEY && !env.EMAIL_FROM)
    throw new Error('EMAIL_FROM is required with RESEND_API_KEY');

  /**
   * **Unconditional, and deliberately not inside the production branch below.**
   *
   * `NODE_ENV` is the one variable here that cannot be trusted to say where the process is running.
   * It carries `.default('development')`, so an unset value selects the permissive branch, and
   * `load-env.ts` applies dotenv with `override: true` — correct for PM2, which re-injects a stale
   * environment on restart, but it means a `.env` file **beats platform-injected variables**. A
   * deploy that sets `NODE_ENV=production` in its process environment and ships a `.env` copied
   * from `.env.example`, whose first line is `NODE_ENV=development`, gated every assertion below on
   * the wrong answer.
   *
   * What that gated is not a weak secret but a **publicly known signing key**. The placeholder is 50
   * characters, so `min(32)` never objected; `JwtStrategy` verifies the signature and then checks
   * only that the session row is active, and `RolesGuard` reads `role` straight off the token — so
   * anyone able to read `.env.example` in this repository could sign
   * `{ sub, role: 'ADMIN', sessionId }` for a session they legitimately own and open every
   * `@Roles(UserRole.ADMIN)` route.
   *
   * Moving these two out of the branch is the smaller fix than making `NODE_ENV` required, and the
   * one that cannot break a developer or a test run: no environment legitimately runs on a value
   * whose entire purpose is to be replaced. The assertions that follow stay behind the branch
   * because each has a genuine development value — so a mis-set `NODE_ENV` still relaxes cookie
   * flags, the dev database password and localhost CORS, and that residue is recorded in
   * `docs/known-issues.md` rather than claimed closed.
   */
  if (env.JWT_SECRET.includes(PLACEHOLDER_MARKER)) {
    throw new Error(
      'JWT_SECRET is still the .env.example placeholder; generate one with `openssl rand -base64 48`',
    );
  }
  if (env.SWAGGER_PASSWORD.includes(PLACEHOLDER_MARKER)) {
    throw new Error('SWAGGER_PASSWORD is still the .env.example placeholder');
  }

  // Production-only assertions. These are not schema rules because the same schema has to
  // accept a relaxed development environment, and unlike the two placeholder checks above each of
  // these has a legitimate development value.
  if (env.NODE_ENV === 'production') {
    if (!env.COOKIE_SECURE) {
      throw new Error(
        'COOKIE_SECURE must be true in production: the session cookie carries the access token',
      );
    }
    if (env.DB_PASSWORD === COMMITTED_DEV_DB_PASSWORD) {
      throw new Error(
        'DB_PASSWORD is still the dev-only password committed in docker-compose.yml and .env.example; set a real production credential',
      );
    }
    if (env.COOKIE_DOMAIN === 'localhost') {
      throw new Error(
        'COOKIE_DOMAIN is still the localhost default: cookies would never be set for the real domain and auth would fail silently at runtime',
      );
    }
    if (env.CORS_ORIGINS.some((origin) => origin.includes('localhost'))) {
      throw new Error('CORS_ORIGINS must not contain a localhost origin in production');
    }
  }

  return env;
}
