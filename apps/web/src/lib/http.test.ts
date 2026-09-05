import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The HTTP client's own tests, because three of its rules are invisible from any route test and
 * every one of them has already been got wrong once:
 *
 * 1. **Which 401s trigger a refresh.** An earlier version excluded every `/auth/` path, which
 *    silently broke `POST /auth/logout` — it needs a valid access token to name the session it is
 *    revoking, so after twenty minutes idle it answers 401, no refresh was attempted, and the UI
 *    looked signed out while the session row lived on with a 30-day refresh cookie.
 * 2. **How many refreshes a burst of 401s produces.** More than one is a token replay, which the
 *    backend correctly answers by revoking the whole session family.
 * 3. **Which of those two guarantees survives across tabs.** The in-flight promise is per
 *    JavaScript context, so it cannot. That is what the Web Locks election is for, and the last
 *    two cases here are the difference it makes.
 *
 * The module keeps refresh state at module scope, so each case re-imports it fresh.
 */
type HttpModule = typeof import("./http");

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

async function freshHttp(): Promise<HttpModule> {
  vi.resetModules();
  return import("./http");
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const envelope = (data: unknown) => json(200, { success: true, data });

function errorBody(status: number, message: string, code?: string): Response {
  return json(status, {
    success: false,
    statusCode: status,
    timestamp: "2026-08-19T00:00:00.000Z",
    path: "/api/v1/auth/me",
    method: "GET",
    message,
    ...(code === undefined ? {} : { code }),
    errorId: "e",
    requestId: "r",
  });
}

/**
 * What `JwtAuthGuard` really answers with, measured against the running service: a bare
 * `UnauthorizedException`, so `message` is `"Unauthorized"` and there is **no `code`**. The client
 * must therefore recognise "not signed in" by status alone.
 */
const unauthorized = () => errorBody(401, "Unauthorized");

function stubFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      ...(init?.body === undefined ? {} : { body: String(init.body) }),
    };
    calls.push(call);
    return Promise.resolve(handler(call));
  }) as typeof globalThis.fetch;
  return calls;
}

/** A macrotask, so two "tabs" genuinely overlap inside a handler rather than interleaving. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A real exclusive-lock queue, in the shape of `navigator.locks`.
 *
 * One instance stands in for the browser's per-origin lock, which is why it can be shared between
 * two separately-imported copies of the module — the model of two tabs on one origin.
 */
function serialisingLocks(): { manager: LockManager; names: string[] } {
  const names: string[] = [];
  let chain: Promise<unknown> = Promise.resolve();

  const manager = {
    query: () => Promise.reject(new Error("not used")),
    request: (name: string, callback: (lock: unknown) => unknown) => {
      names.push(name);
      const result = chain.then(() => callback({ name, mode: "exclusive" }));
      // The real API releases the lock whether the holder resolves or throws.
      chain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };

  return { manager: manager as unknown as LockManager, names };
}

function installLocks(manager: LockManager): void {
  Object.defineProperty(navigator, "locks", { value: manager, configurable: true });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  document.cookie = "nn_csrf=; path=/; max-age=0";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  // jsdom has no Web Locks of its own, so removing the property restores the real absence.
  if ("locks" in navigator) Reflect.deleteProperty(navigator, "locks");
  vi.resetModules();
});

describe("apiRequest", () => {
  it("unwraps the success envelope and prefixes the API base", async () => {
    const { http } = await freshHttp();
    const calls = stubFetch(() => envelope({ id: "usr-1" }));

    await expect(http.get<{ id: string }>("/auth/me")).resolves.toEqual({ id: "usr-1" });
    expect(calls[0]?.url).toBe("/api/v1/auth/me");
    expect(calls[0]?.method).toBe("GET");
  });

  it("echoes the CSRF cookie on a state-changing request and never on a GET", async () => {
    const { http } = await freshHttp();
    document.cookie = "nn_csrf=token-abc; path=/";
    const calls = stubFetch(() => envelope(null));

    await http.get("/auth/me");
    await http.post("/auth/logout");

    expect(calls[0]?.headers["X-CSRF-Token"]).toBeUndefined();
    expect(calls[1]?.headers["X-CSRF-Token"]).toBe("token-abc");
  });

  it("keeps a cookie value that contains '=' intact", async () => {
    const { http } = await freshHttp();
    // `randomBytes(32).toString("base64url")` never pads, but reading the cookie with
    // `split("=")[1]` would still truncate any value that did — and a truncated token fails the
    // server's constant-time compare as a 403 with no explanation anywhere.
    document.cookie = "nn_csrf=abc==; path=/";
    const calls = stubFetch(() => envelope(null));

    await http.post("/auth/logout");

    expect(calls[0]?.headers["X-CSRF-Token"]).toBe("abc==");
  });

  it("treats an empty body as a success with nothing to unwrap", async () => {
    const { http } = await freshHttp();
    stubFetch(() => new Response(null, { status: 204 }));

    // Reading `.data` off the parsed `null` would throw a TypeError that reads like a parse bug.
    await expect(http.delete("/account/addresses/addr-1")).resolves.toBeUndefined();
  });

  it("throws an ApiRequestError carrying the backend's status, message and code", async () => {
    const { http, ApiRequestError } = await freshHttp();
    stubFetch(() =>
      errorBody(409, "An account with this email address already exists.", "EMAIL_IN_USE"),
    );

    await expect(http.post("/auth/register", {})).rejects.toMatchObject({
      name: "ApiRequestError",
      status: 409,
      code: "EMAIL_IN_USE",
      message: "An account with this email address already exists.",
    });
    await expect(http.post("/auth/register", {})).rejects.toBeInstanceOf(ApiRequestError);
  });

  it("reports a 429 by status, because a throttled response carries no code", async () => {
    const { http } = await freshHttp();
    // ThrottlerException is not a DomainError, so the envelope has a message and no `code`. Any UI
    // branching on `code` alone sees nothing for the failure a customer hits most easily.
    stubFetch(() =>
      json(429, {
        success: false,
        statusCode: 429,
        message: "ThrottlerException: Too Many Requests",
      }),
    );

    await expect(http.post("/auth/login", {})).rejects.toMatchObject({
      status: 429,
      code: undefined,
    });
  });
});

describe("refresh on 401", () => {
  /**
   * Every scenario below is a **signed-in** client whose 15-minute access token has expired while
   * its 30-day refresh cookie is still good, so `nn_csrf` must be present — a browser in that state
   * always has it, because `CookieService` issues all three cookies together and clears them
   * together.
   *
   * It matters because `apiRequest` now treats a missing `nn_csrf` as "no session" and skips the
   * refresh entirely: without that, every anonymous page load spent a `POST /auth/refresh` that
   * could only 401, against a route limited to 10/min/IP. Clearing the cookie here instead would
   * model a state a real client is never in, and would quietly stop testing the refresh path at all.
   */
  beforeEach(() => {
    document.cookie = "nn_csrf=session-csrf-token; path=/";
  });

  it("refreshes once and retries the original request", async () => {
    const { http } = await freshHttp();
    let refreshed = false;
    const calls = stubFetch((call) => {
      if (call.url.endsWith("/auth/refresh")) {
        refreshed = true;
        return envelope({ csrfToken: "t" });
      }
      return refreshed ? envelope({ id: "usr-1" }) : unauthorized();
    });

    await expect(http.get<{ id: string }>("/auth/me")).resolves.toEqual({ id: "usr-1" });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/v1/auth/me",
      "POST /api/v1/auth/refresh",
      "GET /api/v1/auth/me",
    ]);
  });

  it("does not refresh at all when there is no session cookie to refresh", async () => {
    // An anonymous visitor's very first `GET /auth/me` legitimately 401s. Attempting a refresh
    // there can only 401 too, and it is charged against the refresh route's 10/min/IP limit — so a
    // visitor reloading a public page could rate-limit the endpoint their eventual sign-in needs.
    // `nn_csrf` is absent for exactly this client, which is what makes it a reliable signal.
    document.cookie = "nn_csrf=; path=/; max-age=0";
    const { http } = await freshHttp();
    const calls = stubFetch(() => unauthorized());

    await expect(http.get("/auth/me")).rejects.toMatchObject({ status: 401 });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/v1/auth/me"]);
  });

  it.each(["/auth/login", "/auth/register", "/auth/refresh"])(
    "never refreshes a 401 from %s",
    async (path) => {
      const { http } = await freshHttp();
      const calls = stubFetch(() =>
        errorBody(401, "Invalid email or password.", "INVALID_CREDENTIALS"),
      );

      await expect(http.post(path, {})).rejects.toMatchObject({ status: 401 });
      // One call: refreshing `/auth/refresh` recurses, and on the other two a 401 means the
      // credentials were wrong, so refreshing would be answering the wrong question.
      expect(calls).toHaveLength(1);
    },
  );

  it("does refresh a 401 from /auth/logout, so the session is really revoked", async () => {
    const { http } = await freshHttp();
    let refreshed = false;
    const calls = stubFetch((call) => {
      if (call.url.endsWith("/auth/refresh")) {
        refreshed = true;
        return envelope({ csrfToken: "t" });
      }
      return refreshed
        ? json(200, { success: true, data: null, message: "Signed out." })
        : unauthorized();
    });

    await http.post("/auth/logout");

    // The regression: under a `startsWith("/auth/")` test this was one call and a 401, the UI
    // cleared its snapshot, and the session row was never revoked.
    expect(calls.map((c) => c.url)).toEqual([
      "/api/v1/auth/logout",
      "/api/v1/auth/refresh",
      "/api/v1/auth/logout",
    ]);
  });

  it("surfaces the original 401 when the refresh itself fails", async () => {
    const { http } = await freshHttp();
    const calls = stubFetch((call) =>
      call.url.endsWith("/auth/refresh") ? unauthorized() : unauthorized(),
    );

    await expect(http.get("/auth/me")).rejects.toMatchObject({
      status: 401,
      message: "Unauthorized",
      code: undefined,
    });
    // Two calls, not an infinite chase: the failed refresh ends the attempt.
    expect(calls).toHaveLength(2);
  });

  it("collapses a burst of 401s in one tab into a single refresh", async () => {
    const { http } = await freshHttp();
    let refreshes = 0;
    let refreshed = false;
    stubFetch(async (call) => {
      if (call.url.endsWith("/auth/refresh")) {
        refreshes += 1;
        await tick();
        refreshed = true;
        return envelope({ csrfToken: "t" });
      }
      return refreshed ? envelope({ ok: true }) : unauthorized();
    });

    await Promise.all([http.get("/orders"), http.get("/addresses"), http.get("/auth/me")]);

    // Three refreshes would mean two replays of a rotated token, which the backend reads as
    // theft and answers by revoking the whole family.
    expect(refreshes).toBe(1);
  });
});

describe("cross-tab refresh election", () => {
  /**
   * Every scenario below is a **signed-in** client whose 15-minute access token has expired while
   * its 30-day refresh cookie is still good, so `nn_csrf` must be present — a browser in that state
   * always has it, because `CookieService` issues all three cookies together and clears them
   * together.
   *
   * It matters because `apiRequest` now treats a missing `nn_csrf` as "no session" and skips the
   * refresh entirely: without that, every anonymous page load spent a `POST /auth/refresh` that
   * could only 401, against a route limited to 10/min/IP. Clearing the cookie here instead would
   * model a state a real client is never in, and would quietly stop testing the refresh path at all.
   */
  beforeEach(() => {
    document.cookie = "nn_csrf=session-csrf-token; path=/";
  });

  /**
   * Two tabs, modelled as two separately-imported copies of the module — so each has its own
   * `refreshInFlight`, exactly as two JavaScript contexts do — over one shared server whose
   * rotation is strict about reuse.
   *
   * `presented` is captured before the simulated server latency and re-checked after it, which is
   * the race: two tabs that both read the cookie before either rotation lands present the same
   * token, and the second one to be checked is indistinguishable from a replay.
   */
  function sharedServer() {
    let currentToken = "rt-1";
    let issued = 1;
    let accessValid = false;
    let revoked = false;
    let refreshes = 0;

    const handler = async (call: Call): Promise<Response> => {
      if (call.url.endsWith("/auth/refresh")) {
        refreshes += 1;
        const presented = currentToken;
        await tick();
        if (revoked || presented !== currentToken) {
          // Reuse detected. Revoking the family is correct: two parties presented one token and
          // the server cannot tell which is the thief.
          revoked = true;
          accessValid = false;
          return unauthorized();
        }
        issued += 1;
        currentToken = `rt-${String(issued)}`;
        accessValid = true;
        return envelope({ csrfToken: "t" });
      }
      if (revoked || !accessValid) return unauthorized();
      return envelope({ id: "usr-1" });
    };

    return {
      handler,
      state: {
        get refreshes() {
          return refreshes;
        },
        get revoked() {
          return revoked;
        },
      },
    };
  }

  /** Both "tabs" wake from idle at once with an expired access cookie. */
  async function bothTabsWake(): Promise<{
    results: PromiseSettledResult<unknown>[];
    tabA: HttpModule;
  }> {
    const tabA = await freshHttp();
    const tabB = await freshHttp();
    const results = await Promise.allSettled([
      tabA.http.get("/auth/me"),
      tabB.http.get("/auth/me"),
    ]);
    return { results, tabA };
  }

  it("kills the session when nothing serialises the tabs — the bug being fixed", async () => {
    const server = sharedServer();
    stubFetch(server.handler);
    // No `navigator.locks`: the in-flight promise is per tab and cannot see the other one.
    expect("locks" in navigator).toBe(false);

    const { results, tabA } = await bothTabsWake();

    expect(server.state.refreshes).toBe(2);
    // The family is revoked, which is the server behaving correctly — one token, two presenters.
    expect(server.state.revoked).toBe(true);
    // At least one tab is already dead, and the whole session is: the very next request from the
    // tab whose refresh *succeeded* now 401s too. That is "it randomly logs me out".
    expect(results.some((r) => r.status === "rejected")).toBe(true);
    await expect(tabA.http.get("/auth/me")).rejects.toMatchObject({ status: 401 });
  });

  it("keeps both tabs signed in when navigator.locks elects one refresher", async () => {
    const server = sharedServer();
    stubFetch(server.handler);
    const { manager, names } = serialisingLocks();
    installLocks(manager);

    const { results, tabA } = await bothTabsWake();

    // Both tabs still refresh, and that is fine: the loser only starts once the winner has
    // finished, so it presents the freshly rotated token rather than a replay of the old one.
    expect(names).toEqual(["nn-auth-refresh", "nn-auth-refresh"]);
    expect(server.state.refreshes).toBe(2);
    expect(server.state.revoked).toBe(false);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    await expect(tabA.http.get("/auth/me")).resolves.toEqual({ id: "usr-1" });
  });

  it("still refreshes when a lock request rejects", async () => {
    const { http } = await freshHttp();
    installLocks({
      query: () => Promise.reject(new Error("not used")),
      request: () => Promise.reject(new Error("document is not fully active")),
    } as unknown as LockManager);

    let refreshed = false;
    const calls = stubFetch((call) => {
      if (call.url.endsWith("/auth/refresh")) {
        refreshed = true;
        return envelope({ csrfToken: "t" });
      }
      return refreshed ? envelope({ id: "usr-1" }) : unauthorized();
    });

    // A rejected lock must never be reported as a dead session.
    await expect(http.get<{ id: string }>("/auth/me")).resolves.toEqual({ id: "usr-1" });
    expect(calls).toHaveLength(3);
  });
});
