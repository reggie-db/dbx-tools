import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getOrCreateSecret, type SecretStore } from "../src/secrets.ts";

describe("secret creation", () => {
  it("coalesces concurrent first-use generation through the process lock", async () => {
    let value: string | undefined;
    let writes = 0;
    const store: SecretStore = {
      get: async () => value,
      set: async (_name, next) => {
        writes++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        value = next;
      },
      delete: async () => {
        value = undefined;
      },
    };

    const secrets = await Promise.all(
      Array.from({ length: 10 }, () => getOrCreateSecret(store, "shared-test-secret")),
    );

    assert.equal(writes, 1);
    assert.equal(new Set(secrets).size, 1);
  });
});
