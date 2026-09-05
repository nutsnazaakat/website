import type { Config } from 'jest';

/**
 * Unit tests only — fast, no database, no HTTP. Integration and e2e have their own configs.
 *
 * `roots` is `src` because unit specs live beside the code they test, matching
 * mf-lenders-gateway's convention rather than a separate mirrored tree.
 */
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '/test/integration/', '/test/e2e/'],
  setupFiles: ['<rootDir>/test/setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // Mapped to source, not dist, so a change in shared/ is picked up without a rebuild
    // between runs.
    '^@nutwala/shared$': '<rootDir>/../../packages/shared/src/index.ts',
  },
  /**
   * `worker_threads` rather than child processes, so a failing `bigint` assertion is legible.
   *
   * Every money column in this schema is a `@PaiseColumn` bigint, and jest's default child-process
   * workers serialise a failure back to the parent with `JSON.stringify`, which throws on a BigInt. The
   * result is not a poor diff — it is **no diff and no failed test**:
   *
   *     expect(1n).toBe(2n)
   *     -> ● Test suite failed to run
   *        TypeError: Do not know how to serialize a BigInt
   *            at messageParent (jest-worker/build/workers/messageParent.js:29)
   *        Tests: 1 passed, 1 total        <-- the failure is not counted, and the whole file's
   *                                           other results are lost with it
   *
   * So a wrong total in checkout, pricing or the order mapper would vanish and leave a green count.
   *
   * Three things were tried before settling here, and the two that failed are worth knowing:
   *
   * - `BigInt.prototype.toJSON` in `setupFiles` **cannot** work. It patches the prototype inside jest's
   *   vm sandbox, while `messageParent` serialises in the outer realm. Verified live in the worker —
   *   `JSON.stringify({ v: 1n })` returned `{"v":"1n"}` — and the failure was unchanged.
   * - Wrapping assertions (`expect(String(x))`) is **not sufficient**: one raw bigint anywhere in a file
   *   destroys that file's entire result set, wrapped assertions included.
   * - `--runInBand` works and costs 22.8s against 15.3s for 391 tests.
   *
   * `workerThreads` uses `structuredClone`, which handles BigInt natively. Measured: 391 tests in
   * **14.7s**, marginally faster than the default, with the diff restored to `Expected: 2n /
   * Received: 1n`. `test:integration` already runs `--runInBand` and never had the problem.
   */
  workerThreads: true,

  clearMocks: true,
  coverageProvider: 'v8',
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.entity.ts', '!src/main.ts'],
};

export default config;
