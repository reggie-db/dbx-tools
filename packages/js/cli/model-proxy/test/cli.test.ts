import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { json } from "@dbx-tools/shared-core";

import {
  buildProgram,
  ensurePythonProxy,
  type ModelProxyCliDependencies,
  restoreInstallArgs,
} from "../src/cli.ts";

const VERSION = String(
  json.parseRecord(readFileSync(new URL("../package.json", import.meta.url), "utf8"))?.version,
);

function dependencies(
  executables: Record<string, string | undefined>,
  run: ModelProxyCliDependencies["run"],
): ModelProxyCliDependencies {
  return {
    environment: {},
    findExecutable: async (name) => executables[name],
    run,
  };
}

function runtimeInfo(version = VERSION): string {
  return JSON.stringify({ implementation: "python-litellm", version });
}

describe("model proxy CLI", () => {
  it("keeps command construction lazy", () => {
    assert.doesNotThrow(() => buildProgram().helpInformation());
  });

  it("uses an installed exact-version Python proxy", async () => {
    const calls: Array<[string, readonly string[], boolean]> = [];
    const executable = await ensurePythonProxy(
      dependencies({ "dbx-model-proxy": "/bin/dbx-model-proxy" }, async (...call) => {
        calls.push(call);
        return { exitCode: 0, stdout: runtimeInfo(), stderr: "" };
      }),
    );

    assert.equal(executable, "/bin/dbx-model-proxy");
    assert.deepEqual(calls, [["/bin/dbx-model-proxy", ["--runtime-info"], true]]);
  });

  it("replaces a stale runtime through uv tool install", async () => {
    const calls: Array<[string, readonly string[], boolean]> = [];
    const executable = await ensurePythonProxy(
      dependencies(
        { "dbx-model-proxy": "/bin/old-proxy", uv: "/bin/uv" },
        async (command, args, capture) => {
          calls.push([command, args, capture]);
          if (command === "/bin/old-proxy") {
            return { exitCode: 0, stdout: runtimeInfo("0.9.20"), stderr: "" };
          }
          if (args[0] === "tool" && args[1] === "dir") {
            return { exitCode: 0, stdout: "/tools/bin\n", stderr: "" };
          }
          if (command === "/tools/bin/dbx-model-proxy") {
            return { exitCode: 0, stdout: runtimeInfo(), stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      ),
    );

    assert.equal(executable, "/tools/bin/dbx-model-proxy");
    assert.deepEqual(calls[1], [
      "/bin/uv",
      ["tool", "install", "--force", `dbx-tools-model-proxy==${VERSION}`],
      false,
    ]);
  });

  it("forwards lifecycle arguments to the Python executable", async () => {
    const calls: Array<[string, readonly string[], boolean]> = [];
    await buildProgram(
      "dbx model-proxy",
      dependencies({ "dbx-model-proxy": "/bin/dbx-model-proxy" }, async (...call) => {
        calls.push(call);
        return call[1][0] === "--runtime-info"
          ? { exitCode: 0, stdout: runtimeInfo(), stderr: "" }
          : { exitCode: 0, stdout: "", stderr: "" };
      }),
    ).parseAsync(["service", "status"], { from: "user" });

    assert.deepEqual(calls.at(-1), ["/bin/dbx-model-proxy", ["service", "status"], false]);
  });

  it("restores a Commander-stripped -- before server arguments", () => {
    assert.deepEqual(
      restoreInstallArgs(
        ["service", "install", "--port", "4003"],
        ["dbx", "model-proxy", "service", "install", "--", "--port", "4003"],
      ),
      ["--", "--port", "4003"],
    );
    assert.deepEqual(
      restoreInstallArgs(
        ["service", "install", "--config-dir", "/tmp/service", "--port", "4003"],
        [
          "dbx",
          "model-proxy",
          "service",
          "install",
          "--config-dir",
          "/tmp/service",
          "--",
          "--port",
          "4003",
        ],
      ),
      ["--config-dir", "/tmp/service", "--", "--port", "4003"],
    );
  });

  it("leaves install arguments unchanged when -- was not stripped", () => {
    assert.deepEqual(
      restoreInstallArgs(
        ["service", "install", "--config-dir", "/tmp/service"],
        ["dbx", "model-proxy", "service", "install", "--config-dir", "/tmp/service"],
      ),
      ["--config-dir", "/tmp/service"],
    );
    assert.deepEqual(
      restoreInstallArgs(
        ["service", "install", "--", "--port", "4003"],
        ["dbx", "model-proxy", "service", "install", "--", "--", "--port", "4003"],
      ),
      ["--", "--port", "4003"],
    );
  });
});
