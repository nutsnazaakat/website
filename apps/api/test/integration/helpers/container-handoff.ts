import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Passes the shared container handle from `global-setup.ts` to `global-teardown.ts`.
 *
 * Jest transpiles and requires each global hook through its own module registry, so a
 * module-scoped variable set by the setup file reads back as `undefined` in the teardown file —
 * an ordinary `export let` cannot carry it. Both hooks do run in the same (parent) process, so
 * `globalThis` is the one channel that survives between them.
 *
 * The alternative is writing the container id to a temp file, which then obliges the teardown to
 * build its own Docker client to stop a container it never started. This is smaller, and the
 * whole ugliness is confined to this file.
 */
const HANDOFF_KEY = '__nutwalaIntegrationContainer__';

type Handoff = { [HANDOFF_KEY]?: StartedPostgreSqlContainer };

/** Intersecting rather than casting through `unknown`: `A & B` is still assignable to `A`. */
function handoff(): Handoff {
  return globalThis as typeof globalThis & Handoff;
}

export function putSharedContainer(container: StartedPostgreSqlContainer): void {
  handoff()[HANDOFF_KEY] = container;
}

/** Reads and clears the handle, so a second teardown cannot try to stop the same container. */
export function takeSharedContainer(): StartedPostgreSqlContainer | undefined {
  const store = handoff();
  const container = store[HANDOFF_KEY];
  delete store[HANDOFF_KEY];
  return container;
}
