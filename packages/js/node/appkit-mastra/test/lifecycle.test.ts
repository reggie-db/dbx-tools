import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { Workspace, type WorkspaceSandbox } from "@mastra/core/workspace";

import { MastraPlugin } from "../src/plugin.ts";

describe("Mastra plugin lifecycle", () => {
  it("keeps resources live during cancellation and awaits native teardown", async () => {
    const events: string[] = [];
    let releaseStorage!: () => void;
    let storageClosing!: () => void;
    const storageGate = new Promise<void>((resolve) => {
      releaseStorage = resolve;
    });
    const storageStarted = new Promise<void>((resolve) => {
      storageClosing = resolve;
    });
    const storage = new InMemoryStore();
    storage.close = async () => {
      events.push("storage:closing");
      storageClosing();
      await storageGate;
      events.push("storage:closed");
    };
    const sandbox: WorkspaceSandbox = {
      id: "lifecycle-sandbox",
      name: "Lifecycle Sandbox",
      provider: "test",
      status: "running",
      async snapshot() {},
      async stop() {
        events.push("sandbox:stopped");
      },
    };
    const workspace = new Workspace({ id: "lifecycle-workspace", sandbox });
    const mastra = new Mastra({ storage, logger: false });
    mastra.addWorkspace(workspace);
    const plugin = new MastraPlugin({});
    Object.assign(plugin, { mastra });
    plugin.abortActiveOperations();
    await Promise.resolve();
    assert.deepEqual(events, []);

    let completed = false;
    const shutdown = plugin.shutdown().then(() => {
      completed = true;
    });
    try {
      await storageStarted;
      assert.deepEqual(events, ["sandbox:stopped", "storage:closing"]);
      assert.equal(completed, false);
    } finally {
      releaseStorage();
      await shutdown;
    }

    assert.deepEqual(events, ["sandbox:stopped", "storage:closing", "storage:closed"]);
    assert.equal(completed, true);
  });

  it("preserves native teardown failures", async () => {
    const storage = new InMemoryStore();
    const failure = new Error("storage close failed");
    storage.close = async () => {
      throw failure;
    };
    const mastra = new Mastra({ storage, logger: false });
    const plugin = new MastraPlugin({});
    Object.assign(plugin, { mastra });
    await assert.rejects(plugin.shutdown(), (error) => error === failure);
  });

  it("handles shutdown before Mastra initialization", async () => {
    const plugin = new MastraPlugin({});
    await plugin.shutdown();
  });
});
