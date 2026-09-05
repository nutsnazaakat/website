import * as bcrypt from 'bcrypt';
import type { DataSource } from 'typeorm';
import { UserRole } from '../../src/entities/enums';
import { User } from '../../src/entities/identity/user.entity';

/**
 * The password every factory-made account is created with.
 *
 * Chosen to satisfy `PasswordService.validateStrength` — over 8 characters, under 72 bytes, and
 * not in the denylist — so a test that registers and a test that logs in against a fixture can
 * use the same literal. A value the strength check rejected would make every registration test
 * fail with `WEAK_PASSWORD` for a reason that has nothing to do with what it is testing.
 */
export const TEST_PASSWORD = 'Kaju1kgPlease';

/** Cost 10, matching `PasswordService`, so `compare` against these hashes behaves identically. */
const BCRYPT_COST = 10;

/**
 * Inserts a user directly, bypassing `POST /auth/register`.
 *
 * Deliberately not "register through the API and reuse the account": registration is rate limited
 * to three per hour per IP, it is itself under test, and a fixture built out of the endpoint it is
 * used to test cannot distinguish a broken endpoint from a broken fixture. Writing the row means a
 * login test starts from a known-good account whatever `register` does.
 *
 * The email carries a random suffix so callers that do not care about the address never collide
 * with the `LOWER(email)` unique index; pass `{ email }` when the test is about a specific address.
 */
export async function createTestUser(
  dataSource: DataSource,
  overrides: Partial<User> = {},
): Promise<User> {
  const repository = dataSource.getRepository(User);
  const suffix = Math.random().toString(36).slice(2, 8);

  return repository.save(
    repository.create({
      name: 'Test Customer',
      email: `test-${suffix}@demo.in`,
      phone: '9876543210',
      passwordHash: await bcrypt.hash(TEST_PASSWORD, BCRYPT_COST),
      role: UserRole.CUSTOMER,
      isActive: true,
      ...overrides,
    }),
  );
}
