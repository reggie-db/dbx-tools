import { expect, test } from "bun:test";
import { createConnection, createServer } from "node:net";
import {
  CANCEL_REQUEST,
  PROTOCOL_3,
  readInitialMessage,
  SSL_REQUEST,
  startupComplete,
  upstreamStartupParameters,
} from "../src/lakebase-proxy/protocol.ts";

test("serializes a passwordless local startup completion", () => {
  const packet = startupComplete(new Map([["server_version", "17"]]), 42, 7);
  expect(packet[0]).toBe("R".charCodeAt(0));
  expect(packet.includes(Buffer.from("server_version\0"))).toBeTrue();
  expect(packet.at(-1)).toBe("I".charCodeAt(0));
});

test("parses a PostgreSQL CancelRequest", async () => {
  const message = await exchange(packet(CANCEL_REQUEST, 42, 7));
  expect(message).toEqual({ kind: "cancel", processId: 42, secretKey: 7 });
});

test("declines local TLS then parses startup parameters", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  const accepted = new Promise<Awaited<ReturnType<typeof readInitialMessage>>>(
    (resolve, reject) => {
      server.once(
        "connection",
        (socket) => void readInitialMessage(socket, 1_000).then(resolve, reject),
      );
    },
  );
  const client = createConnection(address.port, "127.0.0.1");
  await new Promise<void>((resolve) => client.once("connect", resolve));
  client.write(packet(SSL_REQUEST));
  expect(await onceData(client)).toEqual(Buffer.from("N"));
  client.write(startupPacket({ user: "PROFILE", database: "project", options: "-c x=y" }));
  expect(await accepted).toEqual({
    kind: "startup",
    protocol: PROTOCOL_3,
    parameters: { user: "PROFILE", database: "project", options: "-c x=y" },
  });
  client.destroy();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("rewrites only resolved identity startup fields", () => {
  expect(
    upstreamStartupParameters(
      { user: "PROFILE", database: "project", application_name: "test", options: "-c x=y" },
      "user@example.com",
      "databricks_postgres",
    ),
  ).toEqual({
    user: "user@example.com",
    database: "databricks_postgres",
    application_name: "test",
    options: "-c x=y",
  });
});

async function exchange(buffer: Buffer) {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  const accepted = new Promise<Awaited<ReturnType<typeof readInitialMessage>>>(
    (resolve, reject) => {
      server.once(
        "connection",
        (socket) => void readInitialMessage(socket, 1_000).then(resolve, reject),
      );
    },
  );
  const client = createConnection(address.port, "127.0.0.1");
  await new Promise<void>((resolve) => client.once("connect", resolve));
  client.end(buffer);
  const message = await accepted;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return message;
}

function packet(code: number, processId?: number, secretKey?: number): Buffer {
  const values = [code, ...(processId === undefined ? [] : [processId, secretKey!])];
  const buffer = Buffer.alloc(4 + values.length * 4);
  buffer.writeInt32BE(buffer.length, 0);
  values.forEach((value, index) => buffer.writeInt32BE(value, 4 + index * 4));
  return buffer;
}

function startupPacket(parameters: Record<string, string>): Buffer {
  const body = Buffer.from(
    `${Object.entries(parameters)
      .flatMap(([name, value]) => [name, value])
      .join("\0")}\0\0`,
  );
  const buffer = Buffer.alloc(8 + body.length);
  buffer.writeInt32BE(buffer.length, 0);
  buffer.writeInt32BE(PROTOCOL_3, 4);
  body.copy(buffer, 8);
  return buffer;
}

function onceData(socket: ReturnType<typeof createConnection>): Promise<Buffer> {
  return new Promise((resolve) => socket.once("data", resolve));
}
