import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { baseCookieOptions, type CookieSettings } from '../../common/http/cookie-options';

/**
 * One anonymous-visitor key, shared by the cart **and** the wishlist.
 *
 * Not one cookie per feature: two would mean two merge paths on sign-in, two places to get the owner
 * exclusivity constraint right, and a visitor who signed in keeping one list while losing the other.
 *
 * Named in full rather than as `nn_gt`, so `pii-redactor.ts` scrubs it by key. The key is a bearer
 * credential for a basket and a saved-items list: whoever holds it can read and replace both. Plan 1
 * shipped the refresh cookie as `nn_rt`, which normalised to `nnrt` and matched nothing in the
 * redactor's keyword list, so a debug line dumping cookies wrote a live credential to the logs.
 * `guest_token` contains "token" and is caught.
 */
export const GUEST_TOKEN_COOKIE = 'nn_guest_token';

/**
 * 32 random bytes, base64url — 43 characters, comfortably inside the column's 64.
 *
 * Checked against 2000 generated keys: every one is exactly 43 characters and matches, and `base64url`
 * never emits `+`, `/` or `=`, so the character class needs no padding or standard-base64 allowance. A
 * pattern that was even slightly off would reject keys this service had just issued — turning every
 * guest's basket into an empty one on their next request, silently.
 */
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export type GuestCookieSettings = CookieSettings;

/**
 * Reads a guest key, or `undefined` when there is not a valid one.
 *
 * Validated against the shape this service issues rather than passed through. The key goes straight
 * into a `WHERE guest_token = $1`, so an unvalidated value is both an injection surface for anything
 * that later interpolates it and a driver error waiting to happen on a `varchar(64)` column.
 */
export function readGuestToken(request: Request): string | undefined {
  const cookies = (request as { cookies?: Record<string, string> }).cookies;
  const value = cookies?.[GUEST_TOKEN_COOKIE];
  if (!value || !KEY_PATTERN.test(value)) return undefined;
  return value;
}

export function issueGuestToken(response: Response, settings: GuestCookieSettings): string {
  const key = randomBytes(32).toString('base64url');

  response.cookie(GUEST_TOKEN_COOKIE, key, {
    ...baseCookieOptions(settings),
    maxAge: THIRTY_DAYS_MS,
  });
  return key;
}
