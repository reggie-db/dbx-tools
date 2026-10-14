/**
 * Deterministic Lakebox user and service-port derivation.
 *
 * One FNV-1a hash of the authenticated identity is the only routing key. It
 * selects the Linux account, UID, persistent home, AppKit route segment, and,
 * with a service name, the loopback service port. Nothing here is persisted:
 * every caller recomputes the same values, and collisions fail closed where
 * they are observed.
 *
 * @module
 */

import { hash } from "@dbx-tools/shared-core";
import type { LakeboxUser } from "@dbx-tools/shared-lakebox";

/** Platform account that owns the persistent volume and the SSH session. */
export const LAKEBOX_AGENT_USER = "sandbox-agent";
/** Persistent home mounted by the platform. Only this path survives a restart. */
export const LAKEBOX_AGENT_HOME = `/home/${LAKEBOX_AGENT_USER}`;
/** Root of package-owned persistent state. */
export const LAKEBOX_STATE_ROOT = `${LAKEBOX_AGENT_HOME}/.dbx-tools`;
/** Persistent backing directories for Lakebox user homes. */
export const LAKEBOX_USERS_ROOT = `${LAKEBOX_STATE_ROOT}/users`;
/** Shared read-only runtime binaries, such as the container bundle and ttyd. */
export const LAKEBOX_RUNTIME_ROOT = `${LAKEBOX_STATE_ROOT}/runtime`;
/** Per-boot runtime state root; reset with the root filesystem. */
export const LAKEBOX_RUN_ROOT = "/run/lakebox";

/** First derived Linux UID. The persistent idmapped volume stores UIDs below 65536. */
export const LAKEBOX_UID_MIN = 20_000;
/** Number of derivable UIDs. */
export const LAKEBOX_UID_COUNT = 40_000;
/** First derived service port. Platform listeners stay below this value. */
export const LAKEBOX_PORT_MIN = 20_000;
/** Number of derivable service ports; the kernel ephemeral range starts at 32768. */
export const LAKEBOX_PORT_COUNT = 12_000;

const USER_PREFIX = "lakebox-";
const HASH_ALPHABET = "0123456789abcdefghijklmnopqrstuv";

/** Normalizes an authenticated identity before hashing. */
export function normalizeLakeboxIdentity(identity: string): string {
  const normalized = identity.trim().toLowerCase();
  if (!normalized) throw new Error("Lakebox users require an authenticated identity");
  return normalized;
}

/**
 * Derives the Lakebox account for one authenticated identity.
 *
 * @param routePrefix - AppKit root for user service routes.
 */
export function lakeboxUser(identity: string, routePrefix: string): LakeboxUser {
  const userHash = digestText("lakebox-user", normalizeLakeboxIdentity(identity));
  const name = `${USER_PREFIX}${userHash}`;
  return {
    hash: userHash,
    name,
    uid: LAKEBOX_UID_MIN + (digestValue("lakebox-uid", userHash) % LAKEBOX_UID_COUNT),
    home: `/home/${name}`,
    routePrefix: `${routePrefix.replace(/\/+$/, "")}/${userHash}`,
  };
}

/** Returns the persistent backing directory for a user hash. */
export function lakeboxPersistentHome(userHash: string): string {
  return `${LAKEBOX_USERS_ROOT}/${userHash}`;
}

/** Derives the loopback port for one user's service. */
export function lakeboxServicePort(userHash: string, serviceName: string): number {
  return (
    LAKEBOX_PORT_MIN + (digestValue("lakebox-port", userHash, serviceName) % LAKEBOX_PORT_COUNT)
  );
}

/** Returns whether a route segment has the shape of a user hash. */
export function isLakeboxUserHash(value: string): boolean {
  return /^[0-9a-v]{7}$/.test(value);
}

function digestText(...values: string[]): string {
  return hash.fnvHashWithOptions({ length: 7, alphabet: HASH_ALPHABET }, ...values);
}

function digestValue(...values: string[]): number {
  return Number.parseInt(digestText(...values), 32);
}
