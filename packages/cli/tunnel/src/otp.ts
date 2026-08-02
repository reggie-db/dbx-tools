/**
 * One-time-code store + session JWT for the email-OTP tunnel gate.
 *
 * The code store is backed by AppKit's `CacheManager` (auto-configured to memory,
 * or Lakebase when the app wires a persistent `CacheStorage`), so TTL EXPIRY and
 * eviction are the cache's job - no hand-rolled Map or timers. A 6-digit code is
 * generated with `crypto.randomInt` and stored as a SHA-256 hash with an attempt
 * counter (never the plaintext, never in the JWT); `verify` is constant-time on
 * the hash, and the entry is deleted on success or once attempts are exhausted.
 *
 * The session JWT is an HS256 token (via `jose`) carrying only the email. Its
 * signing key is resolved by `./signing-key.ts`: `TUNNEL_AUTH_JWT_SECRET` when
 * set, else a key persisted in the cache for 30 days so cookies survive the
 * restarts a tunnel sees whenever the app it wraps reloads. A cookie signed
 * before `TUNNEL_AUTH_SESSION_CUTOFF` is refused here as well as being orphaned
 * by the cache key, so the force-clear switch holds even for a still-current key.
 *
 * @module
 */

import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { CacheManager } from "@databricks/appkit";
import { jwtVerify, SignJWT } from "jose";
import { signingKey } from "./signing-key.ts";

/** JWT issuer/audience so a token minted for this gate isn't accepted elsewhere. */
const JWT_AUD = "dbx-tools-tunnel-auth";

/** Cache-key prefix for pending codes, namespaced away from any other cache use. */
const CODE_PREFIX = "tunnel:otp:";

/** SHA-256 hex of a value. */
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time compare of two equal-length hex digests. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

interface CodeEntry {
  hash: string;
  attempts: number;
}

/** Result of {@link CodeStore.verify}. */
export type VerifyOutcome = "ok" | "invalid" | "expired" | "too-many-attempts";

/**
 * Pending one-time codes, stored in AppKit's cache keyed by lowercased email.
 * Expiry is the cache's TTL (no manual clock); a miss means expired-or-never.
 */
export class CodeStore {
  constructor(
    private readonly ttlSeconds: number,
    private readonly maxAttempts: number,
  ) {}

  private cache(): CacheManager {
    return CacheManager.getInstanceSync();
  }

  private key(email: string): string {
    return `${CODE_PREFIX}${email.toLowerCase()}`;
  }

  /**
   * Generate, store (hashed, with the cache TTL), and RETURN a fresh 6-digit
   * code. The caller emails the returned plaintext; only the hash is retained.
   * Replaces any pending code for the address.
   */
  async issue(email: string): Promise<string> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const entry: CodeEntry = { hash: sha256(code), attempts: 0 };
    await this.cache().set(this.key(email), entry, { ttl: this.ttlSeconds });
    return code;
  }

  /**
   * Check `code` for `email`. A cache miss is `expired` (TTL elapsed or never
   * issued). Deletes the entry on success or when attempts are exhausted, so a
   * code is single-use and can't be brute-forced past the cap. An attempt
   * increments the stored counter (re-persisted with a fresh TTL window).
   */
  async verify(email: string, code: string): Promise<VerifyOutcome> {
    const key = this.key(email);
    const entry = await this.cache().get<CodeEntry>(key);
    if (!entry) return "expired";
    const attempts = entry.attempts + 1;
    if (safeEqualHex(entry.hash, sha256(code))) {
      await this.cache().delete(key);
      return "ok";
    }
    if (attempts >= this.maxAttempts) {
      await this.cache().delete(key);
      return "too-many-attempts";
    }
    await this.cache().set(key, { ...entry, attempts }, { ttl: this.ttlSeconds });
    return "invalid";
  }
}

/** Mint a session JWT for `email`, expiring in `ttlSeconds`. */
export async function signSession(email: string, ttlSeconds: number): Promise<string> {
  const { key } = await signingKey();
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(email)
    .setAudience(JWT_AUD)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
}

/** Validate a session JWT, returning the email it was minted for, or `undefined`. */
export async function verifySession(token: string | undefined): Promise<string | undefined> {
  if (!token) return undefined;
  try {
    const { key, cutoffMs } = await signingKey();
    const { payload } = await jwtVerify(token, key, { audience: JWT_AUD });
    // Belt and braces with the cutoff-scoped cache key: that alone already
    // orphans older keys, but an operator who moved the cutoff while
    // TUNNEL_AUTH_JWT_SECRET is set has no key rotation to rely on, and this
    // check is what makes the switch work in that case too.
    // Compared in whole SECONDS because `iat` has no finer resolution: against a
    // millisecond cutoff, a cookie minted in the same second as it would be
    // refused depending on sub-second rounding.
    if (cutoffMs > 0 && (payload.iat === undefined || payload.iat < Math.floor(cutoffMs / 1000))) {
      return undefined;
    }
    return typeof payload.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}
