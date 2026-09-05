/**
 * `NODE_ENV` as the *operator* supplied it, captured before anything can overwrite it.
 *
 * **Deliberately side-effect-free.** It exists as its own module rather than as an export of
 * `load-env.ts` because guards need to read this value, and making them import `load-env` would
 * drag `dotenv.config({ override: true })` into every test that touches a guarded module.
 * `load-env.ts`'s own note explains what that costs: there is intentionally no `.env.test`, and a
 * stray `.env` load with `override: true` clobbers the `DB_HOST`/`DB_PORT` that testcontainers
 * assigns at runtime, breaking every integration test.
 *
 * `load-env.ts` imports this module, so for any entry point that loads `load-env` first — `main.ts`
 * and `seed.ts` both do — import hoisting guarantees this capture runs before `dotenv.config()`.
 * Imported on its own it is still correct, because it reads `process.env` at module load and
 * nothing here mutates it.
 *
 * Why it is needed at all, measured: `NODE_ENV=production npm run seed` reached every guard in the
 * process as `development`, because `.env` line 1 says `NODE_ENV=development` and `override: true`
 * wins. A probe printed `{"before":"production","after":"development"}`. An operator typing
 * `NODE_ENV=production` as a safety measure — the exact reflex the seed guard exists for — had it
 * discarded one import later, and the seed proceeded against whatever database `.env` pointed at.
 *
 * `override: true` cannot just be dropped to fix that: PM2 caches a process's first environment
 * and re-injects it on restart, so without it an edited `.env` has no effect. Preserving the
 * pre-override value is the fix that keeps both properties.
 */
export const OPERATOR_NODE_ENV: string | undefined = process.env.NODE_ENV;
