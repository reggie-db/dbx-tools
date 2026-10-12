import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/appkit";
import { MASTRA_USER_KEY } from "@dbx-tools/appkit-mastra";
import { RequestContext } from "@mastra/core/request-context";
import type { SshRuntime } from "../src/runtime.ts";
import { sshWorkspaceSandbox } from "../src/workspace.ts";

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

    assert.match(sandbox.getInstructions?.() ?? "", /Continue normal chat without code execution/);
    assert.ok(sandbox.executeCommand);
    await assert.rejects(sandbox.executeCommand("pwd"), /No Databricks Sandbox exists/);
  });
});
