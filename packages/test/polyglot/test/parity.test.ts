import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  expectedResults,
  readJson,
  type FixtureResult,
  type FixtureSuite,
} from "../src/harness.ts";

const packageRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(packageRoot, "../../..");
const fixtureRoot = resolve(packageRoot, "fixtures");
const registryPath = resolve(fixtureRoot, "modules.json");
const fixturePaths = readdirSync(fixtureRoot)
  .filter((name) => name.endsWith(".json") && name !== "modules.json")
  .sort()
  .map((name) => resolve(fixtureRoot, name));

function run(command: string[], cwd: string): FixtureResult[] {
  const child = Bun.spawnSync(command, { cwd, stderr: "pipe", stdout: "pipe" });
  assert.equal(child.exitCode, 0, child.stderr.toString());
  return JSON.parse(child.stdout.toString()) as FixtureResult[];
}

describe("polyglot fixture parity", () => {
  for (const fixturePath of fixturePaths) {
    it(basename(fixturePath, ".json"), { timeout: 20_000 }, () => {
      const expected = expectedResults(readJson<FixtureSuite>(fixturePath));
      const typescript = run(["bun", "bin/run.ts", registryPath, fixturePath], packageRoot);
      const python = run(
        ["uv", "run", "python", resolve(packageRoot, "python/run.py"), registryPath, fixturePath],
        repositoryRoot,
      );

      assert.deepEqual(typescript, expected);
      assert.deepEqual(python, expected);
      assert.deepEqual(python, typescript);
    });
  }
});
