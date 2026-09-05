import { loadEnv } from './env.schema';

const valid = {
  NODE_ENV: 'development',
  DB_HOST: 'localhost',
  DB_USER: 'nutwala',
  DB_PASSWORD: 'nutwala_dev_only',
  DB_NAME: 'nutwala',
  JWT_SECRET: 'a'.repeat(48),
  CORS_ORIGINS: 'http://localhost:5173',
  SWAGGER_USER: 'docs',
  SWAGGER_PASSWORD: 'docs',
};

describe('loadEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(4400);
    expect(env.DB_PORT).toBe(5432);
    expect(env.DB_SCHEMA).toBe('public');
    expect(env.DB_MIGRATIONS_RUN).toBe(false);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('coerces numeric strings', () => {
    const env = loadEnv({ ...valid, PORT: '4100', DB_PORT: '5433' });
    expect(env.PORT).toBe(4100);
    expect(env.DB_PORT).toBe(5433);
  });

  it('splits CORS origins into a list', () => {
    const env = loadEnv({ ...valid, CORS_ORIGINS: 'http://a.test, http://b.test' });
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('reports every problem at once rather than the first', () => {
    expect(() => loadEnv({ NODE_ENV: 'development' })).toThrow(/DB_HOST/);
    try {
      loadEnv({ NODE_ENV: 'development' });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/DB_HOST/);
      expect(message).toMatch(/JWT_SECRET/);
      expect(message).toMatch(/SWAGGER_PASSWORD/);
    }
  });

  it('rejects a short JWT secret', () => {
    expect(() => loadEnv({ ...valid, JWT_SECRET: 'too-short' })).toThrow(/32 characters/);
  });

  it('refuses the .env.example placeholder secret in production', () => {
    expect(() =>
      loadEnv({
        ...valid,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        JWT_SECRET: 'replace_me_min_32_chars_generate_with_openssl_rand',
      }),
    ).toThrow(/placeholder/i);
  });

  it('requires secure cookies in production', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(
      /COOKIE_SECURE/,
    );
  });

  it('rejects a wildcard CORS origin, which cannot carry credentials anyway', () => {
    expect(() => loadEnv({ ...valid, CORS_ORIGINS: '*' })).toThrow(/wildcard/i);
  });

  it('rejects the committed dev database password in production', () => {
    expect(() =>
      loadEnv({
        ...valid,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
      }),
    ).toThrow(/DB_PASSWORD/);
  });

  it('rejects COOKIE_DOMAIN=localhost in production', () => {
    expect(() =>
      loadEnv({
        ...valid,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        DB_PASSWORD: 'a-real-production-password',
      }),
    ).toThrow(/COOKIE_DOMAIN/);
  });

  it('rejects a localhost CORS origin in production', () => {
    expect(() =>
      loadEnv({
        ...valid,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        DB_PASSWORD: 'a-real-production-password',
        COOKIE_DOMAIN: 'app.nutwala.com',
      }),
    ).toThrow(/CORS_ORIGINS|localhost/);
  });

  it('tolerates a trailing space on a booleanish field', () => {
    const env = loadEnv({ ...valid, DB_MIGRATIONS_RUN: 'true ' });
    expect(env.DB_MIGRATIONS_RUN).toBe(true);
  });

  /**
   * **The placeholder credentials are refused in every environment, not only in production**, and
   * the reason is that `NODE_ENV` is the one variable in this schema that cannot be trusted to say
   * where the process is running.
   *
   * It carries `.default('development')`, so an unset `NODE_ENV` selects the permissive branch — and
   * `load-env.ts` applies dotenv with `override: true`, which is deliberate (PM2 re-injects a stale
   * environment on restart) but means a `.env` file **beats platform-injected variables**. A deploy
   * that correctly sets `NODE_ENV=production` in its process environment, and ships a `.env` copied
   * from `.env.example` whose first line is `NODE_ENV=development`, therefore booted happily on the
   * committed placeholder `JWT_SECRET`.
   *
   * That is not a weak-secret problem, it is a **publicly known signing key**. `JwtStrategy`
   * verifies the signature and then only checks that the session row is active, and `RolesGuard`
   * reads `role` straight off the token — so anyone who can read `.env.example` in this repository
   * could mint `{ sub, role: 'ADMIN', sessionId }` for their own live session and open every
   * `@Roles(UserRole.ADMIN)` route. The placeholder is 50 characters, so `min(32)` never objected.
   *
   * These two checks move out of the production branch rather than `NODE_ENV` becoming required,
   * which is the smaller change and the one that cannot break a developer or a test run: nobody
   * legitimately runs *any* environment on a value whose whole purpose is to be replaced. The
   * remaining production-only assertions (`COOKIE_SECURE`, `COOKIE_DOMAIN`, `DB_PASSWORD`,
   * localhost CORS) genuinely have valid development values and must stay behind the branch — so
   * the residual exposure from a mis-set `NODE_ENV` is recorded in `docs/known-issues.md` rather
   * than claimed closed.
   */
  describe('placeholder credentials are refused regardless of NODE_ENV', () => {
    const PLACEHOLDER_JWT_SECRET = 'replace_me_min_32_chars_generate_with_openssl_rand';

    /**
     * `valid` with `NODE_ENV` genuinely absent — not set to `undefined`, which zod's `.default()`
     * treats identically but a reader might not. Built by omission rather than by destructuring
     * into an unused binding, which lint rightly objects to.
     */
    const withoutNodeEnv = (): Record<string, string | undefined> =>
      Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'NODE_ENV'));

    it('is long enough to pass min(32), which is why the marker check has to exist', () => {
      expect(PLACEHOLDER_JWT_SECRET.length).toBeGreaterThanOrEqual(32);
    });

    it('refuses the placeholder JWT_SECRET in development', () => {
      expect(() => loadEnv({ ...valid, JWT_SECRET: PLACEHOLDER_JWT_SECRET })).toThrow(
        /placeholder/i,
      );
    });

    it('refuses the placeholder JWT_SECRET in test', () => {
      expect(() =>
        loadEnv({ ...valid, NODE_ENV: 'test', JWT_SECRET: PLACEHOLDER_JWT_SECRET }),
      ).toThrow(/placeholder/i);
    });

    /**
     * The case the whole block exists for: `NODE_ENV` absent entirely, which is what a container
     * that forgot to set it looks like. The schema defaults it to `development`, so before this
     * change every production assertion was skipped and the placeholder sailed through.
     */
    it('refuses the placeholder JWT_SECRET when NODE_ENV is not set at all', () => {
      expect(() => loadEnv({ ...withoutNodeEnv(), JWT_SECRET: PLACEHOLDER_JWT_SECRET })).toThrow(
        /placeholder/i,
      );
    });

    it('refuses the placeholder SWAGGER_PASSWORD in development', () => {
      expect(() => loadEnv({ ...valid, SWAGGER_PASSWORD: 'replace_me' })).toThrow(/placeholder/i);
    });

    /**
     * And it still accepts a real development environment, so the check has not simply become
     * "refuse to boot". This is the case that would break every developer and every test run if the
     * marker match were widened carelessly.
     */
    it('still accepts a development environment with real values', () => {
      expect(() => loadEnv(valid)).not.toThrow();
      expect(loadEnv(withoutNodeEnv()).NODE_ENV).toBe('development');
    });
  });
});
