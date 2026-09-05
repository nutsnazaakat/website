import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/test/integration'],
  testRegex: '.*\\.integration\\.spec\\.ts$',
  setupFiles: ['<rootDir>/test/integration/setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@nutwala/shared$': '<rootDir>/../../packages/shared/src/index.ts',
  },
  // One Postgres container and one run of the migration chain for the whole suite, started and
  // stopped by these two hooks.
  //
  // They have to be hooks. Jest hands every spec *file* a fresh module registry no matter what
  // `maxWorkers` says, so a container started from a `beforeAll` and memoised in a module variable is
  // invisible to the next file, which then starts its own — serially, migrations and all. These run
  // exactly once in the parent process before any worker spawns, and the `DB_*` variables
  // `global-setup` writes are inherited by the workers at spawn time.
  globalSetup: '<rootDir>/test/integration/global-setup.ts',
  globalTeardown: '<rootDir>/test/integration/global-teardown.ts',
  // Still serial: the `TRUNCATE` cleaner in `helpers/db-cleaner.ts` would race between parallel
  // workers sharing the one container.
  maxWorkers: 1,
  testTimeout: 120_000,
};

export default config;
