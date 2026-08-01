/**
 * One-time-code store + session JWT for the email-OTP gate.
 *
 * Two pieces:
 *
 *   - **Code store** - a 6-digit code is generated with `crypto.randomInt` and
 *     kept server-side as a SHA-256 hash with an expiry and an attempt counter
 *     (never the plaintext, never in the JWT). `verifyCode` is constant-time on
 *     the hash, enforces the TTL, and burns the code after too many attempts or
 *     one success. In-memory `Map` keyed by lowercased email - fine for a
 *     single-instance app behind a tunnel.
 *   - **Session JWT** - on a correct code, `signSession` mints a short-lived
 *     HS256 JWT (via `jose`) carrying only the email; `verifySession` validates
 *     it. The signing key comes from `AUTH_JWT_SECRET`; when unset the gate
 *     FAILS OPEN with an ephemeral per-process key (sessions reset on restart)
 *     rather than refusing service - a Databricks App is already access-limited,
 *     so an unset secret degrades to "sessions don't survive restarts", not
 *     "nobody can log in".
 *
 * @module
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { log } from "@dbx-tools/shared-core";

const logger = log.logger("email:auth:otp");

/** JWT issuer/audience so a token minted for this gate isn't accepted elsewhere. */
const JWT_AUD = "dbx-tools-email-auth";

/** SHA-256 hex of a value (for the stored code + a stable key comparison). */
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time compare of two hex digests of equal length. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

interface CodeEntry {
  hash: string;
  expiresAt: number;
  attempts: number;
}

/** Result of {@link CodeStore.verify}. */
export type VerifyOutcome = "ok" | "invalid" | "expired" | "too-many-attempts";

/** In-memory store of pending one-time codes, keyed by lowercased email. */
export class CodeStore {
  private readonly codes = new Map<string, CodeEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxAttempts: number,
  ) {}

  /**
   * Generate, store (hashed), and RETURN a fresh 6-digit code for `email`. The
   * caller emails the returned plaintext; only the hash is retained. Replaces
   * any pending code for the address.
   */
  issue(email: string, now: number = Date.now()): string {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.codes.set(email.toLowerCase(), {
      hash: sha256(code),
      expiresAt: now + this.ttlMs,
      attempts: 0,
    });
    return code;
  }

  /**
   * Check `code` for `email`. Consumes the entry on success or when attempts are
   * exhausted, so a code is single-use and can't be brute-forced past the cap.
   */
  verify(email: string, code: string, now: number = Date.now()): VerifyOutcome {
    const key = email.toLowerCase();
    const entry = this.codes.get(key);
    if (!entry) return "invalid";
    if (now >= entry.expiresAt) {
      this.codes.delete(key);
      return "expired";
    }
    entry.attempts += 1;
    if (safeEqualHex(entry.hash, sha256(code))) {
      this.codes.delete(key);
      return "ok";
    }
    if (entry.attempts >= this.maxAttempts) {
      this.codes.delete(key);
      return "too-many-attempts";
    }
    return "invalid";
  }

  /** Drop every pending code (tests). */
  clear(): void {
    this.codes.clear();
  }
}

/**
 * Resolve the HS256 signing key. Prefers `AUTH_JWT_SECRET`; when unset, mints an
 * ephemeral per-process key (fail-open) and warns once. Memoized so every
 * sign/verify in a process shares one key.
 */
let cachedKey: Uint8Array | undefined;
function signingKey(): Uint8Array {
  if (cachedKey) return cachedKey;
  const secret = process.env.AUTH_JWT_SECRET?.trim();
  if (secret) {
    cachedKey = new TextEncoder().encode(secret);
  } else {
    logger.warn(
      "AUTH_JWT_SECRET is not set - using an ephemeral per-process key; sessions will not survive a restart",
    );
    cachedKey = randomBytes(32);
  }
  return cachedKey;
}

/** Reset the memoized key (tests, or after changing the env in-process). */
export function resetSigningKey(): void {
  cachedKey = undefined;
}

/** Mint a short-lived session JWT for `email`, expiring in `ttlSeconds`. */
export async function signSession(email: string, ttlSeconds: number): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(email)
    .setAudience(JWT_AUD)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(signingKey());
}

/** Validate a session JWT, returning the email it was minted for, or `undefined`. */
export async function verifySession(token: string | undefined): Promise<string | undefined> {
  if (!token) return undefined;
  try {
    const { payload } = await jwtVerify(token, signingKey(), { audience: JWT_AUD });
    return typeof payload.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}
