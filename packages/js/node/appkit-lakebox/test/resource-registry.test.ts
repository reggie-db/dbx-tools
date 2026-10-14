import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LakeboxApiError, type LakeboxEntry } from "@dbx-tools/lakebox/rest";
import { LakeboxResourceRegistry, type LakeboxResourceClient } from "../src/_resource-registry.ts";

class TestCache {
  readonly values = new Map<string, unknown>();

  generateKey(parts: (string | number | object)[], userKey: string): string {
    return JSON.stringify([parts, userKey]);
  }

  async get<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class TestClient implements LakeboxResourceClient {
  readonly entries = new Map<string, LakeboxEntry>();
  createCalls = 0;
  listCalls = 0;

  async workspaceScope(): Promise<string> {
    return "workspace-1";
  }

  async list(): Promise<LakeboxEntry[]> {
    this.listCalls += 1;
    return [...this.entries.values()];
  }

  async get(id: string): Promise<LakeboxEntry> {
    const entry = this.entries.get(id);
    if (!entry) throw new LakeboxApiError("missing", 404);
    return entry;
  }

  async create(): Promise<LakeboxEntry> {
    this.createCalls += 1;
    const entry = {
      sandboxId: `generated-${this.createCalls}`,
      status: "Stopped",
      name: `databricks-generated-${this.createCalls}`,
    };
    this.entries.set(entry.sandboxId, entry);
    return entry;
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }
}

describe("LakeboxResourceRegistry", () => {
  it("creates without an app-assigned name and reuses the persisted ID", async () => {
    const cache = new TestCache();
    const client = new TestClient();
    const first = new LakeboxResourceRegistry("demo", undefined, () => cache);

    const created = await first.getOrCreate(client);
    const second = new LakeboxResourceRegistry("demo", undefined, () => cache);
    const resolved = await second.read(client);

    assert.equal(created.sandboxId, "generated-1");
    assert.equal(resolved?.sandboxId, created.sandboxId);
    assert.equal(client.createCalls, 1);
  });

  it("adopts the oldest deterministic legacy machine once", async () => {
    const cache = new TestCache();
    const client = new TestClient();
    client.entries.set("newer", {
      sandboxId: "newer",
      status: "Stopped",
      name: "dbx-lakebox-demo-app",
      createTime: "2026-02-02T00:00:00.000Z",
    });
    client.entries.set("older", {
      sandboxId: "older",
      status: "Stopped",
      name: "dbx-lakebox-demo-app",
      createTime: "2026-01-01T00:00:00.000Z",
    });
    const registry = new LakeboxResourceRegistry("Demo App", undefined, () => cache);

    assert.equal((await registry.read(client))?.sandboxId, "older");
    assert.equal((await registry.read(client))?.sandboxId, "older");
    assert.equal(client.listCalls, 1);
  });

  it("clears a deleted resource without falling back to a legacy machine", async () => {
    const cache = new TestCache();
    const client = new TestClient();
    const registry = new LakeboxResourceRegistry("demo", undefined, () => cache);
    const created = await registry.getOrCreate(client);
    client.entries.delete(created.sandboxId);
    client.entries.set("legacy", {
      sandboxId: "legacy",
      status: "Stopped",
      name: "dbx-lakebox-demo",
    });

    assert.equal(await registry.read(client), undefined);
    assert.equal(client.listCalls, 1);
  });
});
