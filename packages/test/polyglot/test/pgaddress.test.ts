import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { readPgAddressCases, type PgAddressResult } from "../src/pgaddress.ts";

const packageRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(packageRoot, "../../..");
const fixturePath = resolve(packageRoot, "fixtures/pgaddress.json");

function run(command: string[], cwd: string): PgAddressResult[] {
  const child = Bun.spawnSync(command, { cwd, stderr: "pipe", stdout: "pipe" });
  assert.equal(child.exitCode, 0, child.stderr.toString());
  return JSON.parse(child.stdout.toString()) as PgAddressResult[];
}

describe("pgaddress polyglot parity", () => {
  it("emits identical expected results from TypeScript and Python", { timeout: 20_000 }, () => {
    const expected = readPgAddressCases(fixturePath).map(({ name, expected: result }) => ({
      name,
      result,
    }));
    const typescript = run(["bun", "bin/pgaddress.ts", fixturePath], packageRoot);
    const python = run(
      ["uv", "run", "python", resolve(packageRoot, "python/pgaddress.py"), fixturePath],
      repositoryRoot,
    );

    assert.deepEqual(typescript, expected);
    assert.deepEqual(python, expected);
    assert.deepEqual(python, typescript);
  });
});
