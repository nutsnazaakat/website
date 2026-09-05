import { putSharedContainer } from './helpers/container-handoff';
import { startTestDatabase } from './helpers/test-database';

/**
 * Runs once in the Jest parent process, before any worker exists. Starting the container here —
 * rather than in a per-file `beforeAll` — is what makes it *one* container for the whole run:
 * every spec file gets a fresh module registry, so no in-module "already started" guard can be
 * seen across files, but `process.env` written here is inherited by every worker at spawn.
 */
export default async function globalSetup(): Promise<void> {
  const container = await startTestDatabase();
  putSharedContainer(container);

  // Logged deliberately: this line appearing exactly once is the visible proof that spec file
  // number two reused the container instead of starting its own.
  console.log(
    `[integration] postgres container ${container.getId().slice(0, 12)} on port ` +
      `${String(container.getMappedPort(5432))}, migrations applied`,
  );
}
