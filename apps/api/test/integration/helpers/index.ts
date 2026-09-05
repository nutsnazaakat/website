export * from './db-cleaner';
export * from './http';
export * from './locks';
export * from './test-app';
export * from './use-integration-app';
// Only the per-spec-file half of `test-database` is re-exported. `startTestDatabase` and
// `stopTestDatabase` own the shared container and belong to global-setup.ts / global-teardown.ts,
// which import them directly — a spec that reaches for them starts a second Postgres, which is the
// exact bug this harness was restructured to remove.
export { closeTestDataSource, connectTestDataSource, getTestDataSource } from './test-database';
// `container-handoff` is deliberately not exported either: it is plumbing between the two global
// hooks, and no spec has any business holding the container handle.
