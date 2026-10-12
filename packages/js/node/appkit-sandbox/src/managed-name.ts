import { createHash } from "node:crypto";
import { hash } from "@dbx-tools/shared-core";

const ADJECTIVES = [
  "brisk",
  "bright",
  "calm",
  "clever",
  "cosmic",
  "crisp",
  "daring",
  "gentle",
  "lively",
  "lucky",
  "nimble",
  "quiet",
  "rapid",
  "solar",
  "stellar",
  "swift",
] as const;

const ANIMALS = [
  "badger",
  "capybara",
  "dolphin",
  "falcon",
  "fox",
  "gecko",
  "heron",
  "ibis",
  "jaguar",
  "lemur",
  "otter",
  "panda",
  "quokka",
  "raven",
  "tiger",
  "wombat",
] as const;

const USER_ID_LENGTH = 43;
const NONCE_LENGTH = 8;
const MANAGED_NAME_PREFIX = "dbx-";
const MANAGED_NAME_PATTERN = new RegExp(
  `^${MANAGED_NAME_PREFIX}(?<displayName>[a-z]+-[a-z]+-[0-9a-f]{${NONCE_LENGTH}})_uid_(?<ownerId>[A-Za-z0-9_-]{${USER_ID_LENGTH}})_exp_(?<expiresAt>[0-9]{13})$`,
);

/** Parsed display metadata, owner digest, and expiration from a managed Sandbox name. */
export interface ManagedSandboxName {
  /** Human-readable adjective, animal, and nonce segment. */
  displayName: string;
  /** Base64url SHA-256 digest of the AppKit user ID. */
  ownerId: string;
  /** Absolute expiration as an epoch-millisecond timestamp. */
  expiresAtMs: number;
}

/**
 * Generates a service-managed Sandbox name for one AppKit user.
 *
 * The encoded owner is a one-way digest used for reconciliation. Authorization
 * continues to require a matching Lakebase assignment.
 *
 * @throws When `expiresAtMs` is not a positive safe integer or `nonce` is not
 * eight lowercase hexadecimal characters.
 */
export function createManagedSandboxName(
  userId: string,
  expiresAtMs: number,
  nonce = hash.id(NONCE_LENGTH),
): string {
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) {
    throw new Error("Sandbox expiration must be a positive epoch-millisecond timestamp");
  }
  if (!/^[0-9a-f]{8}$/.test(nonce)) {
    throw new Error("Sandbox name nonce must contain exactly eight lowercase hexadecimal digits");
  }
  const adjective = ADJECTIVES[Number.parseInt(nonce.slice(0, 4), 16) % ADJECTIVES.length]!;
  const animal = ANIMALS[Number.parseInt(nonce.slice(4), 16) % ANIMALS.length]!;
  return `${MANAGED_NAME_PREFIX}${adjective}-${animal}-${nonce}_uid_${sandboxUserId(userId)}_exp_${expiresAtMs}`;
}

/** Parses a valid service-managed Sandbox name, or returns `undefined`. */
export function parseManagedSandboxName(name: string | undefined): ManagedSandboxName | undefined {
  const match = name?.match(MANAGED_NAME_PATTERN);
  if (!match?.groups) return undefined;
  const expiresAtMs = Number(match.groups.expiresAt);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) return undefined;
  return {
    displayName: match.groups.displayName!,
    ownerId: match.groups.ownerId!,
    expiresAtMs,
  };
}

/** Returns whether a name uses the reserved `dbx-` prefix, including malformed names. */
export function isManagedSandboxNameCandidate(name: string | undefined): boolean {
  return Boolean(name?.startsWith(MANAGED_NAME_PREFIX));
}

/** Returns the stable, non-reversible owner digest encoded in managed names. */
export function sandboxUserId(userId: string): string {
  return createHash("sha256").update(userId).digest("base64url");
}
