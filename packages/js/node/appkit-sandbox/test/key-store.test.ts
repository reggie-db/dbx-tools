import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SshKeyStore } from "../src/key-store.ts";
import type { DatabricksSandboxClient } from "../src/rest.ts";

describe("SshKeyStore", () => {
  it("publishes one complete key pair across concurrent callers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dbx-tools-key-store-"));
    const registrations: string[] = [];
    const api = {
      workspaceScope: () => "workspace",
      listKeys: async () => [],
      registerKey: async (publicKey: string) => {
        registrations.push(publicKey);
        return { keyHash: "registered" };
      },
    } as unknown as DatabricksSandboxClient;
    const store = new SshKeyStore(directory);
    try {
      const [first, second] = await Promise.all([
        store.ensureRegistered(api, "user@example.com"),
        store.ensureRegistered(api, "user@example.com"),
      ]);

      assert.equal(first.privateKey, second.privateKey);
      assert.equal(first.publicKey, second.publicKey);
      assert.equal(first.keyHash, second.keyHash);
      assert.deepEqual(registrations, [first.publicKey, first.publicKey]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
