import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  expectedResults,
  readFixture,
  type FixtureResult,
  type FixtureSuite,
} from "../src/harness.ts";

const packageRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(packageRoot, "../../..");
const fixtureRoot = resolve(packageRoot, "fixtures");
const supportBin = resolve(packageRoot, "test/support/bin");
const fixturePaths = recursiveFiles(fixtureRoot)
  .filter(
    (path) => /\.(?:json|ya?ml)$/.test(path) && !/^default\.(?:json|ya?ml)$/.test(basename(path)),
  )
  .sort();

function run(command: string[], cwd: string): FixtureResult[] {
  const child = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, PATH: `${supportBin}:${process.env.PATH ?? ""}` },
    stderr: "pipe",
    stdout: "pipe",
  });
  assert.equal(child.exitCode, 0, child.stderr.toString());
  return JSON.parse(child.stdout.toString()) as FixtureResult[];
}

describe("polyglot fixture parity", () => {
  for (const fixturePath of fixturePaths) {
    it(relative(fixtureRoot, fixturePath), { timeout: 20_000 }, () => {
      const expected = expectedResults(readFixture(fixturePath));
      const typescript = run(["bun", "bin/run.ts", fixturePath], packageRoot);
      const python = run(
        ["uv", "run", "python", resolve(packageRoot, "python/run.py"), fixturePath],
        repositoryRoot,
      );

      assert.deepEqual(typescript, expected);
      assert.deepEqual(python, expected);
      assert.deepEqual(python, typescript);
    });
  }
});

function recursiveFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? recursiveFiles(path) : [path];
  });
}
