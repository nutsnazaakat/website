import { PasswordService } from './password.service';

/**
 * Samples per side for the timing test. Nine keeps the median stable — see the justification at the
 * assertion — for about 1.1s of bcrypt, which is the whole cost of this file's slowest test.
 */
const SAMPLES_PER_SIDE = 9;

/** Milliseconds one awaited call took, from the monotonic clock. */
async function time(run: () => Promise<unknown>): Promise<number> {
  const start = process.hrtime.bigint();
  await run();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function median(values: number[]): number {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) throw new Error('median of no samples');
  // `noUncheckedIndexedAccess` makes every index `number | undefined`; the length check above is
  // what makes these reads safe, and `?? 0` would silently answer 0 for an empty array instead.
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? 0) + upper) / 2;
}

describe('PasswordService', () => {
  const service = new PasswordService();

  it('produces a bcrypt hash at cost 10, matching cug', async () => {
    const hash = await service.hash('Password123!');
    // $2b$ is the bcrypt identifier; 10 is the cost.
    expect(hash).toMatch(/^\$2[aby]\$10\$/);
  });

  it('does not store the password in the hash', async () => {
    const hash = await service.hash('Password123!');
    expect(hash).not.toContain('Password123!');
  });

  it('produces a different hash each time, because the salt is random', async () => {
    const [first, second] = await Promise.all([
      service.hash('Password123!'),
      service.hash('Password123!'),
    ]);
    expect(first).not.toBe(second);
  });

  it('verifies a correct password', async () => {
    const hash = await service.hash('Password123!');
    await expect(service.compare('Password123!', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await service.hash('Password123!');
    await expect(service.compare('wrong', hash)).resolves.toBe(false);
  });

  it('burns comparable time when there is no user, so login cannot be timed', async () => {
    // Spec §13, "user enumeration": returning early for an unknown email makes that path
    // measurably faster and turns login into an account-existence oracle.
    await expect(service.compareAgainstDummy('anything')).resolves.toBe(false);

    const hash = await service.hash('Password123!');

    // Two pairs discarded first: the very first bcrypt call in a process pays for lazily loading
    // the native addon and for a cold instruction cache, and whichever side went first used to
    // absorb all of it.
    for (let warmup = 0; warmup < 2; warmup += 1) {
      await time(() => service.compareAgainstDummy('anything'));
      await time(() => service.compare('wrong', hash));
    }

    // Interleaved, and reduced with a median rather than a mean. One sample per side — what this
    // test used to take — is dominated by whatever else the machine did during those 60ms, and a
    // mean is dragged by a single scheduler hiccup. Alternating means any drift in machine load
    // lands on both sides equally.
    const dummySamples: number[] = [];
    const realSamples: number[] = [];
    for (let sample = 0; sample < SAMPLES_PER_SIDE; sample += 1) {
      dummySamples.push(await time(() => service.compareAgainstDummy('anything')));
      realSamples.push(await time(() => service.compare('wrong', hash)));
    }

    const ratio = median(dummySamples) / median(realSamples);
    // Two-sided in one assertion: the old bound only stopped the dummy being *faster*, so nothing
    // constrained it being slower, and "unknown email is reliably slower" is the same oracle read
    // the other way round.
    const spread = Math.max(ratio, 1 / ratio);

    // Why 1.25×, when the old bound was 5× and one-sided.
    //
    // The old bound could not fail on anything realistic: a dummy hash at cost 12 runs 4.02×
    // slower than a real compare and passed all 15 runs. On a ~61ms operation that is a ~45ms
    // systematic difference — trivially separable over a LAN, and exactly the oracle this test
    // exists to deny.
    //
    // Both sides are the same bcrypt work at the same cost, so the honest ratio is ~1. Measured
    // here: 50 medians of 9–11 interleaved samples, min 0.980, max 1.009 — worst deviation 2.0%,
    // including a run under eight-way CPU contention (absolute times rose 61ms → 69ms while the
    // ratio stayed inside 1%). 1.25 is therefore ~12× the worst noise seen, and still far below
    // the smallest defect that could plausibly ship: a one-step bcrypt cost mismatch is 2×, a
    // non-bcrypt stand-in or an early `return false` is unbounded.
    expect(spread).toBeLessThan(1.25);
  });

  it('rejects a password shorter than eight characters', () => {
    expect(service.validateStrength('short')).toEqual(expect.objectContaining({ ok: false }));
  });

  it('rejects one of the most common passwords even when long enough', () => {
    expect(service.validateStrength('password')).toEqual(expect.objectContaining({ ok: false }));
    expect(service.validateStrength('12345678')).toEqual(expect.objectContaining({ ok: false }));
  });

  it('accepts a reasonable password', () => {
    expect(service.validateStrength('Kaju1kgPlease')).toEqual({ ok: true });
  });

  /**
   * bcrypt truncates its input at 72 bytes, so without an upper bound two different passwords
   * sharing a 72-byte prefix authenticate interchangeably — everything the user typed past byte 72
   * is silently ignored. Rejecting over-long input is honest about the primitive's limit.
   */
  it('rejects a password longer than bcrypt can actually read', () => {
    expect(service.validateStrength('A'.repeat(73))).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(service.validateStrength('A'.repeat(72))).toEqual({ ok: true });
  });

  it('counts bytes rather than characters, because the truncation is in bytes', () => {
    // 24 four-byte characters is 96 bytes but only 24 code points, and `String.length` counts 48
    // UTF-16 units — so every naive measure disagrees with the one bcrypt uses.
    const emoji = '🥜'.repeat(24);
    expect(Buffer.byteLength(emoji, 'utf8')).toBe(96);
    expect(service.validateStrength(emoji)).toEqual(expect.objectContaining({ ok: false }));
  });

  it('proves the truncation it is guarding against is real', async () => {
    // If this ever fails, bcrypt stopped truncating and the bound above can be reconsidered.
    const hash = await service.hash('A'.repeat(72) + 'ZZZZZZZZZZ');
    await expect(service.compare('A'.repeat(72) + 'QQQQQQQQQQ', hash)).resolves.toBe(true);
  });
});
