/** Pure Node PostgreSQL wire proxy for Databricks Lakebase. */

import { createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { LakebaseClient, requireAddress } from "@dbx-tools/lakebase";
import { postgresConnectionOptions } from "@dbx-tools/postgres";
import { log, stringUtils } from "@dbx-tools/shared-core";
import { Client } from "pg";

import { CancellationRegistry } from "./cancellation.ts";
import {
  resolveLakebaseProxyOptions,
  type LakebaseProxyOptions,
  type ResolvedLakebaseProxyOptions,
} from "./options.ts";
import {
  fatalError,
  PostgresProtocolError,
  readInitialMessage,
  startupComplete,
  upstreamStartupParameters,
  type CancelMessage,
} from "./protocol.ts";

const logger = log.logger("lakebase-proxy");

interface PgConnectionInternals {
  stream: Duplex;
  on(event: "parameterStatus", listener: (message: ParameterStatus) => void): void;
}

type PgClientInternals = Client & {
  connection: Client["connection"] & PgConnectionInternals;
  processID: number;
  secretKey: number;
  _txStatus?: string;
  getStartupConf(): Record<string, string>;
};

interface ParameterStatus {
  parameterName: string;
  parameterValue: string;
}

/** Loopback PostgreSQL wire proxy backed by Databricks Lakebase credentials. */
export class LakebaseProxy {
  private readonly client: LakebaseClient;
  private readonly options: ResolvedLakebaseProxyOptions;
  private readonly cancellations = new CancellationRegistry();
  private server?: Server;
  private statsTimer?: ReturnType<typeof setInterval>;
  private opened = 0;
  private closed = 0;
  private failed = 0;
  private active = 0;

  constructor(options: LakebaseProxyOptions = {}) {
    this.options = resolveLakebaseProxyOptions(options);
    this.client = new LakebaseClient({ profile: this.options.profile });
  }

  async listen(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error("Lakebase proxy is already listening");
    const host = this.options.listen.host;
    const server = createServer((socket) => void this.handle(socket));
    this.server = server;
    this.statsTimer = setInterval(() => this.reportStats(), 60_000);
    this.statsTimer.unref();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.listen.port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Lakebase listener has no address");
    }
    logger.info("Lakebase proxy listening", { host: address.address, port: address.port });
    return { host: address.address, port: address.port };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  private async handle(local: Socket): Promise<void> {
    const started = Date.now();
    let upstream: Duplex | undefined;
    let cancellation: CancelMessage | undefined;
    this.opened += 1;
    this.active += 1;
    try {
      local.setNoDelay(true);
      const initial = await readInitialMessage(local, this.options.startupTimeoutSeconds * 1000);
      if (initial.kind === "cancel") {
        await this.cancellations.forward(initial);
        local.end();
        return;
      }
      const startup = initial;
      const targetText = startup.parameters.database;
      if (!targetText) throw new ProxyFailure("startup database is required", "3D000");
      let target;
      try {
        target = requireAddress(targetText);
      } catch (error) {
        throw new ProxyFailure(message(error), "3D000");
      }
      const startupUser = stringUtils.trimToUndefined(startup.parameters.user);
      let resolved;
      try {
        resolved = await this.client.resolve(target, startupUser);
      } catch (error) {
        throw new ProxyFailure(message(error), "3D000");
      }
      let password;
      try {
        password = await this.client.generateDatabaseCredential(resolved.endpoint, startupUser);
      } catch (error) {
        throw new ProxyFailure(message(error), "28000");
      }
      let connected;
      try {
        connected = await connectUpstream(
          resolved,
          password,
          postgresConnectionOptions(startup.parameters, this.options.postgresRole),
        );
      } catch (error) {
        throw new ProxyFailure(message(error), "08001");
      }
      upstream = connected.socket;
      cancellation = this.cancellations.register({
        host: resolved.host,
        port: resolved.port,
        processId: connected.processId,
        secretKey: connected.secretKey,
      });
      local.write(
        startupComplete(
          connected.parameters,
          cancellation.processId,
          cancellation.secretKey,
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
      this.failed += 1;
      const failure =
        error instanceof ProxyFailure
          ? error
          : error instanceof PostgresProtocolError
            ? new ProxyFailure(error.message, "08P01")
            : new ProxyFailure(message(error));
      logger.warn("Lakebase connection failed", {
        durationMs: Date.now() - started,
        error: failure.message,
      });
      if (!local.destroyed) local.end(fatalError(failure.message, failure.sqlstate));
    } finally {
      if (cancellation) this.cancellations.remove(cancellation);
      upstream?.destroy();
      local.destroy();
      this.closed += 1;
      this.active -= 1;
    }
  }

  private reportStats(): void {
    logger.info("Lakebase proxy connections", {
      opened: this.opened,
      closed: this.closed,
      failed: this.failed,
      active: this.active,
    });
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
  client.getStartupConf = () =>
    upstreamStartupParameters(startup, resolved.user, resolved.database);
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ProxyFailure extends Error {
  constructor(
    message: string,
    readonly sqlstate = "08001",
  ) {
    super(message);
  }
}
