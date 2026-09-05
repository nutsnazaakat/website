/** What a query parameter may be before serialisation. */
type QueryValue = string | number | boolean | undefined | null;

/**
 * Serialises filters into a query string, `?` included, or `""` when there is nothing to send.
 *
 * `http.ts` takes an opaque path and offers no query support, so this is the single place list
 * parameters are encoded. `undefined` and `null` are dropped — the shop's filter components clear a
 * value to `undefined`, and the backend rejects unknown or malformed parameters outright, so emitting
 * `inStockOnly=undefined` would turn an unticked checkbox into a 400.
 *
 * `URLSearchParams` writes `application/x-www-form-urlencoded`, so a space becomes `+` and a literal
 * `+` becomes `%2B`. Express parses query strings with `qs`, which decodes both back exactly —
 * verified as a round trip, `kaju & badam` and `a+b` included. Switching to `encodeURIComponent` to
 * "fix" the `+` would break the literal-plus direction.
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
