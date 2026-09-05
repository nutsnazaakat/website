import { z } from "zod";
import type { User } from "./types";

/**
 * A display cache of who is signed in. **Never a credential.**
 *
 * The session itself is three cookies set by the API, two of them httpOnly, which JavaScript
 * cannot read at all. This module holds a copy of the *user record* so that the first paint and
 * the route guards have something to go on before `GET /auth/me` has answered. Tampering with it
 * changes what the UI optimistically renders and nothing else: every request is authorised
 * server-side against the cookie, so a forged snapshot buys an attacker a wrongly-drawn header
 * and a fistful of 401s.
 *
 * It lives outside `AuthProvider` because route guards run in `beforeLoad`, before any component
 * — and therefore any React context — exists. That is why `guards.ts` reads it synchronously.
 *
 * The functions are named `read`/`write`/`clearSnapshot` rather than `Session` for exactly that
 * reason: "session" invited the reading that this is the thing being trusted.
 *
 * The key keeps its Phase 1 value so an existing snapshot still reads after the upgrade.
 */
export const SNAPSHOT_KEY = "nn.auth.v1";

const companySchema = z.object({
  companyName: z.string(),
  contactPerson: z.string(),
  businessType: z.string(),
  gstin: z.string().optional(),
});

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  role: z.enum(["b2c", "b2b", "admin"]),
  company: companySchema.optional(),
  createdAt: z.string(),
});

/** Returns null for an absent, unreadable or malformed snapshot rather than throwing. */
export function readSnapshot(): User | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = userSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeSnapshot(user: User): void {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(user));
  } catch {
    /* storage unavailable — the snapshot stays in memory for this tab only */
  }
}

export function clearSnapshot(): void {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    /* nothing to do: the in-memory state is cleared by the caller regardless */
  }
}
