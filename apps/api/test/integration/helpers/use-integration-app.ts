import type { Server } from 'node:http';
import type { INestApplication, ModuleMetadata } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { cleanDatabase } from './db-cleaner';
import { createTestApp } from './test-app';
import { closeTestDataSource, connectTestDataSource } from './test-database';

export interface IntegrationApp {
  /** The booted application. Only valid inside a test, i.e. after `beforeAll` has run. */
  readonly app: INestApplication<Server>;
  /** The test-side connection, for fixtures and assertions against the database. */
  readonly dataSource: DataSource;
}

/**
 * Booting a container-backed spec has an order and a set of hooks that must be right every time,
 * and until now the only thing enforcing them was a docstring. Call this once inside a `describe`
 * and the whole lifecycle is handled:
 *
 * - connect the test-side DataSource, then boot the app (the app reads `DB_*` from `process.env`
 *   through `TypeOrmModule.forRootAsync`, so the container must already exist — `globalSetup`
 *   guarantees that, and connecting first also means `afterEach` never sees a null handle);
 * - a `beforeAll` timeout large enough for the boot;
 * - `cleanDatabase` after every test, so no spec inherits another's rows;
 * - close the app and this file's connection afterwards. The shared container is stopped by
 *   `globalTeardown`, not here.
 *
 * Cleanup is `afterEach`, not `beforeEach`: a failing test then leaves nothing behind for the
 * next one to trip over, and the cost is the same one statement either way.
 */
export function useIntegrationApp(metadata: ModuleMetadata = {}): IntegrationApp {
  let app: INestApplication<Server> | undefined;
  let dataSource: DataSource | undefined;

  beforeAll(async () => {
    dataSource = await connectTestDataSource();
    app = await createTestApp(metadata);
  }, 120_000);

  afterEach(async () => {
    if (dataSource) await cleanDatabase(dataSource);
  });

  afterAll(async () => {
    await app?.close();
    await closeTestDataSource();
  });

  // Getters, not the values: `beforeAll` has not run at the point this returns, so handing back
  // `app` directly would hand back `undefined` and every spec would need its own `let`.
  return {
    get app(): INestApplication<Server> {
      if (!app) throw new Error('useIntegrationApp(): the app is only available inside a test');
      return app;
    },
    get dataSource(): DataSource {
      if (!dataSource) {
        throw new Error('useIntegrationApp(): the DataSource is only available inside a test');
      }
      return dataSource;
    },
  };
}
