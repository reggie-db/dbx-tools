import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";

import { startPathProxy } from "../src/path-proxy.ts";

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing port"));
      resolve(address.port);
    });
  });
}

describe("FRP path proxy", () => {
  it("strips the registered prefix and preserves query strings", async () => {
    const upstream = createServer((request, response) => response.end(request.url));
    const appPort = await listen(upstream);
    const proxy = await startPathProxy(appPort, "/demo1");
    try {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/demo1/api/videos?q=one`);
      assert.equal(await response.text(), "/api/videos?q=one");
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
