import { takeSharedContainer } from './helpers/container-handoff';
import { stopTestDatabase } from './helpers/test-database';

/**
 * Runs once, after the last spec file. Per-file connections are closed by `useIntegrationApp`'s
 * `afterAll`; the container is this hook's only responsibility.
 */
export default async function globalTeardown(): Promise<void> {
  const container = takeSharedContainer();
  if (container) await stopTestDatabase(container);
}
