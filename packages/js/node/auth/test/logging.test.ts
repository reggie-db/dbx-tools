import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

describe("authentication debug logging", () => {
  it("reports lifecycle decisions without serializing credentials", () => {
    const lifecycle = moduleUrl("src/lifecycle.ts");
    const storage = moduleUrl("src/storage.ts");
    const types = moduleUrl("src/types.ts");
    const script = `
      import { TokenLifecycle } from ${JSON.stringify(lifecycle)};
      import { MemoryCredentialStore } from ${JSON.stringify(storage)};
      import { AuthOptions } from ${JSON.stringify(types)};
      const provider = {
        authenticate: async () => ({
          accessToken: "SECRET_ACCESS_VALUE",
          refreshToken: "SECRET_REFRESH_VALUE",
          tokenType: "Bearer",
          expiry: new Date(Date.now() + 60_000).toISOString(),
          scopes: ["all-apis"],
        }),
        login: async () => { throw new Error("unexpected login"); },
        refresh: async () => { throw new Error("unexpected refresh"); },
        canAuthenticateSilently: () => true,
      };
      const client = new TokenLifecycle(
        "logging-profile",
        provider,
        new MemoryCredentialStore(),
        AuthOptions.create({ refreshBufferMs: 0 }),
      );
      await client.token();
    `;
    const result = Bun.spawnSync(["bun", "--eval", script], {
      env: { ...process.env, LOG_LEVEL: "debug" },
      stderr: "pipe",
      stdout: "pipe",
    });
    const output = result.stderr.toString();
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /DEBUG \[auth:lifecycle\] checked credential cache/);
    assert.match(output, /DEBUG \[auth:lifecycle\] credential saved/);
    assert.match(output, /DEBUG \[auth:memory-storage\] saved memory credential/);
    assert.doesNotMatch(output, /SECRET_ACCESS_VALUE|SECRET_REFRESH_VALUE/);
  });
});

function moduleUrl(path: string): string {
  return pathToFileURL(resolve(import.meta.dirname, "..", path)).href;
}
