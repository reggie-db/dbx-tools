import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { delimiter, dirname } from "node:path";
import { describe, it } from "node:test";

import { childEnv } from "../src/pnpm.ts";

describe("childEnv", () => {
  it("makes the current Node executable available to lifecycle scripts", () => {
    const env = childEnv({ PATH: "/custom/bin" });

    assert.deepEqual(env.PATH?.split(delimiter), [dirname(process.execPath), "/custom/bin"]);
  });

  it("does not duplicate the Node executable directory", () => {
    const nodeBin = dirname(process.execPath);
    const env = childEnv({ PATH: [nodeBin, "/custom/bin"].join(delimiter) });

    assert.deepEqual(env.PATH?.split(delimiter), [nodeBin, "/custom/bin"]);
  });

  it("lets a lifecycle shell invoke node when the inherited PATH cannot", () => {
    const env = childEnv({ PATH: "/missing" });
    const result = spawnSync("/bin/sh", ["-c", "node --version"], {
      encoding: "utf8",
      env,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), process.version);
  });
});
