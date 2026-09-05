import { describe, expect, it } from "vitest";
import { toQueryString } from "./query-string";

describe("toQueryString", () => {
  it("returns an empty string when there is nothing to send", () => {
    expect(toQueryString({})).toBe("");
    expect(toQueryString({ q: undefined })).toBe("");
  });

  it("prefixes with ? only when there is something to append", () => {
    expect(toQueryString({ q: "badam" })).toBe("?q=badam");
  });

  /**
   * Omitting `undefined` is the whole point. `ShopFilters` clears its checkbox to `undefined` rather
   * than `false`, and the backend's `forbidNonWhitelisted` validation rejects an unknown parameter —
   * so a serialiser that emitted `inStockOnly=undefined` would turn an unticked box into a 400.
   */
  it("omits undefined and null but keeps false and zero", () => {
    expect(toQueryString({ a: undefined, b: null, c: false, d: 0 })).toBe("?c=false&d=0");
  });

  it("encodes values that need it", () => {
    expect(toQueryString({ q: "kaju & badam" })).toBe("?q=kaju+%26+badam");
    expect(toQueryString({ origin: "California, USA" })).toBe("?origin=California%2C+USA");
  });

  /**
   * A literal plus must survive as a plus. `URLSearchParams` writes `application/x-www-form-urlencoded`,
   * where a space is `+`, so it escapes a real `+` to `%2B`; Express's `qs` decodes both back. Seeing
   * `+` in a URL and "fixing" this to `encodeURIComponent` breaks the round trip in the other direction.
   */
  it("escapes a literal plus rather than letting it read as a space", () => {
    expect(toQueryString({ q: "a+b" })).toBe("?q=a%2Bb");
  });

  it("sorts keys so the same filters always produce the same URL", () => {
    // React Query caches on the key, not the URL, but a stable URL keeps HTTP caches and server logs
    // legible and makes a failing request reproducible by copy-paste.
    expect(toQueryString({ sort: "rating", category: "almonds" })).toBe(
      "?category=almonds&sort=rating",
    );
  });
});
