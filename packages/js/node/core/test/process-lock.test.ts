import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";

import { exec } from "../index.ts";
import { processLockWorkerOptions, withProcessLock } from "../src/process-lock.ts";

const PKG_ROOT = new URL("..", import.meta.url).pathname;

/**
 * `node` on PATH, or `undefined` when it is missing.
 *
 * NOT `process.execPath`: this suite runs under `bun`, so that would re-launch
 * Bun and silently ignore the Node-only flags below.
 */
const NODE = exec.spawnSync("node", ["--version"], { stdout: "capture" });
const nodePath = NODE.exitCode === 0 ? "node" : undefined;

/**
 * Run a standalone script so PROCESS EXIT is observable - the in-process tests
 * cannot see whether an idle lock port pins the event loop.
 *
 * Executed with `node --experimental-transform-types`, not `bun`, for two
 * reasons: the scripts import this package's TypeScript sources directly, and
 * Node's default strip-only mode rejects the parameter properties used across
 * `@dbx-tools/shared-core`; and Bun does not currently fire `close` on a
 * `MessagePort` whose peer thread was terminated, which is exactly the signal the
 * dead-holder recovery test asserts on.
 */
async function runScript(
  files: Record<string, string>,
  entry = "main.mjs",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const dir = await mkdtemp(join(tmpdir(), "process-lock-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      await writeFile(join(dir, name), source.replaceAll("__PKG__", PKG_ROOT));
    }
    const result = await exec.spawn(
      nodePath!,
      ["--experimental-transform-types", "--no-warnings", join(dir, entry)],
      {
        stdout: "capture",
        stderr: "capture",
        timeout: 30_000,
      },
    );
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("withProcessLock", () => {
  it("serializes callbacks sharing a key", async () => {
    const events: string[] = [];
    let concurrent = 0;
    const task = (name: string) =>
      withProcessLock("shared", async () => {
        concurrent += 1;
        assert.equal(concurrent, 1, "two callbacks held the same key at once");
        events.push(`${name}:enter`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`${name}:exit`);
        concurrent -= 1;
      });

    await Promise.all([task("a"), task("b"), task("c")]);
    assert.deepEqual(events, ["a:enter", "a:exit", "b:enter", "b:exit", "c:enter", "c:exit"]);
  });

  it("runs distinct keys concurrently", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const held = withProcessLock("key-a", () => blocked);
    // Would deadlock if a different key waited on the first.
    await withProcessLock("key-b", () => undefined);
    release();
    await held;
  });

  it("releases the key when the callback throws", async () => {
    await assert.rejects(
      withProcessLock("throwing", () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(await withProcessLock("throwing", () => "recovered"), "recovered");
  });

  it("returns the callback result and treats structure as identity", async () => {
    assert.equal(await withProcessLock(["invoice", 7], () => 42), 42);
    // `["invoice", 7]` and "invoice_7" must not collide.
    let inner: string | undefined;
    await withProcessLock(["invoice", 7], async () => {
      inner = await withProcessLock("invoice_7", () => "distinct");
    });
    assert.equal(inner, "distinct");
  });

  it("serializes across worker threads", async () => {
    const worker = new Worker(
      new URL("./fixtures/lock-worker.ts", import.meta.url),
      processLockWorkerOptions({ workerData: { passthrough: "kept" } }),
    );
    try {
      const seen = await new Promise<string[]>((resolve, reject) => {
        const messages: string[] = [];
        worker.on("message", (message: string) => {
          messages.push(message);
          if (messages.length === 2) resolve(messages);
        });
        worker.on("error", reject);
      });
      assert.deepEqual(seen, ["workerData:kept", "worker:done"]);
    } finally {
      await worker.terminate();
    }
  });

  // The remaining cases need a real Node process (see `nodePath`).
  const nodeIt = nodePath ? it : it.skip;

  nodeIt("does not keep the process alive after a lock is released", async () => {
    const { exitCode, stdout } = await runScript({
      "main.mjs": `
        import { withProcessLock } from "__PKG__/src/process-lock.ts";
        await withProcessLock("exit-check", () => "done");
        console.log("released");
      `,
    });
    assert.equal(stdout.trim(), "released");
    assert.equal(exitCode, 0, "an idle lock port must not pin the event loop");
  });

  nodeIt("stays alive while a grant is in flight", async () => {
    // Regression: with the ports merely unref'd, nothing else pending means Node
    // exits before the grant is delivered and the callback never runs.
    const { exitCode, stdout } = await runScript({
      "main.mjs": `
        import { withProcessLock } from "__PKG__/src/process-lock.ts";
        const value = await withProcessLock("in-flight", () => "ran");
        console.log("callback:" + value);
      `,
    });
    assert.equal(stdout.trim(), "callback:ran");
    assert.equal(exitCode, 0);
  });

  nodeIt("hands the key to the next waiter when a holder thread dies", async () => {
    const { exitCode, stdout, stderr } = await runScript({
      "worker.mjs": `
        import { withProcessLock } from "__PKG__/src/process-lock.ts";
        import { parentPort } from "node:worker_threads";
        // Take the lock, tell the main thread, then never release it.
        withProcessLock("dies", () => new Promise(() => {}));
        setTimeout(() => parentPort.postMessage("holding"), 20);
      `,
      "main.mjs": `
        import { Worker } from "node:worker_threads";
        import {
          processLockWorkerOptions,
          withProcessLock,
        } from "__PKG__/src/process-lock.ts";
        const worker = new Worker(new URL("./worker.mjs", import.meta.url),
          processLockWorkerOptions());
        await new Promise((resolve) => worker.on("message", resolve));
        const waiter = withProcessLock("dies", () => "granted-after-death");
        await worker.terminate();
        console.log(await waiter);
      `,
    });
    assert.equal(stderr.includes("Error"), false, stderr);
    assert.equal(stdout.trim(), "granted-after-death");
    assert.equal(exitCode, 0);
  });

  nodeIt("rejects a worker that was not started with a lock port", async () => {
    const { stdout } = await runScript({
      "worker.mjs": `
        import { withProcessLock } from "__PKG__/src/process-lock.ts";
        import { parentPort } from "node:worker_threads";
        try {
          await withProcessLock("nope", () => "x");
          parentPort.postMessage("unexpected-success");
        } catch (error) {
          parentPort.postMessage("error:" + error.message);
        }
      `,
      "main.mjs": `
        import { Worker } from "node:worker_threads";
        const worker = new Worker(new URL("./worker.mjs", import.meta.url));
        console.log(await new Promise((r) => worker.on("message", r)));
        await worker.terminate();
      `,
    });
    assert.match(stdout, /no process-lock port/);
  });

  nodeIt("supports attaching to an already-running worker", async () => {
    const { stdout, exitCode } = await runScript({
      "worker.mjs": `
        import { parentPort } from "node:worker_threads";
        import {
          processLockAttached,
          withProcessLock,
        } from "__PKG__/src/process-lock.ts";
        await processLockAttached();
        parentPort.postMessage(await withProcessLock("attached", () => "locked"));
      `,
      "main.mjs": `
        import { Worker } from "node:worker_threads";
        import { attachProcessLock } from "__PKG__/src/process-lock.ts";
        const worker = new Worker(new URL("./worker.mjs", import.meta.url));
        attachProcessLock(worker);
        console.log(await new Promise((r) => worker.on("message", r)));
        await worker.terminate();
      `,
    });
    assert.equal(stdout.trim(), "locked");
    assert.equal(exitCode, 0);
  });

  nodeIt("refuses to hand out ports off the main thread", async () => {
    const { stdout } = await runScript({
      "worker.mjs": `
        import { parentPort } from "node:worker_threads";
        import { processLockWorkerOptions } from "__PKG__/src/process-lock.ts";
        try {
          processLockWorkerOptions();
          parentPort.postMessage("unexpected-success");
        } catch (error) {
          parentPort.postMessage("error:" + error.message);
        }
      `,
      "main.mjs": `
        import { Worker } from "node:worker_threads";
        const worker = new Worker(new URL("./worker.mjs", import.meta.url));
        console.log(await new Promise((r) => worker.on("message", r)));
        await worker.terminate();
      `,
    });
    assert.match(stdout, /must be called from the main thread/);
  });
});
