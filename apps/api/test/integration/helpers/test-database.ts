import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { buildTypeOrmOptions } from '../../../src/database/typeorm.options';
import type { AppConfiguration } from '../../../src/common/config/app.config';

/**
 * Container lifecycle (`startTestDatabase` / `stopTestDatabase`) belongs to Jest's `globalSetup`
 * and `globalTeardown`; per-spec-file code only connects (`connectTestDataSource` /
 * `closeTestDataSource`).
 *
 * The split is not stylistic. Jest gives every spec *file* a fresh module registry regardless of
 * `maxWorkers`, so a module-scoped `if (alreadyStarted) return` in this file can never
 * short-circuit across files — with the container started from a `beforeAll`, spec file number two
 * starts a second Postgres and replays the whole migration chain, serially, and so does every file
 * after it. `globalSetup` runs exactly once in the Jest parent process before any worker spawns,
 * and the `DB_*` variables it writes into `process.env` are inherited by the workers at spawn
 * time, which is what actually delivers the single shared container.
 */
let dataSource: DataSource | undefined;

/**
 * Starts the one Postgres container for the whole run and applies the real migration chain to it.
 * Call from `globalSetup` only — see the note above.
 *
 * Spec §3.1 departure 4: cug's equivalent helper uses `synchronize: true` with a note that
 * its migration set has ordering issues. Running migrations here means the chain is exercised
 * on every integration run, so an ordering problem is a failing test rather than a surprise
 * at deploy time.
 */
export async function startTestDatabase(): Promise<StartedPostgreSqlContainer> {
  const container = await new PostgreSqlContainer('postgres:15-alpine')
    .withDatabase('nutwala_test')
    .withUsername('nutwala')
    .withPassword('nutwala_test_only')
    .start();

  // From here on, anything that throws must still stop the container. Ryuk reaps it eventually by
  // session, but that borrows correctness from a safety net instead of owning it, and wastes Docker
  // resources for Ryuk's grace period on every failed run of an iterate-on-a-broken-migration loop.
  try {
    // The application reads its database settings from env, so point them at the container. Set in
    // the Jest parent process, which is what makes them visible to every worker and every spec.
    process.env.DB_HOST = container.getHost();
    process.env.DB_PORT = String(container.getMappedPort(5432));
    process.env.DB_USER = container.getUsername();
    process.env.DB_PASSWORD = container.getPassword();
    process.env.DB_NAME = container.getDatabase();
    process.env.DB_SCHEMA = 'public';

    // Migrations run once, here, against a throwaway connection: the schema is container state, not
    // per-spec state, and the connections the specs open must not each try to build it.
    const migrator = new DataSource(optionsFromEnv());
    try {
      await migrator.initialize();
      await migrator.runMigrations({ transaction: 'each' });
    } finally {
      // `initialize()` already destroys itself (and clears `isInitialized`) if it fails, so guard
      // against destroying twice — a second `destroy()` on a DataSource that never initialised
      // throws `CannotExecuteNotConnectedError`, which would mask whatever actually failed.
      if (migrator.isInitialized) await migrator.destroy();
    }
  } catch (error) {
    await container.stop();
    throw error;
  }

  return container;
}

/** Stops the shared container. Call from `globalTeardown` only. */
export async function stopTestDatabase(container: StartedPostgreSqlContainer): Promise<void> {
  await container.stop();
}

/**
 * Connects this spec file's own DataSource to the already-running container. Idempotent within a
 * file, because the module registry is per file: the second caller gets the first connection.
 *
 * This handle exists for test-side work — `cleanDatabase`, and fixtures inserting rows. The
 * application under test opens its own connection through `TypeOrmModule`.
 */
export async function connectTestDataSource(): Promise<DataSource> {
  if (dataSource?.isInitialized) return dataSource;

  if (!process.env.DB_HOST || !process.env.DB_PORT) {
    throw new Error(
      'No test container. `globalSetup` (test/integration/global-setup.ts) must have run first — ' +
        'check jest.integration.config.ts if this fires.',
    );
  }

  dataSource = new DataSource(optionsFromEnv());
  await dataSource.initialize();
  return dataSource;
}

export function getTestDataSource(): DataSource {
  if (!dataSource?.isInitialized) {
    throw new Error('connectTestDataSource() must be awaited before getTestDataSource()');
  }
  return dataSource;
}

/** Closes this spec file's connection. Deliberately leaves the shared container running. */
export async function closeTestDataSource(): Promise<void> {
  if (dataSource?.isInitialized) await dataSource.destroy();
  dataSource = undefined;
}

function optionsFromEnv(): DataSourceOptions {
  return buildTypeOrmOptions({
    isProduction: false,
    database: {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      schema: 'public',
      migrationsRun: false,
    },
  } as AppConfiguration);
}
