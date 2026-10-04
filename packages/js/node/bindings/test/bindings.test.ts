import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";

import { executeHttp } from "../src/http.ts";
import { runProcess } from "../src/process.ts";

describe("JavaScript host bindings", () => {
  it("runs a process through core execution", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
    });
    assert.deepEqual(result, { exitCode: 0, stdout: "ok" });
  });

  it("executes HTTP through fetch", async () => {
    const server = createServer((request, response) => {
      response.writeHead(201, { "content-type": "text/plain", "x-method": request.method });
      response.end("created");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    try {
      const result = await executeHttp({
        url: `http://127.0.0.1:${address.port}/resource`,
        method: "POST",
      });
      assert.equal(result.status, 201);
      assert.equal(result.headers["x-method"], "POST");
      assert.equal(result.body, "created");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
