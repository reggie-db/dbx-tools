/**
 * The gate's HS256 session-signing key, persisted in AppKit's cache.
 *
 * The key decides whether a session COOKIE still verifies, so it must OUTLIVE the
 * process: a per-process `randomBytes(32)` would invalidate every outstanding cookie
 * on restart and make each signed-in user request a new code - painful for a tunnel,
 * which restarts whenever the app it wraps does. So the key is stored in the cache
 * AppKit already configured (memory, or Lakebase when the host wires a persistent
 * `CacheStorage`), and with persistent storage a restart keeps sessions alive for
 * {@link KEY_TTL_SECONDS}.
 *
 * An explicitly configured `TUNNEL_AUTH_JWT_SECRET` still wins outright. That is
 * the right answer for a fleet: an operator-held secret needs no shared cache and
 * no convergence, and it survives a cache flush.
 *
 * ## get / generate / get
 *
 * Two instances booting at once both miss, so both would generate - and the loser
 * would sign cookies with a key the winner rejects. Resolution is a re-READ after
 * the write: whatever the cache holds afterwards is the key everyone adopts, so
 * the instances converge on ONE value instead of trusting the one they minted.
 * (`set` is not conditional in the cache API - there is no `setnx` to lean on -
 * and this runs once per process, so the extra round-trip is free.)
 *
 * A pathological interleave can still cost a key: if A writes between B's write
 * and B's re-read, B adopts A's key while A adopts its own. The cost is bounded -
 * a cookie minted in that window fails to verify and the holder signs in again -
 * and it cannot produce a key one instance TRUSTS but another rejects for longer
 * than the window itself. Set `TUNNEL_AUTH_JWT_SECRET` to remove the race
 * entirely.
 *
 * ## Forcing every session to end
 *
 * {@link resolveSessionCutoff} reads a date from `TUNNEL_AUTH_SESSION_CUTOFF` (or
 * `--session-cutoff`), and that date is part of the cache KEY. Moving it forward
 * makes every prior key unreachable, so every cookie signed against it stops
 * verifying - the log-everyone-out switch, without having to find and flush a
 * cache entry. The cutoff is also asserted against each token's `iat`, so a
 * cookie that predates it is refused even if it was signed with the key that is
 * somehow still current.
 *
 * @module
 */

import { randomBytes } from "node:crypto";
import { CacheManager } from "@databricks/appkit";
import { env, log, object } from "@dbx-tools/shared-core";
import { JWT_SECRET_ENV, SESSION_CUTOFF_ENV } from "./env.ts";

const logger = log.logger("tunnel:signing-key");

/**
 * How long a cached signing key lives: 30 days.
 *
 * This is the ceiling on how long a session cookie can stay valid across
 * restarts, so it is deliberately >= the default session TTL - a key that expired
 * before the cookies it signed would log everyone out for no reason.
 */
export const KEY_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Cache-key prefix for the signing key, namespaced away from other cache use. */
const KEY_PREFIX = "tunnel:auth:signing-key:";

/** Bytes of entropy in a generated key (256-bit, matching HS256's hash width). */
const KEY_BYTES = 32;

/** What the cache stores: the key plus when it was minted, for observability. */
interface StoredKey {
  /** Base64url of the raw key bytes. */
  secret: string;
  /** When this key was generated, ISO-8601. */
  createdAt: string;
}

/**
 * Resolve the force-clear cutoff as epoch MILLISECONDS, or `0` when unset.
 *
 * Accepts whatever `object.toDate` accepts - a `Date`, `2026-08-02`, an ISO
 * instant, epoch seconds or millis from `date +%s`, or a relative duration
 * (`-30d`, `7 days ago`), which is the spelling an operator reaching for this
 * usually wants: sign out everyone who signed in more than a month ago.
 *
 * An UNPARSEABLE value is ignored with a warning rather than throwing: this is
 * the switch that logs a fleet back in, and failing to boot over a typo is worse
 * than not rotating.
 */
export function resolveSessionCutoff(configured?: string | number | Date): number {
  const raw = configured ?? env.text(SESSION_CUTOFF_ENV) ?? undefined;
  if (raw === undefined || raw === null || raw === "") return 0;

  const date = object.toDate(raw);
  if (!date) {
    logger.warn(`ignoring unparseable ${env.name(SESSION_CUTOFF_ENV)}`, { value: String(raw) });
    return 0;
  }
  return clampToPast(date.getTime());
}

/**
 * Hold the cutoff at "now", because a FUTURE cutoff would refuse the sessions it
 * is about to mint as well as the old ones - an app nobody can sign in to, from a
 * mistyped year, with the fix hidden behind understanding this flag. Clamped, a
 * future date means what an operator setting it always meant: clear everything
 * outstanding, then carry on.
 */
function clampToPast(cutoffMs: number): number {
  const now = Date.now();
  if (cutoffMs <= now) return cutoffMs;
  logger.warn(`${env.name(SESSION_CUTOFF_ENV)} is in the future - clamping to now`, {
    configured: new Date(cutoffMs).toISOString(),
  });
  return now;
}

/** The cache key for one cutoff, so moving the cutoff orphans every earlier key. */
function cacheKey(cutoffMs: number): string {
  return `${KEY_PREFIX}${cutoffMs}`;
}

function decode(stored: StoredKey): Uint8Array {
  return new Uint8Array(Buffer.from(stored.secret, "base64url"));
}

/**
 * Load the signing key for `cutoffMs` from the cache, minting and storing one
 * when absent. See the module docs for why the write is followed by a re-read.
 */
async function loadFromCache(cutoffMs: number): Promise<Uint8Array> {
  const cache = CacheManager.getInstanceSync();
  const key = cacheKey(cutoffMs);

  const existing = await cache.get<StoredKey>(key);
  if (existing?.secret) {
    logger.info("reusing cached signing key", { createdAt: existing.createdAt });
    return decode(existing);
  }

  const minted: StoredKey = {
    secret: Buffer.from(randomBytes(KEY_BYTES)).toString("base64url"),
    createdAt: new Date().toISOString(),
  };
  await cache.set(key, minted, { ttl: KEY_TTL_SECONDS });

  // Re-read rather than trusting `minted`: another instance that raced this boot
  // may have written first, and adopting whatever is stored is what makes the two
  // converge on one key.
  const settled = (await cache.get<StoredKey>(key)) ?? minted;
  logger.info("stored a new signing key", {
    createdAt: settled.createdAt,
    ttlSeconds: KEY_TTL_SECONDS,
    adopted: settled.createdAt === minted.createdAt ? "own" : "concurrent-instance",
  });
  return decode(settled);
}

/** A resolved key plus the cutoff it is scoped to. */
export interface SigningKey {
  key: Uint8Array;
  /** Force-clear cutoff in ms; `0` when unset. Tokens older than this are refused. */
  cutoffMs: number;
}

let pending: Promise<SigningKey> | undefined;

/**
 * The signing key for this gate, resolved once per process.
 *
 * Resolved ONCE, so `configuredCutoff` is honoured only on the first call - the
 * plugin's `setup()` passes its resolved value there, before any request can
 * reach the lazy path.
 *
 * `TUNNEL_AUTH_JWT_SECRET` when set, else the cache-backed key. A cache that is
 * unavailable degrades to an ephemeral per-process key (the previous behaviour)
 * rather than refusing to sign: the key only validates an ALREADY-issued session,
 * so losing it costs sessions, never admission - a caller still needs a code
 * delivered to an allow-listed address.
 */
export function signingKey(configuredCutoff?: string | number | Date): Promise<SigningKey> {
  pending ??= (async () => {
    const cutoffMs = resolveSessionCutoff(configuredCutoff);
    const configured = env.text(JWT_SECRET_ENV);
    if (configured) {
      return { key: new TextEncoder().encode(configured), cutoffMs };
    }
    try {
      return { key: await loadFromCache(cutoffMs), cutoffMs };
    } catch (error) {
      logger.warn(
        `no ${env.name(JWT_SECRET_ENV)} and the cache is unavailable - using an ephemeral per-process key; sessions will not survive a restart`,
        { error },
      );
      return { key: new Uint8Array(randomBytes(KEY_BYTES)), cutoffMs };
    }
  })();
  return pending;
}

/** Reset the per-process key (tests, or after changing the env in-process). */
export function resetSigningKey(): void {
  pending = undefined;
}
