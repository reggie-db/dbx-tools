import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LakeboxEntry } from "@dbx-tools/lakebox/rest";
import type { LakeboxResourceRegistry } from "../src/_resource-registry.ts";
import { resolveLakeboxPluginConfig } from "../src/config.ts";
import { LakeboxRuntime } from "../src/runtime.ts";

interface RuntimeInternals {
  readyBootKey?: string;
  ready: () => Promise<unknown>;
}

describe("LakeboxRuntime readiness", () => {
  it("reports starting until bootstrap and metrics readiness complete", async () => {
    const entry: LakeboxEntry = {
      sandboxId: "generated-lakebox",
      status: "Running",
      lastStartTime: "2026-10-14T12:00:00Z",
    };
    const runtime = new LakeboxRuntime(
      resolveLakeboxPluginConfig({ application: "readiness-test" }),
    );
    runtime.initialize(
      { host: "https://example.cloud.databricks.com", authenticate: async () => undefined },
      undefined,
      undefined,
      { read: async () => entry } as unknown as LakeboxResourceRegistry,
    );
    const internals = runtime as unknown as RuntimeInternals;
    let readinessAttempts = 0;
    internals.ready = async () => {
      readinessAttempts += 1;
      return undefined;
    };

    try {
      const starting = await runtime.summary("user@example.com");
      assert.equal(starting.status, "starting");
      assert.equal(readinessAttempts, 1);

      internals.readyBootKey = `${entry.sandboxId}\0${entry.lastStartTime}`;
      const running = await runtime.summary("user@example.com");
      assert.equal(running.status, "running");
      assert.equal(readinessAttempts, 1);
    } finally {
      await runtime.close();
    }
  });
});
