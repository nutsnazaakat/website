/**
 * The environment allowlist every seeder is gated on, and the guard that enforces it.
 *
 * Extracted from `users.seed.ts`, which held the only copy — and held it *inside the seeder*,
 * which made it far weaker than it looked.
 *
 * `seed.ts` runs its seeders in a plain sequential loop over declaration order, and that order
 * starts `settings, users, catalog, …`. So `npm run seed` against a database it should never have
 * touched did this: **`seedSettings` overwrote all sixteen settings rows, and only then did
 * `seedUsers` throw.** The operator saw a failed seed run and an error about fixture passwords,
 * with no indication that the brand name, support contacts, GST number, FSSAI licence and both
 * payment flags had already been reset to their fixture values. The guard protected the row it
 * was written next to and nothing else.
 *
 * It is therefore hoisted to the runner, where it is checked once **before** `resolveNames` and
 * before `dataSource.initialize()` — nothing is written, and no connection is even opened.
 *
 * **An allowlist, not a denylist**, and deliberately so: `NODE_ENV` is `undefined` when unset, and
 * a denylist on the exact string `production` lets a typo, `prod`, `staging`, `Production` or an
 * empty value straight through. Refusing anything not positively named is what makes the failure
 * mode "refuses to run" instead of "silently seeds a live database".
 *
 * Reads the raw variable rather than `appConfig().isProduction` because a seeder is a standalone
 * `ts-node` process with no Nest container, so it never sees validated config.
 */
import { OPERATOR_NODE_ENV } from '../../operator-env';

export const SEEDABLE_ENVIRONMENTS: readonly string[] = ['development', 'test'];

/**
 * Throws unless `NODE_ENV` is positively one of `SEEDABLE_ENVIRONMENTS`.
 *
 * `subject` names what is being refused, so the message tells the operator which destructive act
 * was declined rather than only that something was.
 */
export function assertSeedableEnvironment(subject: string): void {
  /**
   * Two values, and **either** one being unseedable refuses.
   *
   * `process.env.NODE_ENV` is the effective value, which `.env` owns. `OPERATOR_NODE_ENV` is what
   * the operator supplied on the command line before `override: true` discarded it. Checking only
   * the first is what made this guard bypassable by `NODE_ENV=production npm run seed`; checking
   * only the second would let an unset command line through on a production `.env`.
   *
   * The operator's value is skipped when `undefined` — that is the ordinary case, where nothing
   * was supplied and `.env` alone speaks.
   */
  const effective = process.env.NODE_ENV;
  const refuse = (value: string | undefined, source: string): never => {
    throw new Error(
      `Refusing to ${subject}: NODE_ENV is ` +
        `${value === undefined ? 'not set' : `"${value}"`}${source}, and seeding is only ` +
        `permitted when it is one of ${SEEDABLE_ENVIRONMENTS.join(', ')}`,
    );
  };

  if (effective === undefined || !SEEDABLE_ENVIRONMENTS.includes(effective)) {
    refuse(effective, '');
  }
  if (OPERATOR_NODE_ENV !== undefined && !SEEDABLE_ENVIRONMENTS.includes(OPERATOR_NODE_ENV)) {
    refuse(OPERATOR_NODE_ENV, ' on the command line (before .env overrode it)');
  }
}
