import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { log, toError } from "@dbx-tools/shared-core";
import ssh2, { type Client as Ssh2Client } from "ssh2";
import { z } from "zod";
import {
  createSshTransport,
  SshCommand,
  sshCommandScript,
  type SshCommandIdentity,
  type SshTransport,
} from "./ssh.ts";
import type { Ssh2PatchMode, SshTransportMode } from "./transport.ts";

const { Client } = ssh2;
const logger = log.logger("lakebox:ssh");
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
  /** Databricks Lakebox gateway hostname. */
  host: string;
  /** SSH gateway port. */
  port: number;
  /** SSH username accepted by the gateway: the Lakebox ID. */
  username: string;
  /** In-memory private key used for the verified SSH handshake and ssh2 fallback. */
  privateKey: string;
  /** Private key file used by native OpenSSH. */
  privateKeyPath: string;
  /** Dedicated OpenSSH known-host file for this workspace, user, and gateway. */
  knownHostsPath: string;
  /** Connection timeout in milliseconds. */
  connectTimeoutMs: number;
  /** SSH transport selected for this session. */
  sshTransport: SshTransportMode;
  /** ssh2 missing-exec-reply patch policy. */
  ssh2Patch: Ssh2PatchMode;
  /** Previously trusted SHA-256 host-key fingerprint. */
  knownHost?: string;
  /** Persists the accepted host key for both ssh2 and native OpenSSH. */
  rememberHost?: (fingerprint: string, key: Buffer) => Promise<void>;
  /** Native OpenSSH executable. Defaults to `ssh` on `PATH`. */
  sshCommand?: string;
  /** Resolves public fallback addresses for a service-direct gateway. */
  resolvePublicAddresses?: (host: string) => Promise<string[]>;
}

/**
 * Verified SSH session that delegates commands and remote TCP connections to
 * the transport selected by `src/ssh.ts`.
 *
 * The initial ssh2 handshake verifies and persists the Databricks gateway host
 * key. The selected transport then starts its pooled command and forwarding
 * resources. Resolved transport and patch policy determine whether the verified
 * client seeds the ssh2 pool or is replaced by native OpenSSH ControlMasters.
 */
export class SshSession {
  private readonly activeCommands = new Set<SshCommand>();
  private readonly pendingClients = new Set<Ssh2Client>();
  private transport?: SshTransport;
  private connecting?: Promise<void>;
  private closing?: Promise<void>;
  private knownHost?: string;
  private closed = false;

  /** Creates a disconnected session. Call {@link connect} or another operation to connect. */
  constructor(private readonly options: SshSessionOptions) {
    this.knownHost = options.knownHost;
  }

  /**
   * Verifies the gateway, resolves its public fallback when necessary, and
   * selects the command and forwarding transport.
   */
  async connect(): Promise<void> {
    if (this.closed) throw new Error("SSH session is closed");
    if (this.transport) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectWithFallback().catch((error) => {
      this.connecting = undefined;
      throw error;
    });
    return this.connecting;
  }

  private async connectWithFallback(): Promise<void> {
    try {
      await this.connectHost(this.options.host);
    } catch (error) {
      if (!shouldResolvePublicGateway(this.options.host, error)) throw error;
      const resolveAddresses = this.options.resolvePublicAddresses ?? resolvePublicGatewayAddresses;
      let addresses: string[];
      try {
        addresses = await resolveAddresses(this.options.host);
      } catch (resolveError) {
        logger.warn("public Lakebox gateway resolution failed", {
          host: this.options.host,
          error: toError(resolveError),
        });
        throw error;
      }
      logger.warn("private Lakebox gateway unreachable; retrying public addresses", {
        host: this.options.host,
        addressCount: addresses.length,
      });
      let lastError: unknown = error;
      for (const address of addresses) {
        try {
          await this.connectHost(address);
          return;
        } catch (connectError) {
          lastError = connectError;
        }
      }
      throw lastError;
    }
  }

  private async connectHost(connectHost: string): Promise<void> {
    if (this.closed) throw new Error("SSH session is closed");
    const client = await this.createVerifiedClient(connectHost, true);
    if (this.closed) {
      client.destroy();
      throw new Error("SSH session is closed");
    }
    try {
      const transport = await createSshTransport({
        host: this.options.host,
        connectHost,
        port: this.options.port,
        username: this.options.username,
        privateKeyPath: this.options.privateKeyPath,
        knownHostsPath: this.options.knownHostsPath,
        connectTimeoutMs: this.options.connectTimeoutMs,
        ssh2Client: client,
        createSsh2CommandClient: () => this.createVerifiedClient(connectHost, false),
        transport: this.options.sshTransport,
        ssh2Patch: this.options.ssh2Patch,
        ...(this.options.sshCommand ? { sshCommand: this.options.sshCommand } : {}),
      });
      if (this.closed) {
        await transport.close();
        throw new Error("SSH session is closed");
      }
      this.transport = transport;
      this.connecting = undefined;
      if (transport.kind === "openssh") client.destroy();
    } catch (error) {
      client.destroy();
      throw error;
    }
  }

  private createVerifiedClient(connectHost: string, rememberHost: boolean): Promise<Ssh2Client> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("SSH session is closed"));
        return;
      }
      const client = new Client();
      this.pendingClients.add(client);
      let verifiedHost: { fingerprint: string; key: Buffer } | undefined;
      let settled = false;
      const finishSettlement = () => {
        this.pendingClients.delete(client);
      };
      client.once("ready", () => {
        const finish = async () => {
          if (!verifiedHost) throw new Error("SSH gateway did not provide a verified host key");
          this.knownHost = verifiedHost.fingerprint;
          if (rememberHost) {
            await this.options.rememberHost?.(verifiedHost.fingerprint, verifiedHost.key);
          }
          settled = true;
          finishSettlement();
          resolve(client);
        };
        void finish().catch((error) => {
          client.destroy();
          if (settled) return;
          settled = true;
          finishSettlement();
          reject(error);
        });
      });
      client.once("error", (error) => {
        if (settled) return;
        settled = true;
        finishSettlement();
        reject(error);
      });
      client.once("close", () => {
        if (settled) return;
        settled = true;
        finishSettlement();
        reject(new Error("SSH gateway closed before authentication completed"));
      });
      try {
        client.connect({
          host: connectHost,
          port: this.options.port,
          username: this.options.username,
          privateKey: this.options.privateKey,
          readyTimeout: this.options.connectTimeoutMs,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 3,
          hostVerifier: (key: Buffer) => {
            const fingerprint = createHash("sha256").update(key).digest("base64");
            if (this.knownHost && fingerprint !== this.knownHost) return false;
            verifiedHost = { fingerprint, key: Buffer.from(key) };
            return true;
          },
        });
      } catch (error) {
        settled = true;
        finishSettlement();
        client.destroy();
        reject(error);
      }
    });
  }

  /**
   * Starts one command as a Lakebox user and returns its live output and
   * completion state immediately.
   */
  execute(
    command: string,
    args: string[],
    options: {
      user: { name: string; home: string };
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs: number;
      signal?: AbortSignal;
    },
  ): SshCommand {
    const { user, ...rest } = options;
    return this.startCommand(command, args, rest, { kind: "user", ...user });
  }

  /**
   * @internal Starts one fixed package-owned bootstrap command as root.
   *
   * Never route REST, agent-tool, service, or environment input here.
   */
  executePrivileged(
    command: string,
    args: string[],
    options: { timeoutMs: number; signal?: AbortSignal },
  ): SshCommand {
    return this.startCommand(command, args, options, { kind: "root" });
  }

  private startCommand(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs: number;
      signal?: AbortSignal;
    },
    identity: SshCommandIdentity,
  ): SshCommand {
    const script = sshCommandScript(command, args, options.cwd, options.env, identity);
    const sshCommand = new SshCommand(command, args, options, async (execution) => {
      await this.connect();
      if (execution.signal.aborted) return 130;
      const transport = this.transport;
      if (!transport) throw new Error("SSH transport did not initialize");
      return transport.run(script, execution);
    });
    this.activeCommands.add(sshCommand);
    const remove = () => this.activeCommands.delete(sshCommand);
    void sshCommand.result.then(remove, remove);
    return sshCommand;
  }

  /** Opens a remote TCP connection through native SOCKS5 or ssh2 direct forwarding. */
  async forwardOut(remoteHost: string, remotePort: number): Promise<Duplex> {
    await this.connect();
    const transport = this.transport;
    if (!transport) throw new Error("SSH transport did not initialize");
    return transport.connect(remoteHost, remotePort);
  }

  /** Cancels active commands, closes the selected transport, and clears connection state. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.closeResources();
    return this.closing;
  }

  private async closeResources(): Promise<void> {
    const cancellations = [...this.activeCommands].map((command) => command.cancel());
    this.activeCommands.clear();
    for (const client of this.pendingClients) client.destroy();
    this.pendingClients.clear();
    const transport = this.transport;
    const connecting = this.connecting;
    this.transport = undefined;
    this.connecting = undefined;
    const results = await Promise.allSettled([
      ...cancellations,
      ...(transport ? [transport.close()] : []),
      ...(connecting ? [connecting] : []),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        logger.warn("failed to close SSH session resource", {
          error: toError(result.reason),
        });
      }
    }
  }
}

/**
 * Resolves public IPv4 addresses for a Databricks service-direct gateway.
 *
 * Returns an empty list for other hostnames. DNS-over-HTTPS requests time out
 * after five seconds and reject invalid responses.
 */
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
  return (
    code === "ECONNREFUSED" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "ETIMEDOUT"
  );
}
