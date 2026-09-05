import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcrypt';

/** Cost 10, matching cug's `bcrypt.hash(password, 10)`. */
const BCRYPT_COST = 10;
const MIN_LENGTH = 8;
/**
 * bcrypt reads at most 72 bytes and silently discards the rest, so anything longer is a password
 * whose tail does nothing. Two values sharing a 72-byte prefix would authenticate interchangeably —
 * measured, and pinned by a test in this file's spec. Refusing the input is honest; accepting it and
 * ignoring most of it is not.
 */
const MAX_BYTES = 72;

/**
 * A short denylist of the passwords that actually appear in credential-stuffing lists. Not a
 * substitute for rate limiting (spec §9), but it stops the handful of values that would make
 * an account trivially guessable.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  'qwerty123',
  'iloveyou',
  'admin123',
  'welcome1',
  'letmein1',
  'abc12345',
  'nutwala123',
]);

export type StrengthResult = { ok: true } | { ok: false; reason: string };

@Injectable()
export class PasswordService {
  /**
   * A real bcrypt hash of a random value nobody holds. Comparing against it costs the same
   * as comparing against a genuine hash, which is how the unknown-email login path is made
   * to take the same time as the wrong-password path.
   */
  private readonly dummyHash = bcrypt.hashSync(randomBytes(32).toString('hex'), BCRYPT_COST);

  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, BCRYPT_COST);
  }

  compare(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  /** Always false. Called when the email is unknown, purely to equalise timing. */
  async compareAgainstDummy(plain: string): Promise<false> {
    await bcrypt.compare(plain, this.dummyHash);
    return false;
  }

  validateStrength(plain: string): StrengthResult {
    if (plain.length < MIN_LENGTH) {
      return { ok: false, reason: `Use at least ${MIN_LENGTH} characters.` };
    }
    // Bytes, not characters: one emoji or Devanagari character can cost four, so a password well
    // under any character count can still exceed what bcrypt will read.
    if (Buffer.byteLength(plain, 'utf8') > MAX_BYTES) {
      return { ok: false, reason: `Use a password of at most ${MAX_BYTES} bytes.` };
    }
    if (COMMON_PASSWORDS.has(plain.toLowerCase())) {
      return { ok: false, reason: 'That password is too common. Choose something less guessable.' };
    }
    return { ok: true };
  }
}
