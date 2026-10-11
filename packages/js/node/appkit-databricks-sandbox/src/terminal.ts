import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { WorkspaceClient } from "@databricks/appkit";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { log } from "@dbx-tools/shared-core";
import type { Response } from "express";

const logger = log.logger("appkit-databricks-sandbox:terminal");

interface ProcessEvent {
  start?: { command_id?: string };
  data?: { pty?: Uint8Array; stdout?: Uint8Array; stderr?: Uint8Array };
  end?: { exit_code?: number };
}

interface ExecuteResponse {
  process_event?: ProcessEvent;
}

interface ClientWritableStream {
  write(value: unknown): boolean;
  end(): void;
  cancel(): void;
}

interface ClientReadableStream {
  on(event: "data", listener: (value: ExecuteResponse) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "end", listener: () => void): this;
  cancel(): void;
}

interface SandboxServiceClient {
  ExecuteCommand(request: unknown, metadata: grpc.Metadata): ClientReadableStream;
  StreamInput(
    metadata: grpc.Metadata,
    callback: (error: Error | null) => void,
  ): ClientWritableStream;
  close(): void;
}

type SandboxServiceConstructor = new (
  address: string,
  credentials: grpc.ChannelCredentials,
) => SandboxServiceClient;

interface TerminalSession {
  userId: string;
  response: Response;
  client: SandboxServiceClient;
  output: ClientReadableStream;
  input?: ClientWritableStream;
  pending: Buffer[];
}

/** Bridges App-compatible HTTP streams to the Sandbox PTY gRPC service. */
export class SandboxTerminalServer {
  private readonly sessions = new Map<string, TerminalSession>();

  async open(
    workspace: WorkspaceClient,
    userId: string,
    machineId: string,
    response: Response,
    dimensions: { cols: number; rows: number },
  ): Promise<void> {
    const sessionId = randomUUID();
    const client = await createSandboxClient(workspace);
    const metadata = new grpc.Metadata();
    metadata.set("x-databricks-sandbox-name", `sandboxes/${machineId}`);
    response.status(200);
    response.setHeader("content-type", "application/octet-stream");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("x-accel-buffering", "no");
    response.setHeader("x-terminal-session-id", sessionId);
    response.flushHeaders();
    const output = client.ExecuteCommand(
      {
        cmd: "/bin/bash",
        args: ["--login"],
        pty: dimensions,
        envs: { TERM: "xterm-256color" },
      },
      metadata,
    );
    const session: TerminalSession = { userId, response, client, output, pending: [] };
    this.sessions.set(sessionId, session);
    output.on("data", (message) => {
      const event = message.process_event;
      const bytes = event?.data?.pty ?? event?.data?.stdout ?? event?.data?.stderr;
      if (bytes && !response.writableEnded) response.write(Buffer.from(bytes));
      const commandId = event?.start?.command_id;
      if (commandId && !session.input) {
        session.input = client.StreamInput(metadata, (error) => {
          if (error) this.fail(sessionId, error);
        });
        session.input.write({ start: { command_id: commandId } });
        for (const pending of session.pending.splice(0)) {
          session.input.write({ data: { data: pending } });
        }
      }
      if (event?.end && !response.writableEnded) response.end();
    });
    output.on("error", (error) => this.fail(sessionId, error));
    output.on("end", () => this.finish(sessionId));
    response.once("close", () => this.finish(sessionId));
  }

  input(sessionId: string, userId: string, data: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) return false;
    const bytes = Buffer.from(data);
    if (session.input) session.input.write({ data: { data: bytes } });
    else session.pending.push(bytes);
    return true;
  }

  closeSession(sessionId: string, userId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) return false;
    this.finish(sessionId);
    return true;
  }

  async close(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) this.finish(sessionId);
  }

  private fail(sessionId: string, error: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    logger.warn("Sandbox terminal stream failed", {
      errorName: error instanceof Error ? error.name : undefined,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    if (!session.response.writableEnded) {
      session.response.write(
        `\r\n[terminal error: ${error instanceof Error ? error.message : String(error)}]\r\n`,
      );
      session.response.end();
    }
    this.finish(sessionId);
  }

  private finish(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.input?.write({ close: {} });
    session.input?.end();
    session.output.cancel();
    session.client.close();
    if (!session.response.writableEnded) session.response.end();
  }
}

export function terminalDimensions(value: unknown): { cols: number; rows: number } {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    cols: boundedDimension(record.cols, 80, 20, 500),
    rows: boundedDimension(record.rows, 24, 5, 200),
  };
}

async function createSandboxClient(workspace: WorkspaceClient): Promise<SandboxServiceClient> {
  const definition = protoLoader.loadSync(resolveProtoPath(), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const root = grpc.loadPackageDefinition(definition) as unknown as {
    databricks: { sandbox: { SandboxService: SandboxServiceConstructor } };
  };
  const host = await workspace.apiClient.host;
  const credentials = grpc.credentials.combineChannelCredentials(
    grpc.credentials.createSsl(),
    grpc.credentials.createFromMetadataGenerator((_params, callback) => {
      const headers = new Headers();
      void workspace.config.authenticate(headers).then(
        () => {
          const metadata = new grpc.Metadata();
          headers.forEach((value, name) => metadata.set(name.toLowerCase(), value));
          callback(null, metadata);
        },
        (error) => callback(error instanceof Error ? error : new Error(String(error))),
      );
    }),
  );
  return new root.databricks.sandbox.SandboxService(
    `${host.hostname}:${host.port || "443"}`,
    credentials,
  );
}

function boundedDimension(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function resolveProtoPath(): string {
  const adjacent = fileURLToPath(new URL("./sandbox_service.proto", import.meta.url));
  if (existsSync(adjacent)) return adjacent;
  return fileURLToPath(new URL("../../src/sandbox_service.proto", import.meta.url));
}
