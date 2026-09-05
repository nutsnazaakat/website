import type { DataSource } from 'typeorm';

/** One backend that Postgres reports as waiting on a lock, as `pg_stat_activity` describes it. */
export interface BlockedWriter {
  pid: number;
  waitEventType: string;
  waitEvent: string | null;
  /**
   * The statement the blocked backend is executing. Truncated by Postgres at
   * `track_activity_query_size` (1 kB by default), which is far more than any statement a race test
   * here blocks on, so a caller may assert against it — that is how a test proves it blocked on the
   * statement it meant to block on rather than on some unrelated one.
   */
  query: string;
}

interface Row {
  pid: number;
  wait_event_type: string;
  wait_event: string | null;
  query: string;
}

/**
 * Blocks until some connection in this database is waiting on a lock, and answers with the rows that
 * say so.
 *
 * **Waited for, not slept through.** This is what lets a race test know the statement under test has
 * actually reached its write and been stopped there, rather than merely being slow. Releasing the
 * rival early would let a read-then-write implementation see the committed value too, and the test
 * would pass for the wrong reason — the exact failure mode such a test exists to rule out.
 *
 * Shared rather than copied: `cart.integration.spec.ts` and
 * `checkout-concurrency.integration.spec.ts` both need it, and a second copy is a second polling
 * predicate that can drift from the first.
 */
export async function waitForABlockedWriter(
  dataSource: DataSource,
  timeoutMs = 15_000,
): Promise<BlockedWriter[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await dataSource.query<Row[]>(
      `SELECT pid, wait_event_type, wait_event, query FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (rows.length > 0) {
      return rows.map((row) => ({
        pid: row.pid,
        waitEventType: row.wait_event_type,
        waitEvent: row.wait_event,
        query: row.query,
      }));
    }
    if (Date.now() > deadline) {
      throw new Error('No connection ever blocked on a lock; the race was not set up');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
