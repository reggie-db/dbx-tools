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

const NONCE_LENGTH = 8;
const NAME_PREFIX = "dbx-";
const LEGACY_OWNERSHIP_SUFFIX = /_uid_[A-Za-z0-9_-]+_exp_[0-9]+$/;

/**
 * Generates a display name for a service-created Sandbox.
 *
 * Owner identity and expiration are stored in Lakebase, not in this name.
 *
 * @throws When `nonce` is not eight lowercase hexadecimal characters.
 */
export function createSandboxName(nonce = hash.id(NONCE_LENGTH)): string {
  if (!/^[0-9a-f]{8}$/.test(nonce)) {
    throw new Error("Sandbox name nonce must contain exactly eight lowercase hexadecimal digits");
  }
  const adjective = ADJECTIVES[Number.parseInt(nonce.slice(0, 4), 16) % ADJECTIVES.length]!;
  const animal = ANIMALS[Number.parseInt(nonce.slice(4), 16) % ANIMALS.length]!;
  return `${NAME_PREFIX}${adjective}-${animal}-${nonce}`;
}

/**
 * Returns the public Sandbox label, stripping the service prefix and any
 * legacy `_uid_` / `_exp_` suffix left on already-created Databricks names.
 */
export function sandboxDisplayName(name: string | undefined): string {
  if (!name?.trim()) return "sandbox";
  const withoutPrefix = name.startsWith(NAME_PREFIX) ? name.slice(NAME_PREFIX.length) : name;
  return withoutPrefix.replace(LEGACY_OWNERSHIP_SUFFIX, "") || withoutPrefix;
}
