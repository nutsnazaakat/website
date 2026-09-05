import { getMetadataArgsStorage } from 'typeorm';
import { Cart } from '../../entities/commerce/cart.entity';
import { WishlistItem } from '../../entities/commerce/wishlist-item.entity';
import { redact } from './pii-redactor';

describe('redact — credentials', () => {
  it('removes a password', () => {
    expect(redact({ email: 'a@b.test', password: 'hunter2' })).toMatchObject({
      password: '[REDACTED]',
    });
  });

  it('redacts the two-letter token keys on an exact match', () => {
    // `rt` and `at` are too short to match as substrings without scrubbing ordinary field names,
    // so they are matched exactly, after separators are normalised away.
    const result = redact({ rt: 'x', AT: 'x', 'r-t': 'x' }) as Record<string, unknown>;
    for (const value of Object.values(result)) expect(value).toBe('[REDACTED]');
  });

  it('does not catch a prefixed variant, which is the stated limit of exact matching', () => {
    // `x-rt` normalises to `xrt`, not `rt`. Pinned so the trade-off is visible rather than
    // discovered: substring matching on two-letter keys would scrub `cart` and `sort`.
    expect(redact({ 'x-rt': 'token' })).toEqual({ 'x-rt': 'token' });
  });

  it('leaves words that merely contain those keys alone', () => {
    // The reason they are exact-match. A redactor that scrubs `cart` has destroyed the log line
    // someone actually needed.
    expect(redact({ cart: 'two kg almonds', sortOrder: 3, alert: 'low stock' })).toEqual({
      cart: 'two kg almonds',
      sortOrder: 3,
      alert: 'low stock',
    });
  });

  it('keeps the session id readable, which is a decision rather than a gap', () => {
    // A session id identifies a row; it does not authenticate anyone without the signed JWT that
    // carries it. It is also the value you need to trace revocation, rotation and logout, so
    // redacting it would blind the investigations this logger exists to support.
    expect(redact({ sessionId: 'sess-123', session: 'sess-123' })).toEqual({
      sessionId: 'sess-123',
      session: 'sess-123',
    });
  });

  it('matches field names case-insensitively and as substrings', () => {
    const result = redact({
      Password: 'x',
      passwordHash: 'x',
      refresh_token: 'x',
      accessToken: 'x',
      Authorization: 'Bearer x',
      Cookie: 'nn_access_token=x',
      csrfToken: 'x',
      apiKey: 'x',
      clientSecret: 'x',
    }) as Record<string, unknown>;

    for (const value of Object.values(result)) {
      expect(value).toBe('[REDACTED]');
    }
  });

  /**
   * The guest token, in every spelling it appears in: the cookie, the `carts` column, the
   * `wishlist_items` column and the entity property.
   *
   * **This is the only executable thing standing between that column's name and a plaintext credential
   * in the logs.** The name is a deviation from spec §5.3, which calls the field `guestKey` — chosen
   * because this redactor scrubs values whose *key* contains `token` and holds no list of this
   * application's field names. Before this test, renaming the column back to the spec's spelling passed
   * typecheck, lint, every unit suite and every integration suite, while turning a bearer credential
   * for someone's basket and saved list into plaintext on every log line that serialises the row. The
   * reasoning was written down in three places and asserted in none.
   *
   * The `guestKey` case is the control: it proves the redaction is caused by the substring and not by
   * something incidental, and it is why the rename cannot pass quietly.
   */
  it('redacts the guest token by every name the schema gives it', () => {
    const result = redact({
      nn_guest_token: 'SECRET',
      guest_token: 'SECRET',
      guestToken: 'SECRET',
      cart: { id: 'c1', guestToken: 'SECRET' },
    }) as Record<string, unknown>;

    expect(result.nn_guest_token).toBe('[REDACTED]');
    expect(result.guest_token).toBe('[REDACTED]');
    expect(result.guestToken).toBe('[REDACTED]');
    expect(result.cart).toEqual({ id: 'c1', guestToken: '[REDACTED]' });

    // The control. `guestKey` is *not* redacted, which is the whole reason the column is not called
    // that. If this ever starts passing as redacted, the keyword list has grown and the deviation from
    // spec §5.3 could be revisited.
    expect(redact({ guestKey: 'SECRET' })).toEqual({ guestKey: 'SECRET' });
  });

  /**
   * The same claim, bound to the **schema** rather than to a literal.
   *
   * The test above was written to make renaming the column "impossible to do quietly" and does not
   * achieve that: every key in it is hand-typed, so a coordinated rename of `Cart.guestToken` and
   * `WishlistItem.guestToken` to the spec's `guestKey` — columns, properties and call sites — leaves it
   * passing byte-for-byte. A review caught that; it is the same shape of hole one level up.
   *
   * This reads the real column names out of TypeORM's decorator metadata and asserts the redactor
   * scrubs each. No connection is needed: `getMetadataArgsStorage()` is populated by importing the
   * entities. Rename the column and this fails on the name it finds.
   */
  it('redacts whatever the entities actually call the guest token', () => {
    const columns = getMetadataArgsStorage().columns.filter(
      (column) => column.target === Cart || column.target === WishlistItem,
    );
    expect(columns.length).toBeGreaterThan(0);

    const guestColumns = columns.filter((column) => /guest/i.test(column.propertyName));
    // Both entities carry exactly one guest-owner column. If this drops to zero the loop below would
    // assert nothing at all — the empty-collection trap.
    expect(guestColumns).toHaveLength(2);

    for (const column of guestColumns) {
      const property = column.propertyName;
      const database = column.options.name ?? property;

      expect(redact({ [property]: 'SECRET' })).toEqual({ [property]: '[REDACTED]' });
      expect(redact({ [database]: 'SECRET' })).toEqual({ [database]: '[REDACTED]' });
    }
  });

  it('redacts nested objects', () => {
    expect(redact({ body: { user: { password: 'x' } } })).toEqual({
      body: { user: { password: '[REDACTED]' } },
    });
  });

  it('redacts inside arrays', () => {
    expect(redact({ users: [{ password: 'x' }, { password: 'y' }] })).toEqual({
      users: [{ password: '[REDACTED]' }, { password: '[REDACTED]' }],
    });
  });
});

describe('redact — key normalisation closes the X-API-Key gap', () => {
  it('matches header-style credential keys once separators are stripped', () => {
    const result = redact({
      'X-API-Key': 'sk_live_abc',
      'x-api-key': 'sk_live_abc',
      api_key: 'sk_live_abc',
      'api.key': 'sk_live_abc',
    }) as Record<string, unknown>;

    for (const value of Object.values(result)) {
      expect(value).toBe('[REDACTED]');
    }
  });

  it('recognises additional credential and sensitive-PII key names', () => {
    const result = redact({
      bearerToken: 'x',
      privateKey: 'x',
      cvv: 'x',
      aadhaarNumber: 'x',
      panNumber: 'x',
      creditCardNumber: 'x',
      accountNumber: 'x',
      pwd: 'x',
    }) as Record<string, unknown>;

    for (const value of Object.values(result)) {
      expect(value).toBe('[REDACTED]');
    }
  });

  it('does not widen the match onto ordinary field names that merely contain a credential substring', () => {
    // A future addition of a bare 'auth', 'pin', 'pan' or 'session' would silently gut these
    // real columns — author (Review, BlogPost), shipping (Order), company, the *Number
    // identifiers, and sessionId, which is a traceable identifier rather than a credential.
    expect(
      redact({
        author: 'Asha Rao',
        shipping: 199,
        company: 'Lark Finserv',
        orderNumber: 'NN-2026-000123',
        trackingNumber: 'TRK-9988',
        ticketNumber: 'TCK-4521',
        rfqNumber: 'RFQ-7781',
        sessionId: 'sess_abc123',
      }),
    ).toEqual({
      author: 'Asha Rao',
      shipping: 199,
      company: 'Lark Finserv',
      orderNumber: 'NN-2026-000123',
      trackingNumber: 'TRK-9988',
      ticketNumber: 'TCK-4521',
      rfqNumber: 'RFQ-7781',
      sessionId: 'sess_abc123',
    });
  });
});

describe('redact — a digit inside a listed word is a known, accepted gap', () => {
  it('does not attempt to close the digit-split bypass, because matching digits loosely would reintroduce false positives', () => {
    // Normalising strips symbols but keeps digits, so a digit inserted inside a listed word
    // breaks the contiguous substring the same way a hyphen used to (`api2key`, `api-2-key`).
    // Real-world risk is low — a versioned key name like `x-api-key-2` still matches, since the
    // digit is a trailing suffix rather than a break — so this is documented rather than
    // "fixed" at the cost of false positives on ordinary field names.
    expect(redact({ api2key: 'sk_live_abc', 'api-2-key': 'sk_live_abc' })).toEqual({
      api2key: 'sk_live_abc',
      'api-2-key': 'sk_live_abc',
    });
  });
});

describe('redact — secrets embedded inside error text, not behind a field name', () => {
  it('redacts a Postgres DSN password out of an error message', () => {
    const err = new Error('connect failed: postgres://app_user:hunter2@db.internal:5432/nutwala');
    const result = redact({ error: err }) as { error: { message: string } };
    expect(result.error.message).not.toContain('hunter2');
    expect(result.error.message).toContain('//[REDACTED]@db.internal');
  });

  it('redacts the same DSN password out of an error stack, which is never truncated or scrubbed by generic string handling', () => {
    const err = new Error('query failed');
    err.stack =
      'Error: query failed\n    at Connection (postgres://app_user:hunter2@db.internal:5432/nutwala)';
    const result = redact({ error: err }) as { error: { stack: string } };
    expect(result.error.stack).not.toContain('hunter2');
  });

  it('redacts a Bearer token, a Stripe-style secret key, and a JWT out of an error message', () => {
    const err = new Error(
      'upstream call failed: Authorization Bearer abc.def-GHI, key sk_live_abcDEF123, token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    );
    const result = redact({ error: err }) as { error: { message: string } };
    expect(result.error.message).toContain('Bearer [REDACTED]');
    expect(result.error.message).toContain('sk_live_[REDACTED]');
    expect(result.error.message).toContain('[REDACTED_JWT]');
    expect(result.error.message).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./);
  });

  it('does not apply value-pattern scrubbing to ordinary string fields, only to error message and stack', () => {
    // A bare Bearer-shaped or DSN-shaped string in an unrelated field is left alone: applying
    // these patterns everywhere risks mangling legitimate product descriptions and support text.
    expect(redact({ note: 'ask them to use Bearer token auth on their side' })).toEqual({
      note: 'ask them to use Bearer token auth on their side',
    });
  });
});

describe('redact — an aggregate size budget bounds the whole payload, not just one field', () => {
  it('caps a wide object of many long fields, replacing the remainder with a marker', () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 500; i += 1) wide[`field${i}`] = 'y'.repeat(2000);

    const result = redact(wide);
    const serialised = JSON.stringify(result);

    expect(serialised.length).toBeLessThan(60_000);
    expect(serialised).toContain('TRUNCATED: log entry too large');
  });

  it('caps a long array the same way', () => {
    const items = Array.from({ length: 5000 }, (_, index) => ({ index, note: 'z'.repeat(50) }));

    const result = redact({ items });
    const serialised = JSON.stringify(result);

    expect(serialised.length).toBeLessThan(60_000);
    expect(serialised).toContain('TRUNCATED: log entry too large');
  });
});

describe('redact — contact details are masked, not removed', () => {
  it('masks an email but keeps the domain, so support can still triage', () => {
    expect(redact({ email: 'kunal@example.com' })).toEqual({ email: 'k***@example.com' });
  });

  it('masks a phone number to its last four digits', () => {
    expect(redact({ phone: '9876543210' })).toEqual({ phone: '******3210' });
    expect(redact({ mobile: '9876543210' })).toEqual({ mobile: '******3210' });
  });

  it('masks a GSTIN to its trailing characters', () => {
    expect(redact({ gstin: '27AAPFU0939F1ZV' })).toEqual({ gstin: '***********F1ZV' });
  });

  it('leaves a malformed email masked rather than echoing it', () => {
    expect(redact({ email: 'not-an-email' })).toEqual({ email: '[REDACTED]' });
  });
});

describe('redact — structural safety', () => {
  it('leaves non-sensitive values untouched', () => {
    expect(redact({ orderNumber: 'NN-2026-000123', qty: 3, ok: true })).toEqual({
      orderNumber: 'NN-2026-000123',
      qty: 3,
      ok: true,
    });
  });

  it('replaces a circular reference instead of overflowing the stack', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    expect(redact(node)).toEqual({ name: 'root', self: '[Circular]' });
  });

  it('preserves Date, Error and primitive inputs', () => {
    const when = new Date('2026-08-19T00:00:00.000Z');
    expect(redact({ when })).toEqual({ when: when.toISOString() });
    expect(redact('plain string')).toBe('plain string');
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });

  it('truncates a very long string so one log line cannot flood the transport', () => {
    const result = redact({ body: 'x'.repeat(5000) }) as { body: string };
    expect(result.body.length).toBeLessThan(2100);
    expect(result.body).toMatch(/truncated/);
  });

  it('truncates on a code-point boundary so a surrogate pair is never split', () => {
    // An emoji is one code point but two UTF-16 code units; truncating by code unit could land
    // exactly between the two and leave a lone, invalid surrogate in the output.
    const body = `${'a'.repeat(1999)}\u{1F600}${'b'.repeat(50)}`;
    const result = redact({ body }) as { body: string };

    expect(result.body.startsWith('a'.repeat(1999))).toBe(true);
    // A lone surrogate is not valid UTF-8; encoding and decoding it comes back changed (the
    // engine substitutes U+FFFD), so a round trip is a reliable well-formedness check without
    // relying on the ES2024 String.prototype.isWellFormed() API.
    expect(Buffer.from(result.body, 'utf8').toString('utf8')).toBe(result.body);
  });

  it('does not mutate its input', () => {
    const input = { password: 'hunter2' };
    redact(input);
    expect(input.password).toBe('hunter2');
  });
});
