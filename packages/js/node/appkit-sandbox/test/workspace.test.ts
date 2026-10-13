import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/appkit";
import { MASTRA_USER_KEY } from "@dbx-tools/appkit-mastra";
import { RequestContext } from "@mastra/core/request-context";
import type { SshRuntime } from "../src/runtime.ts";
import { SshCommand } from "../src/session.ts";
import { SshWorkspaceSandbox, sshWorkspaceSandbox } from "../src/workspace.ts";

describe("sshWorkspaceSandbox", () => {
  it("keeps chat available when the user has no Sandbox", async () => {
    const runtime = {
      withAuthFallback: async (_operation: unknown, attempts: { user?: () => Promise<unknown> }) =>
        attempts.user?.(),
      listMachines: async () => ({ auto: true, supported: true, machines: [] }),
    } as unknown as SshRuntime;
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_USER_KEY, {
      id: "user@example.com",
      executionContext: { client: {} as WorkspaceClient },
    });

    const sandbox = await sshWorkspaceSandbox(runtime)({ requestContext });

    const instructions = sandbox.getInstructions?.() ?? "";
    assert.match(instructions, /Continue normal chat, direct tool calls, and native Code Mode/);
    assert.match(instructions, /does not require SSH/);
    assert.match(instructions, /Do not create a Sandbox merely to enable code execution/);
    assert.match(instructions, /Never return localhost/);
    assert.match(instructions, /generates a unique name, path, and port/);
    assert.match(instructions, /PROJECT_NAME, PROJECT_PATH, and PROJECT_PORT/);
    assert.ok(sandbox.executeCommand);
    await assert.rejects(
      sandbox.executeCommand("pwd"),
      /reuse or create a Sandbox only for an explicitly requested SSH-backed operation/,
    );
  });

  it("instructs assigned Sandboxes to expose services only through prefix-aware routes", async () => {
    const runtime = {
      withAuthFallback: async (_operation: unknown, attempts: { user?: () => Promise<unknown> }) =>
        attempts.user?.(),
      listMachines: async () => ({
        auto: true,
        supported: true,
        machines: [
          {
            id: "sandbox-1",
            name: "sandbox-1",
            provider: "databricks-sandbox",
            status: "running",
            gatewayHost: "gateway.example",
            projects: [],
            services: [],
          },
        ],
      }),
    } as unknown as SshRuntime;
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_USER_KEY, {
      id: "user@example.com",
      executionContext: { client: {} as WorkspaceClient },
    });

    const sandbox = await sshWorkspaceSandbox(runtime)({ requestContext });
    const instructions = sandbox.getInstructions?.() ?? "";

    assert.match(instructions, /return openUrl/i);
    assert.match(instructions, /route: false/);
    assert.match(instructions, /serviceDependencies/);
    assert.match(instructions, /sandbox-user/);
    assert.match(instructions, /\/home\/sandbox-user\/projects/);
    assert.match(instructions, /outside the project mise configuration/);
    assert.match(instructions, /relative asset and API URLs/);
    assert.match(instructions, /derive ws:\/\/ or wss:\/\//);
    assert.match(instructions, /Raw TCP, UDP/);
  });

  it("forwards live output and applies Mastra retention to the completed result", async () => {
    const runtime = {
      withAuthFallback: async (_operation: unknown, attempts: { user?: () => Promise<unknown> }) =>
        attempts.user?.(),
      execute: (client: WorkspaceClient, userId: string) => {
        assert.ok(client);
        assert.equal(userId, "user@example.com");
        return new SshCommand("demo", [], { timeoutMs: 1_000 }, async (execution) => {
          execution.stdout("older");
          execution.stdout("new");
          execution.stderr("warning");
          return 0;
        });
      },
    } as unknown as SshRuntime;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const sandbox = new SshWorkspaceSandbox(
      "sandbox-1",
      "sandbox-1",
      runtime,
      {} as WorkspaceClient,
      "user@example.com",
    );

    const result = await sandbox.executeCommand("demo", [], {
      maxRetainedBytes: 4,
      onStdout: (chunk) => stdout.push(chunk),
      onStderr: (chunk) => stderr.push(chunk),
    });

    assert.deepEqual(stdout, ["older", "new"]);
    assert.deepEqual(stderr, ["warning"]);
    assert.equal(result.stdout, "rnew");
    assert.equal(result.stderr, "ning");
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stdoutDroppedBytes, 4);
    assert.equal(result.stderrTruncated, true);
    assert.equal(result.stderrDroppedBytes, 3);
  });
});
