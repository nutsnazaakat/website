import type { DataSource } from 'typeorm';
import { seedUsers } from './users.seed';

/**
 * One thing only: the guard that stops `npm run seed` writing a known-password `ADMIN` account
 * into a database it should not be pointed at.
 *
 * `users.seed.ts` seeds `admin@demo.in` with the literal `Password123!` and `upsertUsers` *resets*
 * both the hash and `isActive: true` on every re-run, so a previously disabled fixture admin comes
 * back. The guard is therefore the only thing between that fixture and a live database, and it was
 * written as a negative test on a value that can be absent:
 *
 * ```ts
 * if (process.env.NODE_ENV === 'production') throw ...
 * ```
 *
 * `process.env.NODE_ENV` is `undefined` when unset, and — unlike everywhere else in the service —
 * this reads the raw variable rather than the validated `appConfig().isProduction`, so it never sees
 * `env.schema.ts`'s narrowing at all. Anything that is not the exact string `production` seeded:
 * unset, a typo, `prod`, `staging`, `Production`. That is a fail-*open* gate on a known credential,
 * so it is inverted here into a positive allowlist and these cases pin it.
 *
 * Found by Milestone 10's security review.
 */
describe('seedUsers refuses any environment it cannot positively identify as safe', () => {
  const original = process.env.NODE_ENV;

  afterEach(() => {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  });

  /**
   * A `DataSource` that fails the test if it is touched at all.
   *
   * The guard has to refuse **before** the connection is used, and asserting only on the thrown
   * message would not show that: `seedUsers` hashes a password and opens a transaction immediately
   * after the check, so a guard that fell through would throw *something* from this double and a
   * `toThrow()` with no argument would pass. This makes falling through a distinct, named failure.
   */
  function unusableDataSource(): DataSource {
    return {
      transaction: () => {
        throw new Error('seedUsers reached the database despite the environment guard');
      },
      getRepository: () => {
        throw new Error('seedUsers reached the database despite the environment guard');
      },
    } as unknown as DataSource;
  }

  const REFUSAL = /Refusing to seed fixture accounts/;

  it('refuses production, which is the case the guard was written for', async () => {
    process.env.NODE_ENV = 'production';
    await expect(seedUsers(unusableDataSource())).rejects.toThrow(REFUSAL);
  });

  /** The fail-open case: a container that simply never set the variable. */
  it('refuses an unset NODE_ENV rather than treating absence as development', async () => {
    delete process.env.NODE_ENV;
    await expect(seedUsers(unusableDataSource())).rejects.toThrow(REFUSAL);
  });

  it.each(['prod', 'Production', 'PRODUCTION', 'staging', 'demo', 'live', ''])(
    'refuses NODE_ENV=%p, which the equality check let through',
    async (value) => {
      process.env.NODE_ENV = value;
      await expect(seedUsers(unusableDataSource())).rejects.toThrow(REFUSAL);
    },
  );

  /**
   * The other half, and the reason this is an allowlist rather than a longer denylist: the two
   * environments that legitimately seed must still seed. Without these, "refuse everything" would
   * satisfy every case above.
   *
   * They are asserted by *not* refusing — the double throws its own distinct message the moment the
   * guard is passed, which is exactly the signal wanted here and keeps the spec off a real database.
   */
  it.each(['development', 'test'])('lets NODE_ENV=%p through to the database', async (value) => {
    process.env.NODE_ENV = value;
    await expect(seedUsers(unusableDataSource())).rejects.toThrow(
      /reached the database despite the environment guard/,
    );
  });
});
