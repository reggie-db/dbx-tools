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

/** Minimal asynchronous secret backend used by JWT, password, and mTLS keys. */
export interface SecretStore {
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
    return {
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
 * Return an explicit or stored secret, generating one under a process lock on
 * first use. The post-write read adopts the value accepted by the backend.
 */
export async function getOrCreateSecret(
  store: SecretStore,
  name: string,
  configured?: string,
): Promise<string> {
  if (configured) return configured;
  const existing = await store.get(name);
  if (existing) return existing;
  return processLock.withProcessLock(["token-broker", "secret", name], async () => {
    const current = await store.get(name);
    if (current) return current;
    const generated = randomBytes(32).toString("base64url");
    await store.set(name, generated);
    return (await store.get(name)) ?? generated;
  });
}

function fileSecretStore(directory: string): SecretStore {
  const pathFor = (name: string) => resolve(directory, `${safeName(name, "Secret")}.secret`);
  return {
    get: async (name) => {
      try {
        return string.trimToNull(await readFile(pathFor(name), "utf8")) ?? undefined;
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
    delete: async (name) => {
      await rm(pathFor(name), { force: true });
    },
  };
}
