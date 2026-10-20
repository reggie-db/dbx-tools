import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LakeboxEntry } from "@dbx-tools/lakebox";
import type { LakeboxResourceRegistry } from "../src/_resource-registry.ts";
import { resolveLakeboxPluginConfig } from "../src/config.ts";
import { LakeboxRuntime } from "../src/runtime.ts";

interface RuntimeInternals {
  readyBootKey?: string;
  ready: () => Promise<unknown>;
  connect: (entry: LakeboxEntry, signal: AbortSignal) => Promise<unknown>;
  connectOnce: (entry: LakeboxEntry, signal: AbortSignal) => Promise<unknown>;
  waitForSshRetry: (delayMs: number, signal: AbortSignal) => Promise<void>;
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

  it("retries transient SSH startup failures without wall-clock timing", async () => {
    const entry: LakeboxEntry = {
      sandboxId: "generated-lakebox",
      status: "Running",
      lastStartTime: "2026-10-14T12:00:00Z",
    };
    const runtime = new LakeboxRuntime(
      resolveLakeboxPluginConfig({ application: "readiness-test" }),
    );
    const internals = runtime as unknown as RuntimeInternals;
    const expected = {};
    const delays: number[] = [];
    let attempts = 0;
    internals.connectOnce = async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new AggregateError([
          Object.assign(new Error("gateway unavailable"), { code: "ECONNREFUSED" }),
        ]);
      }
      return expected;
    };
    internals.waitForSshRetry = async (delayMs) => {
      delays.push(delayMs);
    };

    try {
      assert.equal(await internals.connect(entry, new AbortController().signal), expected);
      assert.equal(attempts, 3);
      assert.deepEqual(delays, [1_000, 2_000]);
    } finally {
      await runtime.close();
    }
  });
});
