import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildServiceCommand, type CliServiceCliDependencies } from "../src/cli.ts";
import type { CliServiceLifecycle } from "../src/service.ts";

function testDependencies(calls: string[], output: string[]): CliServiceCliDependencies {
  const service: CliServiceLifecycle = {
    async install(options) {
      calls.push(`install:${String(options?.start)}`);
    },
    async start() {
      calls.push("start");
    },
    async stop() {
      calls.push("stop");
    },
    async restart() {
      calls.push("restart");
    },
    async uninstall() {
      calls.push("uninstall");
    },
    async status() {
      calls.push("status");
      return { installed: true, running: false };
    },
  };
  return {
    create: () => service,
    write: (value) => output.push(value),
  };
}

function program(calls: string[], output: string[]): ReturnType<typeof buildServiceCommand> {
  return buildServiceCommand(
    {
      id: "com.example.gateway",
      name: "Example Gateway",
      version: "1.2.3",
      icon: "/icon.png",
    },
    testDependencies(calls, output),
  );
}

describe("CLI service command", () => {
  it("provides the complete lifecycle command group", () => {
    const help = program([], []).helpInformation();

    for (const command of ["install", "start", "stop", "restart", "status", "uninstall"]) {
      assert.match(help, new RegExp(command));
    }
  });

  it("forwards install and lifecycle actions", async () => {
    const calls: string[] = [];
    const output: string[] = [];

    await program(calls, output).parseAsync(["install", "--no-start"], { from: "user" });
    await program(calls, output).parseAsync(["start"], { from: "user" });
    await program(calls, output).parseAsync(["stop"], { from: "user" });
    await program(calls, output).parseAsync(["restart"], { from: "user" });
    await program(calls, output).parseAsync(["uninstall"], { from: "user" });

    assert.deepEqual(calls, ["install:false", "start", "stop", "restart", "uninstall"]);
  });

  it("writes structured status output", async () => {
    const calls: string[] = [];
    const output: string[] = [];

    await program(calls, output).parseAsync(["status"], { from: "user" });

    assert.deepEqual(calls, ["status"]);
    assert.deepEqual(output, ['{\n  "installed": true,\n  "running": false\n}\n']);
  });
});
