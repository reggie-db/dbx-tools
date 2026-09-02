/**
 * Broker secret storage with OS-keychain preference and a mode-0600 fallback.
 *
 * @module
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { processLock } from "@dbx-tools/core";
import { error, log, string } from "@dbx-tools/shared-core";

import { safeName } from "./_name.ts";

const logger = log.logger("token-broker/secrets");

/** Minimal asynchronous secret backend used by JWT and password keys. */
export interface SecretStore {
  /** Stable namespace for cross-process coordination of this backing store. */
  readonly lockScope?: unknown;
  /** Read a secret without creating it. */
  get(name: string): Promise<string | undefined>;
  /** Replace a secret. */
  set(name: string, value: string): Promise<void>;
  /** Remove a secret. */
  delete(name: string): Promise<void>;
}

/**
 * Open the native OS keychain, falling back to protected state files when the
 * platform keyring is unavailable. The fallback is explicit in logs and never
 * changes private-file permissions from mode 0600.
 */
export async function createSecretStore(service: string, stateDir: string): Promise<SecretStore> {
  try {
    const { Entry } = await import("@napi-rs/keyring");
    const probe = new Entry(service, "availability-probe");
    probe.getPassword();
    const lockScope = ["keychain", service];
    return {
      lockScope,
      get: async (name) => string.trimToNull(new Entry(service, name).getPassword()) ?? undefined,
      set: async (name, value) => {
        new Entry(service, name).setPassword(value);
      },
      delete: async (name) => {
        new Entry(service, name).deletePassword();
      },
    };
  } catch (cause) {
    logger.warn("OS keychain unavailable; using protected state files", {
      error: error.errorMessage(cause),
    });
    return fileSecretStore(resolve(stateDir, "secrets"));
  }
}

/**
 * Synchronize an explicit service secret or generate one with check-lock-check.
 *
 * A configured value replaces a different stored value inside the same locked
 * critical section used for first-use generation.
 */
export async function getOrCreateSecret(
  store: SecretStore,
  name: string,
  configured?: string,
): Promise<string> {
  const expected = string.trimToNull(configured) ?? undefined;
  const existing = await store.get(name);
  if (expected && existing === expected) return expected;
  if (!expected && existing) return existing;
  return processLock.withProcessLock(
    ["token-broker", "secret-sync", store.lockScope ?? "unscoped", name],
    async () => {
      const current = await store.get(name);
      if (expected) {
        if (current !== expected) await store.set(name, expected);
        return (await store.get(name)) ?? expected;
      }
      if (current) return current;
      const created = randomBytes(32).toString("base64url");
      await store.set(name, created);
      return (await store.get(name)) ?? created;
    },
  );
}

function fileSecretStore(directory: string): SecretStore {
  const pathFor = (name: string) => resolve(directory, `${safeName(name, "Secret")}.secret`);
  const lockScope = ["secret-files", directory];
  return {
    lockScope,
    get: async (name) => {
      const path = pathFor(name);
      try {
        return string.trimToNull(await readFile(path, "utf8")) ?? undefined;
      } catch {
        return undefined;
      }
    },
    set: async (name, value) => {
      const path = pathFor(name);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, `${value}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
    },
    delete: async (name) => rm(pathFor(name), { force: true }),
  };
}
