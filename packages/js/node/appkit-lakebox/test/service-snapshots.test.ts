import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LakeboxServiceSnapshots, stoppedSnapshotServices } from "../src/_service-snapshots.ts";
import { builtInDefinition } from "../src/services.ts";
import { lakeboxUser } from "../src/user.ts";

function memoryCache() {
  const values = new Map<string, unknown>();
  let ttl: number | undefined;
  return {
    cache: {
      generateKey: (parts: (string | number | object)[], userKey: string) =>
        `${userKey}:${JSON.stringify(parts)}`,
      get: async <T>(key: string) => (values.get(key) as T | undefined) ?? null,
      set: async <T>(key: string, value: T, options?: { ttl?: number }) => {
        values.set(key, value);
        ttl = options?.ttl;
      },
    },
    values,
    ttl: () => ttl,
  };
}

describe("Lakebox service snapshots", () => {
  it("persists last-known definitions by Lakebox and user", async () => {
    const memory = memoryCache();
    const snapshots = new LakeboxServiceSnapshots(() => memory.cache);
    const user = lakeboxUser("person@example.com", "/lakebox");
    const snapshot = {
      observedAt: "2026-10-14T16:00:00.000Z",
      definitions: [builtInDefinition("terminal", user)],
    };

    await snapshots.write("lakebox-1", user.hash, snapshot);

    assert.deepEqual(await snapshots.read("lakebox-1", user.hash), snapshot);
    assert.deepEqual(
      [...stoppedSnapshotServices(snapshot).values()].map((service) => service.state),
      ["stopped"],
    );
    assert.equal(await snapshots.read("lakebox-2", user.hash), undefined);
    assert.ok((memory.ttl() ?? 0) >= 365 * 24 * 60 * 60);
  });

  it("ignores malformed cached snapshots", async () => {
    const memory = memoryCache();
    const snapshots = new LakeboxServiceSnapshots(() => memory.cache);
    const user = lakeboxUser("person@example.com", "/lakebox");
    const key = memory.cache.generateKey(
      ["appkit-lakebox:service-snapshot", "lakebox-1"],
      user.hash,
    );
    memory.values.set(key, { observedAt: "not-a-date", definitions: [] });

    assert.equal(await snapshots.read("lakebox-1", user.hash), undefined);
  });
});
