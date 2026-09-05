import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service';

function build(): TokenService {
  const jwt = new JwtService({ secret: 'a'.repeat(48) });
  return new TokenService(jwt, { accessTokenTtl: '15m', refreshTokenTtlDays: 30 });
}

describe('TokenService', () => {
  it('signs an access token carrying subject, role and session', () => {
    const service = build();
    const token = service.signAccessToken({ sub: 'u1', role: 'CUSTOMER', sessionId: 's1' });
    const decoded = service.verifyAccessToken(token);
    expect(decoded).toMatchObject({ sub: 'u1', role: 'CUSTOMER', sessionId: 's1' });
  });

  it('rejects a tampered access token', () => {
    const service = build();
    const token = service.signAccessToken({ sub: 'u1', role: 'CUSTOMER', sessionId: 's1' });
    const tampered = `${token.slice(0, -2)}xy`;
    expect(() => service.verifyAccessToken(tampered)).toThrow();
  });

  it('generates a refresh token with at least 256 bits of entropy', () => {
    const service = build();
    const token = service.generateRefreshToken();
    // 32 random bytes base64url-encoded is 43 characters.
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never generates the same refresh token twice', () => {
    const service = build();
    const tokens = new Set(Array.from({ length: 500 }, () => service.generateRefreshToken()));
    expect(tokens.size).toBe(500);
  });

  it('hashes a refresh token to a stable 64-character hex digest', () => {
    const service = build();
    const first = service.hashRefreshToken('some-token');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(service.hashRefreshToken('some-token')).toBe(first);
    expect(service.hashRefreshToken('other-token')).not.toBe(first);
  });

  it('computes a refresh expiry from the configured day count', () => {
    const service = build();
    const now = new Date('2026-08-19T00:00:00.000Z');
    expect(service.refreshExpiryFrom(now).toISOString()).toBe('2026-09-18T00:00:00.000Z');
  });
});
