import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { basename, delimiter, dirname } from "node:path";
import { describe, it } from "node:test";

import { bunUsesRegistry, childEnv } from "../src/bun.ts";

describe("childEnv", () => {
  it("makes the current runtime executable available to lifecycle scripts", () => {
    const env = childEnv({ PATH: "/custom/bin" });

    assert.deepEqual(env.PATH?.split(delimiter), [dirname(process.execPath), "/custom/bin"]);
  });

  it("does not duplicate the runtime executable directory", () => {
    const runtimeBin = dirname(process.execPath);
    const env = childEnv({ PATH: [runtimeBin, "/custom/bin"].join(delimiter) });

    assert.deepEqual(env.PATH?.split(delimiter), [runtimeBin, "/custom/bin"]);
  });

  it("lets a lifecycle shell invoke the runtime when the inherited PATH cannot", () => {
    // `childEnv` prepends the running executable's dir, so a lifecycle shell can
    // invoke the runtime by bare name even when the inherited PATH is stripped.
    // Use the ACTUAL executable basename (`bun`, or `bun.exe` when the installed
    // `bun` npm package's binary is the one running) rather than assuming a name.
    const runtime = basename(process.execPath);
    const env = childEnv({ PATH: "/missing" });
    const result = spawnSync("/bin/sh", ["-c", `${runtime} --version`], {
      encoding: "utf8",
      env,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /\d+\.\d+\.\d+/);
  });
});

describe("bunUsesRegistry", () => {
  it("adds registry routing only to package-resolving commands", () => {
    assert.equal(bunUsesRegistry(["add", "typescript"]), true);
    assert.equal(bunUsesRegistry(["install"]), true);
    assert.equal(bunUsesRegistry(["--silent", "update"]), true);
  });

  it("leaves init and forwarding commands alone", () => {
    assert.equal(bunUsesRegistry(["init"]), false);
    assert.equal(bunUsesRegistry(["x", "projen"]), false);
    assert.equal(bunUsesRegistry(["run", "build"]), false);
  });
});
