import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { log } from "@dbx-tools/shared-core";
import type { SshCommandResult } from "@dbx-tools/shared-databricks-sandbox";
import ssh2, { type Client as Ssh2Client, type ClientChannel } from "ssh2";
import { z } from "zod";

const { Client } = ssh2;
const logger = log.logger("appkit-databricks-sandbox:ssh");
const SERVICE_DIRECT_SUFFIX = ".service-direct.cloud.databricks.com";

const DnsAnswerSchema = z
  .object({
    type: z.number().int().describe("DNS record type number."),
    data: z.string().describe("DNS record value."),
  })
  .passthrough()
  .describe("One DNS-over-HTTPS answer record.");

const DnsResponseSchema = z
  .object({
    Answer: z.array(DnsAnswerSchema).optional().describe("Resolved DNS answer records."),
  })
  .passthrough()
  .describe("Google DNS-over-HTTPS JSON response.");

/** Connection, key, host-verification, and command settings for one SSH machine. */
export interface SshSessionOptions {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  privateKeyPath: string;
  knownHostsPath: string;
  connectTimeoutMs: number;
  knownHost?: string;
  rememberHost?: (fingerprint: string, key: Buffer) => Promise<void>;
  sshCommand?: string;
  resolvePublicAddresses?: (host: string) => Promise<string[]>;
}

/** Verified SSH transport using OpenSSH commands and ssh2 direct forwarding. */
export class SshSession {
  private client?: Ssh2Client;
  private connecting?: Promise<Ssh2Client>;
  private connectedHost?: string;

  constructor(private readonly options: SshSessionOptions) {}

  async connect(): Promise<Ssh2Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectWithFallback().catch((error) => {
      this.connecting = undefined;
      throw error;
    });
    return this.connecting;
  }

  private async connectWithFallback(): Promise<Ssh2Client> {
    try {
      return await this.connectHost(this.options.host);
    } catch (error) {
      if (!shouldResolvePublicGateway(this.options.host, error)) throw error;
      const resolveAddresses = this.options.resolvePublicAddresses ?? resolvePublicGatewayAddresses;
      let addresses: string[];
      try {
        addresses = await resolveAddresses(this.options.host);
      } catch (resolveError) {
        logger.warn("public Sandbox gateway resolution failed", {
          host: this.options.host,
          error: resolveError,
        });
        throw error;
      }
      logger.warn("private Sandbox gateway unreachable; retrying public addresses", {
        host: this.options.host,
        addressCount: addresses.length,
      });
      let lastError: unknown = error;
      for (const address of addresses) {
        try {
          return await this.connectHost(address);
        } catch (connectError) {
          lastError = connectError;
        }
      }
      throw lastError;
    }
  }

  private connectHost(host: string): Promise<Ssh2Client> {
    return new Promise<Ssh2Client>((resolve, reject) => {
      const client = new Client();
      let verifiedHost: { fingerprint: string; key: Buffer } | undefined;
      const cleanup = () => {
        if (this.client !== client) return;
        this.client = undefined;
        this.connecting = undefined;
        this.connectedHost = undefined;
      };
      client.once("ready", () => {
        const finish = async () => {
          if (verifiedHost) {
            await this.options.rememberHost?.(verifiedHost.fingerprint, verifiedHost.key);
          }
          this.client = client;
          this.connectedHost = host;
          this.connecting = undefined;
          resolve(client);
        };
        void finish().catch((error) => {
          client.end();
          reject(error);
        });
      });
      client.once("error", (error) => {
        reject(error);
      });
      client.once("close", cleanup);
      client.connect({
        host,
        port: this.options.port,
        username: this.options.username,
        privateKey: this.options.privateKey,
        readyTimeout: this.options.connectTimeoutMs,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => {
          const fingerprint = createHash("sha256").update(key).digest("base64");
          if (this.options.knownHost && fingerprint !== this.options.knownHost) return false;
          verifiedHost = { fingerprint, key: Buffer.from(key) };
          return true;
        },
      });
    });
  }

  async execute(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs: number;
      signal?: AbortSignal;
    },
  ): Promise<SshCommandResult> {
    const startedAt = Date.now();
    await this.connect();
    const script = commandScript(command, args, options.cwd, options.env);
    return new Promise<SshCommandResult>((resolve, reject) => {
      const child = spawn(
        this.options.sshCommand ?? "ssh",
        nativeSshArgs(this.options, script, this.connectedHost ?? this.options.host),
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        timedOut = true;
        child.kill();
      };
      const timer = setTimeout(abort, options.timeoutMs);
      timer.unref?.();
      options.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        const exitCode = timedOut ? 124 : (code ?? 1);
        resolve({
          success: exitCode === 0 && !timedOut,
          exitCode,
          stdout,
          stderr,
          executionTimeMs: Date.now() - startedAt,
          ...(timedOut ? { timedOut: true } : {}),
          command,
          args,
        });
      });
    });
  }

  async forwardOut(remoteHost: string, remotePort: number): Promise<ClientChannel> {
    const client = await this.connect();
    return new Promise((resolve, reject) => {
      client.forwardOut("127.0.0.1", 0, remoteHost, remotePort, (error, channel) =>
        error ? reject(error) : resolve(channel),
      );
    });
  }

  close(): void {
    this.client?.end();
    this.client = undefined;
    this.connecting = undefined;
    this.connectedHost = undefined;
  }
}

/** Resolve the public IPv4 addresses behind a Databricks service-direct gateway. */
export async function resolvePublicGatewayAddresses(
  host: string,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  if (!host.toLowerCase().endsWith(SERVICE_DIRECT_SUFFIX)) return [];
  const response = await fetcher(
    `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`,
    { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(5_000) },
  );
  if (!response.ok) throw new Error(`Public DNS resolution failed (${response.status})`);
  const payload = DnsResponseSchema.parse(await response.json());
  return [
    ...new Set(
      (payload.Answer ?? [])
        .filter((answer) => answer.type === 1 && isIP(answer.data) === 4)
        .map((answer) => answer.data),
    ),
  ];
}

function shouldResolvePublicGateway(host: string, error: unknown): boolean {
  if (!host.toLowerCase().endsWith(SERVICE_DIRECT_SUFFIX)) return false;
  const code =
    (error as { code?: unknown; cause?: { code?: unknown } })?.code ??
    (error as { cause?: { code?: unknown } })?.cause?.code;
  return code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "ETIMEDOUT";
}

function commandScript(
  command: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string> | undefined,
): string {
  const invocation = [command, ...args].map(shellQuote).join(" ");
  const environment = env
    ? Object.entries(env)
        .map(([name, value]) => `${environmentName(name)}=${shellQuote(value)}`)
        .join(" ")
    : "";
  const executable = environment ? `${environment} ${invocation}` : invocation;
  return cwd ? `cd -- ${shellQuote(cwd)} && ${executable}` : executable;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function environmentName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SSH environment variable name: ${value}`);
  }
  return value;
}

function nativeSshArgs(options: SshSessionOptions, script: string, connectHost: string): string[] {
  return [
    "-i",
    options.privateKeyPath,
    "-p",
    String(options.port),
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${options.knownHostsPath}`,
    "-o",
    `HostKeyAlias=[${options.host}]:${options.port}`,
    "-o",
    "LogLevel=ERROR",
    "-o",
    `ConnectTimeout=${Math.max(1, Math.ceil(options.connectTimeoutMs / 1_000))}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    `${options.username}@${connectHost}`,
    script,
  ];
}
