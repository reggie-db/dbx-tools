import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/appkit";
import type { WorkspaceSandbox } from "@mastra/core/workspace";

import { DatabricksSandbox } from "../src/sandbox.ts";

type ApiRequest = {
  path: string;
  method: string;
  query?: Record<string, string>;
  payload?: unknown;
};

function workspaceClient(
  respond: (request: ApiRequest) => unknown | Promise<unknown>,
): WorkspaceClient {
  return {
    apiClient: {
      request: (request: ApiRequest) => Promise.resolve(respond(request)),
    },
  } as unknown as WorkspaceClient;
}

describe("DatabricksSandbox", () => {
  it("creates lazily and maps a completed command", async () => {
    const requests: ApiRequest[] = [];
    const client = workspaceClient((request) => {
      requests.push(request);
      if (request.method === "GET") throw { statusCode: 404, message: "not found" };
      if (request.path === "/api/2.0/sandboxes") {
        return {
          name: "sandboxes/demo",
          status: { state: "SANDBOX_STATE_RUNNING" },
          create_time: "2026-09-25T12:00:00Z",
        };
      }
      return {
        status: "EXECUTE_COMMAND_STATUS_COMPLETED",
        exit_code: 0,
        stdout: "hello\n",
        stderr: "",
        command_id: "command-1",
      };
    });
    const sandbox = new DatabricksSandbox({
      client,
      sandboxId: "demo",
      inactivityTimeout: "600s",
    });

    const result = await sandbox.executeCommand("printf", ["%s", "hello"], {
      cwd: "/work dir",
      env: { KEEP: "yes", DROP: undefined },
      timeout: 1_500,
    });

    assert.equal(result.success, true);
    assert.equal(result.stdout, "hello\n");
    assert.equal(sandbox.status, "running");
    assert.equal(requests[1]?.path, "/api/2.0/sandboxes");
    assert.equal(requests[1]?.method, "POST");
    assert.deepEqual(requests[1]?.query, { sandbox_id: "demo" });
    assert.deepEqual(requests[1]?.payload, {
      display_name: "Mastra sandbox demo",
      spec: { compute: { inactivity_timeout: "600s" } },
    });
    assert.deepEqual(requests[2]?.payload, {
      cmd: "/bin/bash",
      args: ["-lc", "cd -- '/work dir' && 'printf' '%s' 'hello'"],
      envs: { KEEP: "yes" },
      execution_timeout: "2s",
    });
  });

  it("starts an existing stopped sandbox before execution", async () => {
    const requests: ApiRequest[] = [];
    const client = workspaceClient((request) => {
      requests.push(request);
      if (request.method === "GET") {
        return { name: "sandboxes/demo", status: { state: "SANDBOX_STATE_STOPPED" } };
      }
      if (request.path.endsWith("/start")) {
        return { name: "sandboxes/demo", status: { state: "SANDBOX_STATE_RUNNING" } };
      }
      return {
        status: "EXECUTE_COMMAND_STATUS_COMPLETED",
        exit_code: 0,
        stdout: "",
        stderr: "",
      };
    });
    const sandbox = new DatabricksSandbox({ client, sandboxId: "sandboxes/demo" });

    await sandbox.executeCommand("true");

    assert.ok(requests.some((request) => request.path.endsWith("/demo/start")));
    assert.equal(requests.at(-1)?.path, "/api/2.0/sandbox-exec/sandboxes/demo/exec-sync");
  });

  it("coalesces concurrent starts for one stopped sandbox", async () => {
    let starts = 0;
    const client = workspaceClient(async (request) => {
      if (request.method === "GET") {
        return { name: "sandboxes/demo", status: { state: "SANDBOX_STATE_STOPPED" } };
      }
      if (request.path.endsWith("/start")) {
        starts++;
        await Promise.resolve();
        return { name: "sandboxes/demo", status: { state: "SANDBOX_STATE_RUNNING" } };
      }
      return {
        status: "EXECUTE_COMMAND_STATUS_COMPLETED",
        exit_code: 0,
      };
    });
    const sandbox = new DatabricksSandbox({ client, sandboxId: "demo" });

    await Promise.all([sandbox.executeCommand("true"), sandbox.executeCommand("true")]);

    assert.equal(starts, 1);
  });

  it("recovers when another request creates the stable sandbox first", async () => {
    let getCalls = 0;
    const client = workspaceClient((request) => {
      if (request.method === "GET") {
        getCalls++;
        if (getCalls === 1) throw { statusCode: 404, message: "not found" };
        return { name: "sandboxes/demo", status: { state: "SANDBOX_STATE_RUNNING" } };
      }
      if (request.path === "/api/2.0/sandboxes") {
        throw { statusCode: 409, message: "already exists" };
      }
      return {
        status: "EXECUTE_COMMAND_STATUS_COMPLETED",
        exit_code: 0,
      };
    });
    const sandbox = new DatabricksSandbox({ client, sandboxId: "demo" });

    const result = await sandbox.executeCommand("true");

    assert.equal(getCalls, 2);
    assert.equal(result.success, true);
  });

  it("uses the configured fallback when the Databricks preview is unavailable", async () => {
    const client = workspaceClient(() => {
      throw { statusCode: 404, message: "FEATURE_DISABLED: Sandbox preview is not enabled" };
    });
    const fallback: WorkspaceSandbox = {
      id: "fallback",
      name: "Fallback",
      provider: "test-fallback",
      status: "pending",
      async snapshot() {},
      async start() {
        this.status = "running";
      },
      async executeCommand(command, args = []) {
        return {
          command,
          args,
          success: true,
          exitCode: 0,
          stdout: "fallback\n",
          stderr: "",
          executionTimeMs: 1,
        };
      },
    };
    const sandbox = new DatabricksSandbox({
      client,
      sandboxId: "demo",
      fallback,
    });

    const result = await sandbox.executeCommand("print('fallback')");

    assert.equal(sandbox.provider, "test-fallback");
    assert.equal(sandbox.status, "running");
    assert.equal(result.stdout, "fallback\n");
  });

  it("falls back to the Node Monty runtime by default", async () => {
    const client = workspaceClient(() => {
      throw { statusCode: 404, message: "FEATURE_DISABLED" };
    });
    const sandbox = new DatabricksSandbox({ client, sandboxId: "demo" });

    const result = await sandbox.executeCommand("'monty fallback'");

    assert.equal(sandbox.provider, "monty");
    assert.equal(result.success, true);
    assert.equal(result.stdout, "monty fallback\n");
  });

  it("does not hide authentication or transient failures behind fallback", async () => {
    for (const failure of [
      { statusCode: 401, message: "invalid credentials" },
      { statusCode: 403, message: "PERMISSION_DENIED: principal is not authorized" },
      {
        statusCode: 403,
        message: "PERMISSION_DENIED: principal is not authorized to access preview features",
      },
      { statusCode: 500, message: "temporary service failure" },
      new Error("network unavailable"),
    ]) {
      const sandbox = new DatabricksSandbox({
        client: workspaceClient(() => {
          throw failure;
        }),
        sandboxId: "demo",
      });

      await assert.rejects(() => sandbox.executeCommand("'must not run'"));
      assert.equal(sandbox.provider, "databricks");
      assert.equal(sandbox.status, "error");
    }
  });

  it("provides a no-op snapshot for providers without checkpoints", async () => {
    const sandbox = new DatabricksSandbox({
      client: workspaceClient(() => ({
        name: "sandboxes/demo",
        status: { state: "SANDBOX_STATE_RUNNING" },
      })),
      sandboxId: "demo",
    });

    await sandbox.snapshot();

    assert.equal(sandbox.supportsCheckpoints, false);
  });

  it("reports timeout and truncation without changing the output", async () => {
    const client = workspaceClient((request) => {
      if (request.method === "GET") {
        return { name: "sandboxes/demo", status: { state: "SANDBOX_STATE_RUNNING" } };
      }
      return {
        status: "EXECUTE_COMMAND_STATUS_TIMED_OUT",
        stdout: "latest output",
        stderr: "timed out",
        truncated: true,
      };
    });
    const sandbox = new DatabricksSandbox({ client, sandboxId: "demo" });

    const result = await sandbox.executeCommand("sleep 60");

    assert.equal(result.success, false);
    assert.equal(result.exitCode, -1);
    assert.equal(result.timedOut, true);
    assert.equal(result.killed, true);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, true);
    assert.equal(result.stdout, "latest output");
    assert.equal(result.stderr, "timed out");
  });
});
