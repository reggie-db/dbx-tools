/** Minimal PostgreSQL startup protocol helpers for the loopback proxy. */

import type { Socket } from "node:net";

export const SSL_REQUEST = 80_877_103;
export const CANCEL_REQUEST = 80_877_102;
export const PROTOCOL_3 = 196_608;

export interface StartupMessage {
  kind: "startup";
  protocol: number;
  parameters: Record<string, string>;
}

export interface CancelMessage {
  kind: "cancel";
  processId: number;
  secretKey: number;
}

export type InitialMessage = StartupMessage | CancelMessage;

export class PostgresProtocolError extends Error {}

export async function readInitialMessage(
  socket: Socket,
  timeoutMs: number,
): Promise<InitialMessage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const packet = await readPacket(socket, deadline);
    const code = packet.readInt32BE(4);
    if (code === SSL_REQUEST) {
      socket.write("N");
      continue;
    }
    if (code === CANCEL_REQUEST) {
      if (packet.length !== 16) throw new PostgresProtocolError("Invalid CancelRequest packet");
      return {
        kind: "cancel",
        processId: packet.readInt32BE(8),
        secretKey: packet.readInt32BE(12),
      };
    }
    if (code !== PROTOCOL_3) {
      throw new PostgresProtocolError(`Unsupported PostgreSQL protocol version ${code}`);
    }
    return { kind: "startup", protocol: code, parameters: parseParameters(packet.subarray(8)) };
  }
}

export function sslRequest(): Buffer {
  return requestPacket(SSL_REQUEST);
}

export function cancelRequest(processId: number, secretKey: number): Buffer {
  return requestPacket(CANCEL_REQUEST, processId, secretKey);
}

export function startupComplete(
  parameters: ReadonlyMap<string, string>,
  processId: number,
  secretKey: number,
  transactionStatus = "I",
): Buffer {
  return Buffer.concat([
    backendMessage("R", int32(0)),
    ...[...parameters].map(([name, value]) =>
      backendMessage("S", Buffer.from(`${name}\0${value}\0`)),
    ),
    backendMessage("K", Buffer.concat([int32(processId), int32(secretKey)])),
    backendMessage("Z", Buffer.from(transactionStatus.slice(0, 1) || "I")),
  ]);
}

export function upstreamStartupParameters(
  parameters: Record<string, string>,
  user: string,
  database: string,
): Record<string, string> {
  return { ...parameters, user, database };
}

export function fatalError(message: string, sqlstate = "08001"): Buffer {
  return backendMessage(
    "E",
    Buffer.concat([Buffer.from(`SFATAL\0C${sqlstate}\0M${message}\0`), Buffer.from([0])]),
  );
}

function requestPacket(code: number, processId?: number, secretKey?: number): Buffer {
  const values = [code];
  if (processId !== undefined && secretKey !== undefined) values.push(processId, secretKey);
  return Buffer.concat([int32(4 + values.length * 4), ...values.map(int32)]);
}

function backendMessage(code: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(code), int32(body.length + 4), body]);
}

function int32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeInt32BE(value);
  return buffer;
}

async function readPacket(socket: Socket, deadline: number): Promise<Buffer> {
  let buffer = Buffer.alloc(0);
  while (buffer.length < 4) buffer = Buffer.concat([buffer, await readChunk(socket, deadline)]);
  const length = buffer.readInt32BE(0);
  if (length < 8 || length > 1024 * 1024) {
    throw new PostgresProtocolError("Invalid PostgreSQL startup packet");
  }
  while (buffer.length < length)
    buffer = Buffer.concat([buffer, await readChunk(socket, deadline)]);
  const remainder = buffer.subarray(length);
  if (remainder.length) socket.unshift(remainder);
  return buffer.subarray(0, length);
}

function readChunk(socket: Socket, deadline: number): Promise<Buffer> {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    return Promise.reject(new PostgresProtocolError("PostgreSQL startup timed out"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new PostgresProtocolError("PostgreSQL startup timed out")),
      remaining,
    );
    const onData = (chunk: Buffer) => finish(undefined, chunk);
    const onError = (error: Error) => finish(error);
    const onEnd = () =>
      finish(new PostgresProtocolError("PostgreSQL client closed during startup"));
    const finish = (error?: Error, chunk?: Buffer) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      if (error) reject(error);
      else resolve(chunk!);
    };
    socket.once("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

function parseParameters(body: Buffer): Record<string, string> {
  const values = body.toString("utf8").split("\0");
  const parameters: Record<string, string> = {};
  for (let index = 0; index + 1 < values.length && values[index]; index += 2) {
    parameters[values[index]!] = values[index + 1] ?? "";
  }
  return parameters;
}
