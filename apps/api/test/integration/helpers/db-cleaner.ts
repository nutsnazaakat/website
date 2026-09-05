import type { DataSource } from 'typeorm';

interface TableRow {
  table_schema: string;
  table_name: string;
}

interface BusyBackend {
  pid: number;
  state: string;
  wait_event_type: string | null;
  query: string;
}

/**
 * How long to wait for the application's own connections to go quiet before truncating.
 *
 * Generous on purpose. This is not a latency budget — in a healthy run the first poll finds
 * nothing and the wait costs one query. It only spends time when there is genuinely something
 * in flight, which is precisely the case that used to corrupt the next test.
 */
const IDLE_TIMEOUT_MS = 10_000;
const IDLE_POLL_MS = 10;

/**
 * Waits until no *other* client connection to this database is mid-statement or mid-transaction.
 *
 * **Why this exists.** `useIntegrationApp` opens two independent pools per spec file: this
 * test-side `DataSource`, and the application's own through `TypeOrmModule`. `cleanDatabase` runs
 * on the first; every request under test runs on the second; and nothing used to synchronise them.
 * A request whose response had been sent but whose transaction had not yet committed would race the
 * `TRUNCATE`, and the race was resolvable in both directions — which is exactly what the symptoms
 * showed (`docs/known-issues.md` item 1):
 *
 * - the app's commit landing *after* the truncate left rows behind, so a later test asserting an
 *   empty database saw `customers: 2` in a file that creates no such row;
 * - contention with `TRUNCATE`'s `ACCESS EXCLUSIVE` lock lost a write, so a session written moments
 *   earlier could not be found and the next request answered **401**.
 *
 * Neither is reproducible alone, and the failure rate rose with suite length, because a longer run
 * gives more in-flight work more cleaners to collide with.
 *
 * `state <> 'idle'` covers both hazards deliberately: `active` is a statement still executing, and
 * `idle in transaction` is the more dangerous one — a connection holding an open snapshot and
 * uncommitted rows, which reads as "not busy" to anything that only checks for running queries.
 *
 * Scoped to `backend_type = 'client backend'` so autovacuum and the walwriter are not mistaken for
 * the application, and excludes our own backend, which is `active` by definition while it asks.
 */
async function waitForOtherConnectionsIdle(dataSource: DataSource): Promise<void> {
  const startedAt = Date.now();

  for (;;) {
    const busy = await dataSource.query<BusyBackend[]>(
      `SELECT pid, state, wait_event_type, query
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND backend_type = 'client backend'
          AND state IS NOT NULL
          AND state <> 'idle'`,
    );

    if (busy.length === 0) return;

    if (Date.now() - startedAt > IDLE_TIMEOUT_MS) {
      // Loudly, with the offending statements. A timeout here is a real finding — most likely a
      // request the test never awaited, or a transaction a handler failed to close — and reporting
      // the pids and their queries is what makes it diagnosable instead of another flake.
      const detail = busy
        .map(
          (b) =>
            `  pid ${String(b.pid)} [${b.state}] ${b.query.replace(/\s+/g, ' ').slice(0, 160)}`,
        )
        .join('\n');
      throw new Error(
        `cleanDatabase waited ${String(IDLE_TIMEOUT_MS)}ms for the application's connections to go ` +
          `idle and ${String(busy.length)} are still busy. Truncating now would race them.\n${detail}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
  }
}

/**
 * Empties every table between tests, CUG's approach. `TRUNCATE ... CASCADE` in one statement
 * is far faster than per-table deletes and sidesteps foreign-key ordering entirely.
 *
 * The list comes from `entityMetadatas`, intersected with the tables Postgres actually has. Both
 * halves matter — see the comments inline.
 */
export async function cleanDatabase(dataSource: DataSource): Promise<void> {
  const targets = dataSource.entityMetadatas
    .map((metadata) => ({ schema: metadata.schema ?? 'public', table: metadata.tableName }))
    // Exact comparison, not `table.includes('migrations')`. TypeORM builds its own `migrations`
    // table through a raw QueryRunner and never as an `@Entity()`, so it cannot appear in
    // `entityMetadatas` — this guard has never fired and is kept only against a future entity
    // literally named `migrations`. A substring match, meanwhile, would silently have skipped an
    // entity whose table merely contains the word (`order_status_migrations`, or any audit or
    // history table), leaving its rows to leak into the next test.
    .filter(({ table }) => table !== 'migrations');

  if (targets.length === 0) return;

  // Why the intersection with `information_schema`, rather than trusting `entityMetadatas` alone
  // — do not "simplify" this away:
  //
  // An `@Entity()` class exists from the moment it is written; its table exists only once a
  // migration creates it. Those two happen in different tasks, so the two lists disagree in every
  // partially-migrated state — including right now, with entities declared and
  // `src/database/migrations/` still empty. `TRUNCATE` naming a single absent relation aborts the
  // whole statement, which would fail every test in the suite for a reason that has nothing to do
  // with the test.
  //
  // It stays correct at the other end too: once the chain creates every table, the intersection is
  // simply all of them. And it cannot mask a missing table from a test that depends on one — that
  // test fails on its own first insert, which is where the failure belongs.
  const schemas = [...new Set(targets.map(({ schema }) => schema))];
  const rows = await dataSource.query<TableRow[]>(
    `SELECT table_schema, table_name FROM information_schema.tables
      WHERE table_schema = ANY($1) AND table_type = 'BASE TABLE'`,
    [schemas],
  );
  const present = new Set(rows.map((row) => `${row.table_schema}.${row.table_name}`));

  const tables = targets
    .filter(({ schema, table }) => present.has(`${schema}.${table}`))
    .map(({ schema, table }) => `"${schema}"."${table}"`);

  // Where this function returns today: no application table exists yet, so the intersection is
  // empty and no TRUNCATE is issued at all. Guarded explicitly rather than trusting
  // `tables.join(', ')` on an empty array to fail loudly — an unguarded call would send
  // `TRUNCATE TABLE  RESTART IDENTITY CASCADE` (two spaces, no table name), which Postgres
  // rejects as a syntax error.
  if (tables.length === 0) return;

  // Before the truncate, not after: the point is to stop racing work that is still in flight on
  // the application's own pool. See `waitForOtherConnectionsIdle`.
  await waitForOtherConnectionsIdle(dataSource);

  await dataSource.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
}
