/** PostgreSQL cancellation key translation and TLS forwarding. */

import { randomBytes } from "node:crypto";
import { createConnection, isIP, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";

import { cancelRequest, sslRequest, type CancelMessage } from "./protocol.ts";

/** Upstream PostgreSQL backend key used to forward a cancellation request. */
export interface CancellationTarget {
  host: string;
  port: number;
  processId: number;
  secretKey: number;
}

/** Sends one PostgreSQL cancellation request to its upstream backend. */
export type CancellationForwarder = (target: CancellationTarget) => Promise<void>;

let nextProcessId = 10_000;

/** Maps synthetic local backend keys onto real upstream cancellation targets. */
export class CancellationRegistry {
  private readonly targets = new Map<string, CancellationTarget>();

  constructor(private readonly forwarder: CancellationForwarder = forwardCancellation) {}

  register(target: CancellationTarget): CancelMessage {
    const processId = nextProcessId++;
    const secretKey = randomBytes(4).readInt32BE(0);
    this.targets.set(key(processId, secretKey), target);
    return { kind: "cancel", processId, secretKey };
  }

  remove(message: CancelMessage): void {
    this.targets.delete(key(message.processId, message.secretKey));
  }

  async forward(message: CancelMessage): Promise<boolean> {
    const target = this.targets.get(key(message.processId, message.secretKey));
    if (!target) return false;
    await this.forwarder(target);
    return true;
  }
}

export async function forwardCancellation(target: CancellationTarget): Promise<void> {
  const socket = createConnection({ host: target.host, port: target.port });
  await event(socket, "connect");
  socket.write(sslRequest());
  const response = await readByte(socket);
  if (response !== "S".charCodeAt(0)) {
    socket.destroy();
    throw new Error("Lakebase upstream refused TLS for cancellation");
  }
  const tls = connectTls({
    socket,
    rejectUnauthorized: true,
    ...(isIP(target.host) === 0 ? { servername: target.host } : {}),
  });
  await event(tls, "secureConnect");
  await writeAndClose(tls, cancelRequest(target.processId, target.secretKey));
}

function key(processId: number, secretKey: number): string {
  return `${processId}:${secretKey}`;
}

function event(socket: Socket | TLSSocket, name: "connect" | "secureConnect"): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = () => finish();
    const onError = (error: Error) => finish(error);
    const finish = (error?: Error) => {
      socket.off(name, onEvent);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    socket.once(name, onEvent);
    socket.once("error", onError);
  });
}

function readByte(socket: Socket): Promise<number> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      finish();
      if (chunk.length > 1) socket.unshift(chunk.subarray(1));
      resolve(chunk[0]!);
    };
    const onError = (error: Error) => {
      finish();
      reject(error);
    };
    const onEnd = () => {
      finish();
      reject(new Error("Lakebase upstream closed during TLS negotiation"));
    };
    const finish = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    socket.once("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

function writeAndClose(socket: TLSSocket, packet: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.end(packet, () => resolve());
    socket.once("error", reject);
  });
}
