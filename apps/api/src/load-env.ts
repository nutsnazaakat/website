/**
 * Side-effect-only module. It MUST be the first import in `main.ts`.
 *
 * Two reasons, both learned in mf-lenders-gateway:
 *
 * 1. Static imports hoist above inline statements, so calling `dotenv.config()` in the body
 *    of `main.ts` would run *after* every imported module had already read `process.env`.
 * 2. Development dotenv values override stale PM2 values. In production, platform-injected
 *    configuration wins over any bundled dotenv file.
 *
 * There is deliberately **no `.env.test` file**, and one must not be added. `dotenv.config`
 * against a missing path is a silent no-op, which is exactly what the tests want: unit tests set
 * what they need directly in `test/setup.ts`, and the integration tests get their `DB_HOST` and
 * `DB_PORT` from testcontainers at runtime. A real `.env.test` combined with `override: true`
 * would clobber those dynamically-assigned ports and break every integration test.
 */
import * as path from 'node:path';
import * as dotenv from 'dotenv';

/**
 * Imported for its capture, which must happen before `dotenv.config()` below discards the
 * operator's `NODE_ENV`. Import hoisting is what guarantees the ordering, and it is why the
 * capture lives in its own module rather than in a statement here. See `operator-env.ts` for the
 * measurement that made this necessary.
 */
import { OPERATOR_NODE_ENV } from './operator-env';

dotenv.config({
  path: path.resolve(process.cwd(), process.env.NODE_ENV === 'test' ? '.env.test' : '.env'),
  override: OPERATOR_NODE_ENV !== 'production',
});
