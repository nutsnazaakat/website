import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/test/e2e'],
  testRegex: '.*\\.e2e-spec\\.ts$',
  setupFiles: ['<rootDir>/test/integration/setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@nutwala/shared$': '<rootDir>/../../packages/shared/src/index.ts',
  },
  maxWorkers: 1,
  testTimeout: 180_000,
  // test/e2e/ is empty until Plan 4; an empty suite must still exit 0.
  passWithNoTests: true,
};

export default config;
