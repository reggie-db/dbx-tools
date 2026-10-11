import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";
import type { DatabricksSandboxClient } from "./rest.ts";

const { utils } = ssh2;

interface StoredKey {
  privateKey: string;
  privateKeyPath: string;
  publicKey: string;
  keyHash: string;
}

/** Stores user-scoped SSH keys and trusted Databricks gateway host keys. */
export class SshKeyStore {
  constructor(private readonly root = join(homedir(), ".dbx-tools", "appkit-ssh")) {}

  async ensureRegistered(
    api: DatabricksSandboxClient,
    userId: string,
    signal?: AbortSignal,
  ): Promise<StoredKey & { gatewayHost?: string }> {
    const key = await this.loadOrCreate(api.workspaceScope(), userId);
    const keys = await api.listKeys(signal);
    const existing = keys.find((entry) => entry.keyHash === key.keyHash);
    if (existing) {
      return { ...key, ...(existing.gatewayHost ? { gatewayHost: existing.gatewayHost } : {}) };
    }
    const registered = await api.registerKey(key.publicKey, `appkit-ssh:${key.keyHash}`, signal);
    return {
      ...key,
      ...(registered.gatewayHost ? { gatewayHost: registered.gatewayHost } : {}),
    };
  }

  async knownHost(
    scope: string,
    userId: string,
    host: string,
    port: number,
  ): Promise<string | undefined> {
    try {
      const value = await readFile(this.hostFingerprintPath(scope, userId, host, port), "utf8");
      return value.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  knownHostsPath(scope: string, userId: string, host: string, port: number): string {
    return join(this.directory(scope, userId), `host-${digest(`${host}\0${port}`)}.known_hosts`);
  }

  async rememberHost(
    scope: string,
    userId: string,
    host: string,
    port: number,
    fingerprint: string,
    key: Buffer,
  ): Promise<void> {
    const directory = this.directory(scope, userId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const fingerprintPath = this.hostFingerprintPath(scope, userId, host, port);
    const knownHostsPath = this.knownHostsPath(scope, userId, host, port);
    const knownHost = `[${host}]:${port} ${sshKeyAlgorithm(key)} ${key.toString("base64")}\n`;
    await Promise.all([
      writeFile(fingerprintPath, `${fingerprint}\n`, { mode: 0o600 }),
      writeFile(knownHostsPath, knownHost, { mode: 0o600 }),
    ]);
    await Promise.all([chmod(fingerprintPath, 0o600), chmod(knownHostsPath, 0o600)]);
  }

  private async loadOrCreate(scope: string, userId: string): Promise<StoredKey> {
    const directory = this.directory(scope, userId);
    const privatePath = join(directory, "id_ed25519");
    const publicPath = `${privatePath}.pub`;
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
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const generated = utils.generateKeyPairSync("ed25519");
      const privateKey = generated.private;
      const publicKey = generated.public;
      const suffix = `${process.pid}-${Date.now()}`;
      const stagedPrivate = `${privatePath}.${suffix}`;
      const stagedPublic = `${publicPath}.${suffix}`;
      await writeFile(stagedPrivate, privateKey, { mode: 0o600 });
      await writeFile(stagedPublic, `${publicKey.trim()}\n`, { mode: 0o600 });
      await rename(stagedPrivate, privatePath).catch(() => undefined);
      await rename(stagedPublic, publicPath).catch(() => undefined);
      await chmod(privatePath, 0o600);
      await chmod(publicPath, 0o600);
      const storedPublic = await readFile(publicPath, "utf8");
      const storedPrivate = await readFile(privatePath, "utf8");
      return {
        privateKey: storedPrivate,
        privateKeyPath: privatePath,
        publicKey: storedPublic,
        keyHash: publicKeyHash(storedPublic),
      };
    }
  }

  private hostFingerprintPath(scope: string, userId: string, host: string, port: number): string {
    return join(this.directory(scope, userId), `host-${digest(`${host}\0${port}`)}.sha256`);
  }

  private directory(scope: string, userId: string): string {
    return join(this.root, digest(`${scope}\0${userId}`));
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
