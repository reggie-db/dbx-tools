import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GRAPHITI_PYTHON_VERSION } from "../src/_python-runtime.ts";
import { ensureGraphitiModelGateway, ensureGraphitiPython } from "../src/runtime.ts";

describe("Graphiti runtime preparation", () => {
  it("does not install when the matching Python version is present", async () => {
    const calls: string[][] = [];
    await ensureGraphitiPython("python3", async (_file, args) => {
      calls.push(args);
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.[1] ?? "", /importlib\.metadata\.version/);
  });

  it("installs the matching Python version through the configured registry", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    await ensureGraphitiPython("python3", async (file, args) => {
      calls.push({ file, args });
      if (calls.length === 1) throw new Error("missing module");
    });
    assert.equal(calls[0]?.file, "python3");
    assert.deepEqual(calls[1], { file: "python3", args: ["-m", "pip", "--version"] });
    assert.ok(calls[2]?.args.includes("--upgrade"));
    assert.equal(calls[2]?.args.at(-1), `dbx-tools-graphiti==${GRAPHITI_PYTHON_VERSION}`);
    assert.ok(!calls.flatMap((call) => call.args).some((arg) => arg.includes("https://")));
  });

  it("fails without downloading a bootstrap script when pip is absent", async () => {
    const calls: string[][] = [];
    await assert.rejects(
      ensureGraphitiPython("python3", async (_file, args) => {
        calls.push(args);
        throw new Error("missing pip");
      }),
      /missing pip/,
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], ["-m", "pip", "--version"]);
  });

  it("propagates installation failures", async () => {
    let calls = 0;
    await assert.rejects(
      ensureGraphitiPython("python3", async () => {
        calls += 1;
        if (calls === 1) throw new Error("missing module");
        if (calls === 3) throw new Error("registry unavailable");
      }),
      /registry unavailable/,
    );
  });

  it("shell-quotes the absolute foreground model-gateway path", () => {
    const command = ensureGraphitiModelGateway(
      () => "/cache/Graphiti's gateway/bin/dbx-model-gateway.ts",
    );
    assert.ok(command.startsWith(`'${process.execPath}' `));
    assert.ok(command.includes("Graphiti'\\''s gateway"));
    assert.match(command, /dbx-model-gateway\.ts/);
  });
});
