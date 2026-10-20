import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "@dbx-tools/core";
import ssh2 from "ssh2";
import type { LakeboxClient } from "./rest.ts";

const { utils } = ssh2;

interface StoredKey {
  privateKey: string;
  privateKeyPath: string;
  publicKey: string;
  keyHash: string;
}

/**
 * Stores caller-scoped SSH keys and trusted Databricks gateway host keys.
 *
 * Each workspace and caller identity receives a separate Ed25519 key pair. The
 * store writes private keys, gateway fingerprints, and OpenSSH known-host files
 * with owner-only permissions beneath the configured root directory.
 */
export class SshKeyStore {
  /** Creates a key store rooted at the default dbx-tools application-data path. */
  constructor(private readonly root = join(homedir(), ".dbx-tools", "lakebox")) {}

  /**
   * Loads or creates the caller key pair and registers its public key when the
   * workspace does not already contain the matching key hash.
   *
   * @returns The local key material and the gateway host returned by Databricks,
   * when available.
   */
  async ensureRegistered(
    api: LakeboxClient,
    owner: string,
    signal?: AbortSignal,
  ): Promise<StoredKey & { gatewayHost?: string }> {
    const key = await this.loadOrCreate(await api.workspaceScope(), owner);
    const keys = await api.listKeys(signal);
    const existing = keys.find((entry) => entry.keyHash === key.keyHash);
    if (existing) {
      return { ...key, ...(existing.gatewayHost ? { gatewayHost: existing.gatewayHost } : {}) };
    }
    const registered = await api.registerKey(
      key.publicKey,
      `dbx-tools-lakebox:${key.keyHash}`,
      signal,
    );
    return {
      ...key,
      ...(registered.gatewayHost ? { gatewayHost: registered.gatewayHost } : {}),
    };
  }

  /** Returns the stored SHA-256 gateway fingerprint, or `undefined` when untrusted. */
  async knownHost(
    scope: string,
    owner: string,
    host: string,
    port: number,
  ): Promise<string | undefined> {
    try {
      const value = await readFile(this.hostFingerprintPath(scope, owner, host, port), "utf8");
      return value.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** Returns the OpenSSH known-host file path for one workspace, user, and gateway. */
  knownHostsPath(scope: string, owner: string, host: string, port: number): string {
    return join(this.directory(scope, owner), `host-${digest(`${host}\0${port}`)}.known_hosts`);
  }

  /** Stores the accepted gateway fingerprint and OpenSSH host-key entry. */
  async rememberHost(
    scope: string,
    owner: string,
    host: string,
    port: number,
    fingerprint: string,
    key: Buffer,
  ): Promise<void> {
    const directory = this.directory(scope, owner);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const fingerprintPath = this.hostFingerprintPath(scope, owner, host, port);
    const knownHostsPath = this.knownHostsPath(scope, owner, host, port);
    const knownHost = `[${host}]:${port} ${sshKeyAlgorithm(key)} ${key.toString("base64")}\n`;
    await Promise.all([
      writeFile(fingerprintPath, `${fingerprint}\n`, { mode: 0o600 }),
      writeFile(knownHostsPath, knownHost, { mode: 0o600 }),
    ]);
    await Promise.all([chmod(fingerprintPath, 0o600), chmod(knownHostsPath, 0o600)]);
  }

  private async loadOrCreate(scope: string, owner: string): Promise<StoredKey> {
    const directory = this.directory(scope, owner);
    const privatePath = join(directory, "id_ed25519");
    const publicPath = `${privatePath}.pub`;
    const stored = await readStoredKey(privatePath, publicPath);
    if (stored) return stored;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return withFileLock(["lakebox-ssh-key", privatePath], async () => {
      const rechecked = await readStoredKey(privatePath, publicPath);
      if (rechecked) return rechecked;

      const generated = utils.generateKeyPairSync("ed25519");
      const privateKey = generated.private;
      const publicKey = generated.public;
      const suffix = `${process.pid}-${randomBytes(8).toString("hex")}`;
      const stagedPrivate = `${privatePath}.${suffix}`;
      const stagedPublic = `${publicPath}.${suffix}`;
      try {
        await writeFile(stagedPrivate, privateKey, { mode: 0o600 });
        await writeFile(stagedPublic, `${publicKey.trim()}\n`, { mode: 0o600 });
        await rename(stagedPrivate, privatePath);
        await rename(stagedPublic, publicPath);
        await Promise.all([chmod(privatePath, 0o600), chmod(publicPath, 0o600)]);
        const created = await readStoredKey(privatePath, publicPath);
        if (!created) throw new Error("SSH key files were not published atomically");
        return created;
      } finally {
        await Promise.all([rm(stagedPrivate, { force: true }), rm(stagedPublic, { force: true })]);
      }
    });
  }

  private hostFingerprintPath(scope: string, owner: string, host: string, port: number): string {
    return join(this.directory(scope, owner), `host-${digest(`${host}\0${port}`)}.sha256`);
  }

  private directory(scope: string, owner: string): string {
    return join(this.root, digest(`${scope}\0${owner}`));
  }
}

async function readStoredKey(
  privatePath: string,
  publicPath: string,
): Promise<StoredKey | undefined> {
  try {
    const [privateKey, publicKey] = await Promise.all([
      readFile(privatePath, "utf8"),
      readFile(publicPath, "utf8"),
    ]);
    return {
      privateKey,
      privateKeyPath: privatePath,
      publicKey,
      keyHash: publicKeyHash(publicKey),
    };
  } catch {
    return undefined;
  }
}

function publicKeyHash(publicKey: string): string {
  const normalized = publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
  return createHash("sha256").update(normalized).digest().subarray(0, 16).toString("hex");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function sshKeyAlgorithm(key: Buffer): string {
  if (key.length < 5) throw new Error("SSH gateway returned an invalid host key");
  const length = key.readUInt32BE(0);
  const end = 4 + length;
  if (length === 0 || end > key.length) throw new Error("SSH gateway returned an invalid host key");
  const algorithm = key.subarray(4, end).toString("ascii");
  if (/\s/.test(algorithm)) throw new Error("SSH gateway returned an invalid host key algorithm");
  return algorithm;
}
