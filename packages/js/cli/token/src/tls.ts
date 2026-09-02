/**
 * Private CA and mTLS certificate provisioning for local broker clients.
 *
 * @module
 */

import "reflect-metadata";

import { randomBytes, webcrypto } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { processLock } from "@dbx-tools/core";
import { json } from "@dbx-tools/shared-core";
import * as x509 from "@peculiar/x509";

import { safeName } from "./_name.ts";
import type { SecretStore } from "./secrets.ts";

const KEY_ALGORITHM = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
} as const;
const SIGNING_ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEAF_RENEWAL_MS = 30 * DAY_MS;
const CA_RENEWAL_MS = 365 * DAY_MS;
const SERVER_DNS_NAMES = ["localhost", "host.docker.internal", "host.containers.internal"];

export interface TlsPaths {
  /** Public CA certificate path. */
  ca: string;
  /** Leaf certificate path. */
  cert: string;
  /** Exported client private-key path. */
  key: string;
}

/** Server certificate paths plus the private key loaded from secret storage. */
export interface BrokerTlsMaterial {
  /** Public CA certificate path. */
  ca: string;
  /** Public server certificate path. */
  cert: string;
  /** Server private key loaded from keychain-backed secret storage. */
  keyPem: string;
  /** Stable directory containing named client bundles. */
  clientDirectory: string;
}

/**
 * Ensure a CA and server leaf covering every listener and container hostname.
 *
 * CA and server private keys stay in the supplied secret store. Public
 * certificates and the SAN record stay on disk. Leaves renew before expiry or
 * whenever the listener SAN set changes.
 */
export async function ensureBrokerTls(
  stateDir: string,
  addresses: readonly string[],
  secrets: SecretStore,
): Promise<BrokerTlsMaterial> {
  setCryptoProvider();
  const directory = resolve(stateDir, "tls");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const ca = await ensureCa(directory, secrets);
  const cert = resolve(directory, "server.crt");
  const sans = [...new Set([...SERVER_DNS_NAMES, ...addresses])].sort();
  const recordedSans = await readJson(resolve(directory, "server.sans.json"));
  let keyPem = await secrets.get("mtls-server-private-key");
  if (
    !Array.isArray(recordedSans) ||
    JSON.stringify(recordedSans) !== JSON.stringify(sans) ||
    !(await certificateFresh(cert, LEAF_RENEWAL_MS)) ||
    !keyPem
  ) {
    keyPem = await issueLeaf({
      ca,
      name: "dbx-tools-token-broker",
      cert,
      server: true,
      sans,
    });
    await secrets.set("mtls-server-private-key", keyPem);
    await writeFile(resolve(directory, "server.sans.json"), `${JSON.stringify(sans, null, 2)}\n`);
  }
  return {
    ca: ca.cert,
    cert,
    keyPem,
    clientDirectory: resolve(directory, "clients"),
  };
}

/**
 * Ensure a named CA-signed client bundle.
 *
 * Client keys are intentionally exportable mode-0600 files because external
 * processes and containers must mount them. They are reissued when the CA
 * changes or the leaf approaches expiry.
 */
export async function ensureClientTls(
  stateDir: string,
  client: string,
  secrets: SecretStore,
  outputDirectory?: string,
): Promise<TlsPaths> {
  setCryptoProvider();
  const name = safeName(client, "Client");
  const directory = resolve(stateDir, "tls");
  const ca = await ensureCa(directory, secrets);
  const clientDirectory = resolve(directory, "clients", name);
  const cert = resolve(clientDirectory, "client.crt");
  const key = resolve(clientDirectory, "client.key");
  const caCopy = resolve(clientDirectory, "ca.crt");
  const caPem = await readFile(ca.cert, "utf8");
  const caMatches = await readFile(caCopy, "utf8")
    .then((existing) => existing === caPem)
    .catch(() => false);
  if (!(await certificateFresh(cert, LEAF_RENEWAL_MS)) || !(await readable(key)) || !caMatches) {
    const keyPem = await issueLeaf({ ca, name, cert, server: false, sans: [] });
    await writeFile(key, keyPem, { mode: 0o600 });
    await chmod(key, 0o600);
  }
  await mkdir(dirname(caCopy), { recursive: true, mode: 0o700 });
  await writeFile(caCopy, caPem, { mode: 0o644 });
  const paths = { ca: caCopy, cert, key };
  if (!outputDirectory) return paths;
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const copied = {
    ca: resolve(output, "ca.crt"),
    cert: resolve(output, "client.crt"),
    key: resolve(output, "client.key"),
  };
  await Promise.all([
    copyFile(paths.ca, copied.ca),
    copyFile(paths.cert, copied.cert),
    copyFile(paths.key, copied.key),
  ]);
  await chmod(copied.key, 0o600);
  return copied;
}

interface CaMaterial {
  cert: string;
  keyPem: string;
}

async function ensureCa(directory: string, secrets: SecretStore): Promise<CaMaterial> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await readCa(directory, secrets);
  if (existing) return existing;
  return processLock.withProcessLock(["token-broker", "ca", directory], async () => {
    const current = await readCa(directory, secrets);
    if (current) return current;
    const cert = resolve(directory, "ca.crt");
    const keys = await generateKeys();
    const now = new Date();
    const certificate = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: serialNumber(),
      name: "CN=dbx-tools token broker CA",
      notBefore: new Date(now.getTime() - DAY_MS),
      notAfter: new Date(now.getTime() + 10 * 365 * DAY_MS),
      signingAlgorithm: SIGNING_ALGORITHM,
      keys,
      extensions: [
        new x509.BasicConstraintsExtension(true, 1, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
          true,
        ),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ],
    });
    const keyPem = await privateKeyPem(keys.privateKey);
    await secrets.set("mtls-ca-private-key", keyPem);
    await writeFile(cert, certificate.toString("pem"), { mode: 0o644 });
    return { cert, keyPem };
  });
}

async function readCa(directory: string, secrets: SecretStore): Promise<CaMaterial | undefined> {
  const cert = resolve(directory, "ca.crt");
  const keyPem = await secrets.get("mtls-ca-private-key");
  return (await certificateFresh(cert, CA_RENEWAL_MS)) && keyPem ? { cert, keyPem } : undefined;
}

async function issueLeaf(options: {
  ca: CaMaterial;
  name: string;
  cert: string;
  server: boolean;
  sans: readonly string[];
}): Promise<string> {
  const caCertificate = new x509.X509Certificate(await readFile(options.ca.cert, "utf8"));
  const caKey = await importPrivateKey(options.ca.keyPem);
  const keys = await generateKeys();
  const now = new Date();
  const extensions: x509.Extension[] = [
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(
      x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
      true,
    ),
    new x509.ExtendedKeyUsageExtension(
      [options.server ? "1.3.6.1.5.5.7.3.1" : "1.3.6.1.5.5.7.3.2"],
      true,
    ),
    await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    await x509.AuthorityKeyIdentifierExtension.create(caCertificate),
  ];
  if (options.sans.length > 0) {
    extensions.push(
      new x509.SubjectAlternativeNameExtension(
        options.sans.map((value) => ({ type: isIP(value) ? "ip" : "dns", value })),
      ),
    );
  }
  const certificate = await x509.X509CertificateGenerator.create({
    serialNumber: serialNumber(),
    issuer: caCertificate.subject,
    subject: `CN=${options.name}`,
    notBefore: new Date(now.getTime() - DAY_MS),
    notAfter: new Date(now.getTime() + 365 * DAY_MS),
    signingAlgorithm: SIGNING_ALGORITHM,
    publicKey: keys.publicKey,
    signingKey: caKey,
    extensions,
  });
  await mkdir(dirname(options.cert), { recursive: true, mode: 0o700 });
  await writeFile(options.cert, certificate.toString("pem"), { mode: 0o644 });
  return privateKeyPem(keys.privateKey);
}

function setCryptoProvider(): void {
  x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);
}

async function generateKeys() {
  return webcrypto.subtle.generateKey(KEY_ALGORITHM, true, ["sign", "verify"]);
}

async function importPrivateKey(pem: string) {
  const [der] = x509.PemConverter.decode(pem);
  if (!der) throw new Error("Private key PEM is empty");
  return webcrypto.subtle.importKey("pkcs8", der, KEY_ALGORITHM, true, ["sign"]);
}

async function privateKeyPem(
  key: Parameters<typeof webcrypto.subtle.exportKey>[1],
): Promise<string> {
  const der = await webcrypto.subtle.exportKey("pkcs8", key);
  return x509.PemConverter.encode(der, "PRIVATE KEY");
}

async function readable(path: string): Promise<boolean> {
  return readFile(path)
    .then(() => true)
    .catch(() => false);
}

async function certificateFresh(path: string, minimumRemainingMs: number): Promise<boolean> {
  try {
    const certificate = new x509.X509Certificate(await readFile(path));
    return certificate.notAfter.getTime() - Date.now() > minimumRemainingMs;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<unknown> {
  return readFile(path, "utf8")
    .then((source) => json.parse(source, undefined))
    .catch(() => undefined);
}

function serialNumber(): string {
  return randomBytes(16).toString("hex");
}
