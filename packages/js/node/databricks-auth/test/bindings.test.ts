import assert from "node:assert/strict";
import { it } from "node:test";
import {
  AuthOptions,
  ProviderOptions,
  createProviderAuthWithStorage,
  createStorageHandle,
  type StorageAdapter,
} from "@dbx-tools/auth";
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
    async acquireLock(key, timeoutMillis) {
      assert.equal(timeoutMillis, 7000n);
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
  const storage = createStorageHandle(adapter);
  const auth = await createPersistentAuthWithStorage(
    DatabricksAuthOptions.create({
      profile: "ISOLATED",
      host: "https://example.invalid",
      configFile: "/nonexistent/auth-test-config",
      authType: "databricks-cli",
      auth: AuthOptions.create({ lockTimeoutSeconds: 7n }),
    }),
    storage,
  );
  assert.equal((await auth.token(false)).accessToken, "cached");
  await auth.logout();
  assert.deepEqual(calls, ["lock:ISOLATED", "remove:ISOLATED", "release:lease"]);
  const provider = await createProviderAuthWithStorage(
    ProviderOptions.create({
      provider: "example",
      clientId: "client",
      tokenEndpoint: "https://example.invalid/token",
      authorizationEndpoint: "https://example.invalid/authorize",
      auth: AuthOptions.create({ lockTimeoutSeconds: 7n }),
    }),
    storage,
  );
  assert.equal((await provider.token(false)).accessToken, "cached");
  await provider.logout();
  assert.equal(calls.length, 6);
  assert.equal(calls[3]?.slice(5), calls[4]?.slice(7));
  assert.equal(calls[5], "release:lease");
});

it("composes the same generated lifecycle record in both providers", () => {
  const auth = AuthOptions.create({ refreshBufferSeconds: -5n });
  const provider = ProviderOptions.create({
    provider: "example",
    clientId: "client",
    tokenEndpoint: "https://example.invalid/token",
    auth,
  });
  const databricks = DatabricksAuthOptions.create({ auth });
  assert.equal(provider.auth, auth);
  assert.equal(databricks.auth, auth);
  assert.equal(auth.lockTimeoutSeconds, 30n);
  assert.equal(auth.loginTimeoutSeconds, 3600n);
  assert.equal(AuthOptions.create({}).refreshBufferSeconds, 300n);
  assert.equal(DatabricksAuthOptions.create({}).auth, undefined);
});
