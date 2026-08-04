import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { readChannelCases, type ChannelResult } from "../src/channel.ts";

const packageRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(packageRoot, "../../..");
const fixturePath = resolve(packageRoot, "fixtures/channel.json");

function run(command: string[], cwd: string): ChannelResult[] {
  const child = Bun.spawnSync(command, { cwd, stderr: "pipe", stdout: "pipe" });
  assert.equal(child.exitCode, 0, child.stderr.toString());
  return JSON.parse(child.stdout.toString()) as ChannelResult[];
}

describe("Postgres channel-name polyglot parity", () => {
  it("emits identical expected results from TypeScript and Python", { timeout: 20_000 }, () => {
    const expected = readChannelCases(fixturePath).map(({ name, expected: result }) => ({
      name,
      result,
    }));
    const typescript = run(["bun", "bin/channel.ts", fixturePath], packageRoot);
    const python = run(
      ["uv", "run", "python", resolve(packageRoot, "python/channel.py"), fixturePath],
      repositoryRoot,
    );

    assert.deepEqual(typescript, expected);
    assert.deepEqual(python, expected);
    assert.deepEqual(python, typescript);
  });
});
