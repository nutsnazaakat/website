/** What a query parameter may be before serialisation. */
type QueryValue = string | number | boolean | undefined | null;

/**
 * Serialises filters into a query string, `?` included, or `""` when there is nothing to send.
 *
 * Copied from the storefront for the same reason `http.ts` was: `http.ts` takes an opaque path and
 * offers no query support, so this is the single place list parameters are encoded.
 *
 * `undefined` and `null` are dropped, and here that is not merely tidy — it is required. The
 * backend's global `ValidationPipe` runs with `forbidNonWhitelisted`, and every admin query DTO
 * marks its filters `@IsOptional()`, so emitting `status=undefined` would turn a cleared dropdown
 * into a **400**, not an ignored parameter. `GET /admin/orders` has no free-text `search` parameter
 * at all, and sending one is likewise a 400 rather than a no-op.
 *
 * `URLSearchParams` writes `application/x-www-form-urlencoded`, so a space becomes `+` and a literal
 * `+` becomes `%2B`. Express parses query strings with `qs`, which decodes both back exactly.
 * Switching to `encodeURIComponent` to "fix" the `+` would break the literal-plus direction.
 */
export function toQueryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const serialised = search.toString();
  return serialised.length > 0 ? `?${serialised}` : "";
}
