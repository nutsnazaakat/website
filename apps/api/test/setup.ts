// Deterministic dates and money formatting across machines and CI.
process.env.TZ = 'UTC';

// Unit tests must never reach a database or a real secret.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-at-least-thirty-two-chars-long';
