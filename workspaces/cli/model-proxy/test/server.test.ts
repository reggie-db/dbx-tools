import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";

import type { DatabricksBackend } from "../src/backend";
import { createProxyServer } from "../src/server";

/** Listen on an ephemeral port and resolve the bound port. */
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  return address.port;
}

describe("createProxyServer timeouts", () => {
  it("disables every inbound timeout that could cut a stream short", () => {
    const server = createProxyServer({} as DatabricksBackend);
    // Node's defaults (300s request, 60s headers) are sized for ordinary web
    // traffic and would kill a long model turn mid-stream.
    assert.equal(server.requestTimeout, 0);
    assert.equal(server.headersTimeout, 0);
    assert.equal(server.timeout, 0);
    server.close();
  });

  it("differs from a stock node server, so the override is doing the work", () => {
    const stock = createServer();
    assert.notEqual(stock.requestTimeout, 0);
    assert.notEqual(stock.headersTimeout, 0);
    stock.close();
  });
});

describe("upstream dispatcher", () => {
  /**
   * Serve one chunk, stall past the supplied body timeout, then finish. Proves
   * `bodyTimeout` measures the gap BETWEEN chunks - the failure mode that made
   * long-thinking turns look like dropped streams.
   */
  async function readThroughStall(bodyTimeout: number): Promise<string> {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => {
        res.write("data: second\n\n");
        res.end();
      }, 1_000);
    });
    const port = await listen(upstream);
    try {
      const { Agent } = await import("undici");
      const init: RequestInit = { method: "GET" };
      Reflect.set(init, "dispatcher", new Agent({ bodyTimeout, headersTimeout: 0 }));
      const response = await fetch(`http://127.0.0.1:${port}/`, init);
      let body = "";
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        body += Buffer.from(chunk).toString();
      }
      return body;
    } finally {
      upstream.close();
    }
  }

  it("aborts a stalled stream when bodyTimeout is set", async () => {
    await assert.rejects(() => readThroughStall(100));
  });

  it("survives the same stall with bodyTimeout disabled, as the proxy configures it", async () => {
    assert.equal(await readThroughStall(0), "data: first\n\ndata: second\n\n");
  });
});
