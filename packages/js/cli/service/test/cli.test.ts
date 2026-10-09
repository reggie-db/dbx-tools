import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildServiceCommand, type CliServiceCliDependencies } from "../src/cli.ts";
import type { CliServiceLifecycle } from "../src/service.ts";

interface ExecutedCommand {
  readonly command: string;
  readonly arguments: readonly string[];
}

function testDependencies(
  calls: string[],
  output: string[],
  executed: ExecutedCommand[],
): CliServiceCliDependencies {
  const service: CliServiceLifecycle = {
    async install(options) {
      calls.push(
        `install:${String(options?.start)}:${options?.pythonProject ?? ""}:${String(options?.offline)}`,
      );
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
    logPath() {
      calls.push("logs");
      return "/var/log/example-gateway.log";
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
    execute: async (command, arguments_) => {
      executed.push({ command, arguments: arguments_ });
    },
  };
}

function program(
  calls: string[],
  output: string[],
  executed: ExecutedCommand[] = [],
): ReturnType<typeof buildServiceCommand> {
  return buildServiceCommand(
    {
      id: "com.example.gateway",
      name: "Example Gateway",
      packageName: "@example/gateway",
      version: "1.2.3",
      icon: "/icon.png",
    },
    testDependencies(calls, output, executed),
  );
}

describe("CLI service command", () => {
  it("provides the complete lifecycle command group", () => {
    const help = program([], []).helpInformation();

    for (const command of ["install", "start", "stop", "restart", "status", "logs", "uninstall"]) {
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

    assert.deepEqual(calls, ["install:false::false", "start", "stop", "restart", "uninstall"]);
  });

  it("forwards a local Python project installation", async () => {
    const calls: string[] = [];

    await program(calls, []).parseAsync(
      ["install", "--python-project", "packages/py/graphiti", "--offline"],
      { from: "user" },
    );

    assert.deepEqual(calls, ["install:true:packages/py/graphiti:true"]);
  });

  it("writes structured status output", async () => {
    const calls: string[] = [];
    const output: string[] = [];

    await program(calls, output).parseAsync(["status"], { from: "user" });

    assert.deepEqual(calls, ["status"]);
    assert.deepEqual(output, ['{\n  "installed": true,\n  "running": false\n}\n']);
  });

  it("prints the service log path", async () => {
    const calls: string[] = [];
    const output: string[] = [];

    await program(calls, output).parseAsync(["logs"], { from: "user" });

    assert.deepEqual(calls, ["logs"]);
    assert.deepEqual(output, ["/var/log/example-gateway.log\n"]);
  });

  it("appends the service log path to supplied command arguments", async () => {
    const calls: string[] = [];
    const output: string[] = [];
    const executed: ExecutedCommand[] = [];

    await program(calls, output, executed).parseAsync(["logs", "--", "cat"], {
      from: "user",
    });
    await program(calls, output, executed).parseAsync(["logs", "--", "tail", "-f"], {
      from: "user",
    });

    assert.deepEqual(calls, ["logs", "logs"]);
    assert.deepEqual(output, []);
    assert.deepEqual(executed, [
      {
        command: "cat",
        arguments: ["/var/log/example-gateway.log"],
      },
      {
        command: "tail",
        arguments: ["-f", "/var/log/example-gateway.log"],
      },
    ]);
  });
});
