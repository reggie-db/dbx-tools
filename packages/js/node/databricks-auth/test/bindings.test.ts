import assert from "node:assert/strict";
import { it } from "node:test";
import { createStorageHandle, type StorageAdapter } from "@dbx-tools/auth";
import { createPersistentAuthWithStorage, DatabricksAuthOptions } from "../index.ts";

it("uses the shared auth adapter across native libraries", async () => {
  const calls: string[] = [];
  const adapter: StorageAdapter = {
    async load() {
      return JSON.stringify({
        access_token: "cached",
        token_type: "Bearer",
        expiry: "2099-01-01T00:00:00Z",
      });
    },
    async prepareWrite() {},
    async save() {},
    async remove(key) {
      calls.push(`remove:${key}`);
    },
    async acquireLock(key) {
      calls.push(`lock:${key}`);
      return "lease";
    },
    async releaseLock(lease) {
      calls.push(`release:${lease}`);
    },
    name() {
      return "test";
    },
  };
  const auth = await createPersistentAuthWithStorage(
    DatabricksAuthOptions.create({
      profile: "ISOLATED",
      host: "https://example.invalid",
      configFile: "/nonexistent/auth-test-config",
      authType: "databricks-cli",
    }),
    createStorageHandle(adapter),
  );
  assert.equal((await auth.token(false)).accessToken, "cached");
  await auth.logout();
  assert.deepEqual(calls, ["lock:ISOLATED", "remove:ISOLATED", "release:lease"]);
});
