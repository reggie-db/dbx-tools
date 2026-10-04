/** Pure Node PostgreSQL wire proxy for Databricks Lakebase. */

import { createServer, isIP, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { DatabricksAuthOptions } from "@dbx-tools/auth";
import { LakebaseClient, requireAddress } from "@dbx-tools/lakebase";
import { log } from "@dbx-tools/shared-core";
import { Client } from "pg";

import { fatalError, readStartup, startupComplete } from "./protocol.ts";

const logger = log.logger("lakebase-proxy");

export interface LakebaseProxyOptions {
  host?: string;
  port?: number;
  startupTimeoutMs?: number;
  profile?: string;
}

interface PgConnectionInternals {
  stream: Duplex;
  on(event: "parameterStatus", listener: (message: ParameterStatus) => void): void;
}

type PgClientInternals = Client & {
  connection: Client["connection"] & PgConnectionInternals;
  processID: number;
  secretKey: number;
  _txStatus?: string;
};

interface ParameterStatus {
  parameterName: string;
  parameterValue: string;
}

export class LakebaseProxy {
  private readonly client: LakebaseClient;
  private server?: Server;

  constructor(private readonly options: LakebaseProxyOptions = {}) {
    this.client = new LakebaseClient(
      DatabricksAuthOptions.create({ profile: options.profile }),
    );
  }

  async listen(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error("Lakebase proxy is already listening");
    const host = this.options.host ?? "127.0.0.1";
    if (!isLoopback(host)) throw new Error("Postgres proxy listener must use a loopback address");
    const server = createServer((socket) => void this.handle(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port ?? 5432, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Lakebase listener has no address");
    logger.info("Lakebase proxy listening", { host: address.address, port: address.port });
    return { host: address.address, port: address.port };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  private async handle(local: Socket): Promise<void> {
    const started = Date.now();
    let upstream: Duplex | undefined;
    try {
      local.setNoDelay(true);
      const startup = await readStartup(local, this.options.startupTimeoutMs ?? 30_000);
      const targetText = startup.parameters.database;
      if (!targetText) throw new ProxyFailure("startup database is required", "3D000");
      const target = requireAddress(targetText);
      const startupUser = startup.parameters.user?.trim() || undefined;
      const resolved = await this.client.resolve(target, startupUser);
      const password = await this.client.generateDatabaseCredential(
        resolved.endpoint,
        startupUser,
      );
      const connected = await connectUpstream(resolved, password, startup.parameters);
      upstream = connected.socket;
      local.write(
        startupComplete(
          connected.parameters,
          connected.processId,
          connected.secretKey,
          connected.transactionStatus,
        ),
      );
      local.pipe(upstream).pipe(local);
      await Promise.race([closed(local), closed(upstream)]);
      logger.debug("Lakebase connection closed", {
        durationMs: Date.now() - started,
        project: resolved.project,
        branch: resolved.branch,
        endpoint: resolved.endpoint,
      });
    } catch (error) {
      const failure = error instanceof ProxyFailure ? error : new ProxyFailure(message(error));
      logger.warn("Lakebase connection failed", {
        durationMs: Date.now() - started,
        error: failure.message,
      });
      if (!local.destroyed) local.end(fatalError(failure.message, failure.sqlstate));
    } finally {
      upstream?.destroy();
      local.destroy();
    }
  }
}

async function connectUpstream(
  resolved: Awaited<ReturnType<LakebaseClient["resolve"]>>,
  password: string,
  startup: Record<string, string>,
): Promise<{
  socket: Duplex;
  parameters: Map<string, string>;
  processId: number;
  secretKey: number;
  transactionStatus: string;
}> {
  const client = new Client({
    host: resolved.host,
    port: resolved.port,
    database: resolved.database,
    user: resolved.user,
    password,
    ssl: { rejectUnauthorized: true, servername: resolved.host },
    application_name: startup.application_name,
    connectionTimeoutMillis: 30_000,
  }) as unknown as PgClientInternals;
  const parameters = new Map<string, string>();
  client.on("error", (error) => {
    logger.debug("Lakebase upstream client closed", { error: error.message });
  });
  client.connection.on("parameterStatus", (message) => {
    parameters.set(message.parameterName, message.parameterValue);
  });
  await client.connect();
  const socket = client.connection.stream;
  socket.removeAllListeners("data");
  return {
    socket,
    parameters,
    processId: client.processID,
    secretKey: client.secretKey,
    transactionStatus: client._txStatus ?? "I",
  };
}

function closed(socket: Duplex): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
}

function isLoopback(host: string): boolean {
  if (host === "localhost") return true;
  const version = isIP(host);
  return version === 4 ? host.startsWith("127.") : version === 6 && (host === "::1" || host === "0:0:0:0:0:0:0:1");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ProxyFailure extends Error {
  constructor(message: string, readonly sqlstate = "08001") {
    super(message);
  }
}
