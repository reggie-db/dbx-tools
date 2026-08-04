import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { readCoreIdentityCases, type CoreIdentityResult } from "../src/core-identity.ts";

const packageRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(packageRoot, "../../..");
const fixturePath = resolve(packageRoot, "fixtures/core-identity.json");

function run(command: string[], cwd: string): CoreIdentityResult[] {
  const child = Bun.spawnSync(command, { cwd, stderr: "pipe", stdout: "pipe" });
  assert.equal(child.exitCode, 0, child.stderr.toString());
  return JSON.parse(child.stdout.toString()) as CoreIdentityResult[];
}

describe("core identity polyglot parity", () => {
  it("emits identical hash, stable-key, and identifier results", { timeout: 20_000 }, () => {
    const expected = readCoreIdentityCases(fixturePath).map(({ name, expected: output }) => ({
      name,
      ...output,
    }));
    const typescript = run(["bun", "bin/core-identity.ts", fixturePath], packageRoot);
    const python = run(
      ["uv", "run", "python", resolve(packageRoot, "python/core_identity.py"), fixturePath],
      repositoryRoot,
    );

    assert.deepEqual(typescript, expected);
    assert.deepEqual(python, expected);
    assert.deepEqual(python, typescript);
  });
});
