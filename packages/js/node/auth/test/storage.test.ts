import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { FileCredentialStore } from "../src/node-storage.ts";

const TOKEN = {
  accessToken: "new-token",
  tokenType: "Bearer",
  scopes: ["all-apis"],
};

describe("file credential storage", () => {
  it("preserves unrelated Databricks CLI cache entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dbx-tools-auth-store-"));
    try {
      await writeFile(
        join(directory, "token-cache.json"),
        JSON.stringify({ version: 1, tokens: { unrelated: { custom: true } } }),
      );
      const store = new FileCredentialStore(directory);
      await store.prepareWrite();
      await store.save("profile", TOKEN);

      const cache = JSON.parse(await readFile(join(directory, "token-cache.json"), "utf8"));
      assert.deepEqual(cache.tokens.unrelated, { custom: true });
      assert.equal(cache.tokens.profile.access_token, "new-token");
      assert.equal((await store.load("profile"))?.accessToken, "new-token");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
