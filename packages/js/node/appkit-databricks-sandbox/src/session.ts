import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { SshCommandResult } from "@dbx-tools/shared-databricks-sandbox";
import ssh2, { type Client as Ssh2Client, type ClientChannel } from "ssh2";

const { Client } = ssh2;

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
}

/** Verified SSH transport using OpenSSH commands and ssh2 direct forwarding. */
export class SshSession {
  private client?: Ssh2Client;
  private connecting?: Promise<Ssh2Client>;

  constructor(private readonly options: SshSessionOptions) {}

  async connect(): Promise<Ssh2Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<Ssh2Client>((resolve, reject) => {
      const client = new Client();
      let verifiedHost: { fingerprint: string; key: Buffer } | undefined;
      const cleanup = () => {
        this.client = undefined;
        this.connecting = undefined;
      };
      client.once("ready", () => {
        const finish = async () => {
          if (verifiedHost) {
            await this.options.rememberHost?.(verifiedHost.fingerprint, verifiedHost.key);
          }
          this.client = client;
          this.connecting = undefined;
          resolve(client);
        };
        void finish().catch((error) => {
          client.end();
          cleanup();
          reject(error);
        });
      });
      client.once("error", (error) => {
        cleanup();
        reject(error);
      });
      client.once("close", cleanup);
      client.connect({
        host: this.options.host,
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
    return this.connecting;
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
      const child = spawn(this.options.sshCommand ?? "ssh", nativeSshArgs(this.options, script), {
        stdio: ["ignore", "pipe", "pipe"],
      });
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
  }
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

function nativeSshArgs(options: SshSessionOptions, script: string): string[] {
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
    "LogLevel=ERROR",
    "-o",
    `ConnectTimeout=${Math.max(1, Math.ceil(options.connectTimeoutMs / 1_000))}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    `${options.username}@${options.host}`,
    script,
  ];
}
