import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { atomicWriteTextFile, readTextFile } from "../src/files.ts";
import { executeHttp } from "../src/http.ts";
import { withFileLock } from "../src/locks.ts";
import { runProcess } from "../src/process.ts";

describe("JavaScript host bindings", () => {
  it("runs a process through core execution", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
    });
    assert.deepEqual(result, { exitCode: 0, stdout: "ok" });
  });

  it("reports a missing process without hanging", async () => {
    const result = await runProcess({ command: `dbx-tools-missing-${process.pid}` });
    assert.deepEqual(result, { exitCode: 127 });
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

  it("atomically reads and writes text through file bindings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dbx-tools-bindings-files-"));
    const path = join(directory, "nested", "state.json");
    try {
      await atomicWriteTextFile({ path, content: "ready\n" });
      assert.equal(await readTextFile({ path }), "ready\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs a callback while holding a path lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dbx-tools-bindings-lock-"));
    const path = join(directory, "state.json");
    try {
      let entered = false;
      await withFileLock(
        path,
        () => {
          entered = true;
        },
        { lockDirectory: join(directory, "locks"), timeoutMs: 100 },
      );
      assert.equal(entered, true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
