import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveServicePackage } from "../src/_package.ts";

describe("CLI service package resolution", () => {
  it("resolves an installed package manifest and named bin", () => {
    const resolved = resolveServicePackage("bun");

    assert.match(resolved.version, /^\d+\.\d+\.\d+/);
    assert.match(resolved.bin("bun"), /bun[\\/]bin[\\/]bun\.exe$/);
  });

  it("reads dependency versions when package.json is not exported", () => {
    const resolved = resolveServicePackage(
      fileURLToPath(new URL("../package.json", import.meta.url)),
    );

    assert.match(resolved.dependencies().commander!, /^\d+\.\d+\.\d+/);
  });

  it("falls back to an explicit monorepo workspace package", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbx-tools-service-package-"));
    const member = join(root, "packages", "gateway");
    await mkdir(member, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@example/root",
        version: "1.0.0",
        workspaces: ["packages/gateway"],
      }),
    );
    await writeFile(
      join(member, "package.json"),
      JSON.stringify({
        name: "@example/gateway",
        version: "2.3.4",
        bin: { gateway: "./bin/gateway.js" },
      }),
    );

    const resolved = resolveServicePackage("@example/gateway", root);

    assert.equal(resolved.version, "2.3.4");
    assert.equal(resolved.bin(), join(member, "bin", "gateway.js"));
  });
});
