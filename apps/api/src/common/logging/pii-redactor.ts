/**
 * Recursive log scrubber, modelled on the `sanitize()` in both cug and mf-lenders-gateway.
 *
 * The one thing it does differently: credentials are removed, but contact details are
 * *masked*. A support engineer reading logs needs to tell one customer's request from
 * another's; `[REDACTED]` everywhere makes an incident unreadable, while a full email
 * address in a log aggregator is a data-protection problem. Masking keeps both properties.
 */

/** Substring-matched against lowercased key names. Anything matching is removed outright. */
const CREDENTIAL_KEY_PARTS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'bearer',
  'authorization',
  'cookie',
  'csrf',
  'apikey',
  'privatekey',
  'jwt',
  'otp',
  'hash',
  'signature',
  'cvv',
  'aadhaar',
  'pannumber',
  'creditcard',
  'cardnumber',
  'accountnumber',
  'credential',
] as const;

/**
 * Redacted on an **exact** key match only.
 *
 * `rt` and `at` are the conventional abbreviations for a refresh and an access token, so a field
 * named either almost certainly holds one. They cannot be substrings: `rt` appears inside `cart`,
 * `part`, `sort`, `alert` and `report`, and `at` inside more or less everything. A redactor that
 * scrubs `cart` has destroyed the log line someone actually needed.
 *
 * `sid` is deliberately **not** here, for the same reason `session` is not in the list above: it
 * conventionally means session *id*, which is an identifier rather than a credential. Including it
 * would have contradicted that reasoning inside the same file.
 *
 * The honest limit of exact matching: a prefixed variant like `x-rt` normalises to `xrt` and is not
 * caught. That is the trade — substring matching for two-letter tokens costs far more in destroyed
 * log lines than it buys. Nothing in this service uses these keys today; the cookies are named
 * `nn_access_token` and `nn_refresh_token` precisely so the substring rules above catch them, and
 * this is a net for code not yet written.
 */
const CREDENTIAL_KEYS_EXACT = new Set(['rt', 'at']);

/**
 * Deliberately **not** redacted: `session` and `sessionId`.
 *
 * A session id is not a credential. It is not sufficient to authenticate — it identifies a row, and
 * a caller still needs the signed JWT that carries it — and it is the single most useful value for
 * tracing a request through revocation, rotation and logout. Redacting it would blind exactly the
 * investigations this logger exists to support. A review listed it as a blind spot; keeping it is a
 * decision, not an oversight.
 */

/** Exact-matched (lowercased) keys whose values are masked rather than removed. */
const MASKED_KEYS = new Set(['email', 'phone', 'mobile', 'gstin', 'pincode']);

const REDACTED = '[REDACTED]';
const MAX_STRING_LENGTH = 2000;

/**
 * Total budget for one redacted payload, in characters. Capping each leaf string alone still
 * lets a wide object (hundreds of fields) or a long array (thousands of items) balloon a single
 * log line into megabytes — a 500-field object at ~2000 chars each serialises to roughly 1MB,
 * a 5000-item array to hundreds of KB, and both are reachable from one request body (a bulk RFQ,
 * a long note). This bounds the whole entry instead of just one field. 32KB comfortably holds a
 * normal request/response body while still fitting inside most transports' per-line limits.
 */
const MAX_TOTAL_LENGTH = 32 * 1024;
const BUDGET_EXCEEDED = '[TRUNCATED: log entry too large]';

/**
 * Value-level scrubbing, applied only to error messages and stacks.
 *
 * Key-name matching cannot help here: a driver error carries its secret inside the text, not
 * behind a recognisable field name. `pg` and TypeORM both quote the connection string or the
 * failing query on failure, and `GlobalExceptionFilter` logs the raw exception on every 5xx.
 * These patterns are deliberately narrow — each matches a shape that is almost never anything
 * but a credential, because a false positive here silently destroys debuggability. They are not
 * applied to arbitrary payload strings, only to `Error.message` and `Error.stack`, for the same
 * reason: a bare "Bearer" or "//" in a product description or a support message must survive.
 */
const VALUE_PATTERNS: readonly [RegExp, string][] = [
  // postgres://user:password@host — the DSN form pg errors quote verbatim
  [/\/\/[^\s:/@]+:[^\s@]+@/g, '//[REDACTED]@'],
  [/\bBearer\s+[\w\-._~+/]+=*/gi, 'Bearer [REDACTED]'],
  [/\bsk_(live|test)_[A-Za-z0-9]+/g, 'sk_$1_[REDACTED]'],
  // A JWT's three base64url segments
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]'],
];

function scrubKnownSecrets(text: string): string {
  return VALUE_PATTERNS.reduce(
    (scrubbed, [pattern, replacement]) => scrubbed.replace(pattern, replacement),
    text,
  );
}

function isCredentialKey(key: string): boolean {
  // Separators are stripped before matching. A plain substring check on the raw key misses
  // `x-api-key` entirely — the hyphens break `apikey` apart — which silently leaked the most
  // common API-key header name in existence. Normalising collapses `X-API-Key`, `api_key` and
  // `api.key` onto the same token.
  //
  // Known, accepted boundary: digits are kept, not stripped, so a digit *inside* a listed word
  // still breaks the match the same way a hyphen used to (`api2key`, `api-2-key` leak). Matching
  // digits loosely to close this would trade a narrow, low-likelihood gap for false positives on
  // ordinary field names — the same hazard the false-positive guards below exist to avoid. A
  // versioned key like `x-api-key-2` is unaffected, since the digit is a trailing suffix there.
  const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (CREDENTIAL_KEYS_EXACT.has(normalised)) return true;
  return CREDENTIAL_KEY_PARTS.some((part) => normalised.includes(part));
}

function maskEmail(value: string): string {
  const at = value.indexOf('@');
  // A value that is not shaped like an email may be anything; do not echo it.
  if (at < 1 || at === value.length - 1) return REDACTED;
  return `${value[0] ?? ''}***${value.slice(at)}`;
}

function maskTail(value: string, visible: number): string {
  if (value.length <= visible) return REDACTED;
  return `${'*'.repeat(value.length - visible)}${value.slice(-visible)}`;
}

function maskValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return value;
  switch (key.toLowerCase()) {
    case 'email':
      return maskEmail(value);
    case 'phone':
    case 'mobile':
      return maskTail(value, 4);
    case 'gstin':
      return maskTail(value, 4);
    case 'pincode':
      return maskTail(value, 2);
    default:
      return value;
  }
}

function truncate(value: string): string {
  // Sliced by Unicode code point, not UTF-16 code unit: a cut at a fixed code-unit offset can
  // land inside a surrogate pair and leave a lone, invalid surrogate in the output. Review and
  // support-ticket text routinely carries emoji, so this matters in practice.
  const codePoints = Array.from(value);
  if (codePoints.length <= MAX_STRING_LENGTH) return value;
  const sliced = codePoints.slice(0, MAX_STRING_LENGTH).join('');
  return `${sliced}… [truncated ${codePoints.length - MAX_STRING_LENGTH} chars]`;
}

/** Mutable running total, shared across one `redact()` call, so the size cap applies to the
 * whole payload rather than resetting at every branch. */
interface Budget {
  remaining: number;
}

function charge(budget: Budget, text: string): string {
  budget.remaining -= text.length;
  return text;
}

function walk(value: unknown, seen: WeakSet<object>, budget: Budget): unknown {
  if (budget.remaining <= 0) return BUDGET_EXCEEDED;
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return charge(budget, truncate(value));
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return charge(budget, value.toString());
  if (typeof value === 'function') return '[Function]';

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const message = charge(budget, truncate(scrubKnownSecrets(value.message)));
    const stack =
      value.stack === undefined
        ? undefined
        : charge(budget, truncate(scrubKnownSecrets(value.stack)));
    return { name: value.name, message, stack };
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (const item of value) {
        if (budget.remaining <= 0) {
          output.push(BUDGET_EXCEEDED);
          break;
        }
        output.push(walk(item, seen, budget));
      }
      return output;
    }

    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (budget.remaining <= 0) {
        output['[truncated]'] = BUDGET_EXCEEDED;
        break;
      }
      if (isCredentialKey(key)) {
        output[key] = REDACTED;
      } else if (MASKED_KEYS.has(key.toLowerCase())) {
        output[key] = maskValue(key, child);
      } else {
        output[key] = walk(child, seen, budget);
      }
    }
    return output;
  }

  return REDACTED;
}

/** Returns a scrubbed deep copy. Never mutates its input. */
export function redact(value: unknown): unknown {
  return walk(value, new WeakSet<object>(), { remaining: MAX_TOTAL_LENGTH });
}
