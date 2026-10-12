import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, it } from "node:test";
import { createMockRouter } from "@databricks/appkit/testing";
import { USER_EMAIL_HEADER, USER_ID_HEADER } from "@dbx-tools/appkit";
import { resolveSshPluginConfig } from "../src/config.ts";
import { AppKitSshPlugin } from "../src/plugin.ts";
import { SshRuntime } from "../src/runtime.ts";

interface UpgradeTestInternals {
  upgradeIdentityGate?: {
    isProtectedHost(headers: Headers): boolean;
    session(headers: Headers): Promise<string | undefined>;
  };
  handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void>;
}

function upgradeRequest(headers: IncomingMessage["headers"]): IncomingMessage {
  return {
    url: "/sandbox/desktop/websockify",
    headers,
  } as IncomingMessage;
}

describe("AppKitSshPlugin", () => {
  it("registers lifecycle, command, and dynamic route APIs", () => {
    const { router, handlers } = createMockRouter();
    const plugin = new AppKitSshPlugin({ auto: false });
    plugin.injectRoutes(router);
    assert.deepEqual(Object.keys(handlers), [
      "GET:/machines",
      "POST:/machines",
      "POST:/machines/:machineId/start",
      "POST:/machines/:machineId/stop",
      "DELETE:/machines/:machineId",
      "POST:/machines/:machineId/services/:service/start",
      "POST:/machines/:machineId/commands",
      "GET:/projects",
      "POST:/projects",
      "DELETE:/projects/:projectId",
      "POST:/projects/:projectId/terminal",
      "POST:/projects/:projectId/reset",
    ]);
    assert.deepEqual(
      plugin.getAgentTools().map(({ name }) => name),
      [
        "list_ssh_machines",
        "create_ssh_machine",
        "start_ssh_machine",
        "stop_ssh_machine",
        "delete_ssh_machine",
        "execute_ssh_command",
        "start_ssh_machine_service",
        "list_ssh_projects",
        "add_ssh_project",
        "open_ssh_project_terminal",
        "reset_ssh_project",
        "remove_ssh_project",
      ],
    );
    const tools = new Map(plugin.getAgentTools().map((tool) => [tool.name, tool]));
    assert.equal(tools.get("delete_ssh_machine")?.annotations?.destructive, true);
    assert.equal(tools.get("reset_ssh_project")?.annotations?.destructive, true);
    assert.equal(tools.get("remove_ssh_project")?.annotations?.destructive, true);
    const operations = plugin.exports().operations("user@example.com");
    assert.deepEqual(
      Object.keys(operations),
      plugin.getAgentTools().map(({ name }) => name),
    );
    assert.equal(operations.reset_ssh_project.schema.meta()?.appkitTool?.agentTool, true);
    assert.deepEqual(plugin.clientConfig(), { routePrefix: "/sandbox" });
    assert.equal(AppKitSshPlugin.manifest.name, "databricks-sandbox");
    assert.equal(AppKitSshPlugin.manifest.stability, "beta");
  });

  it("transparently retries failed OBO operations as the app service principal", async () => {
    const runtime = new SshRuntime(resolveSshPluginConfig({ fallbackToServicePrincipal: true }));
    const attempts: string[] = [];
    const result = await runtime.withAuthFallback(
      { operation: "listMachines", transport: "agent-tool", userId: "user@example.com" },
      {
        user: async () => {
          attempts.push("user-obo");
          throw Object.assign(new Error("missing all-apis"), { status: 403 });
        },
        servicePrincipal: async () => {
          attempts.push("app-service-principal");
          return "machines";
        },
      },
    );

    assert.equal(result, "machines");
    assert.deepEqual(attempts, ["user-obo", "app-service-principal"]);
    await runtime.close();
  });

  it("uses the verified tunnel session for owner-scoped WebSocket upgrades", async () => {
    const plugin = new AppKitSshPlugin({ auto: false });
    const internals = plugin as unknown as UpgradeTestInternals;
    let handled = false;
    internals.upgradeIdentityGate = {
      isProtectedHost: (headers) => headers.get("host") === "demo.apps.dbx.tools",
      session: async (headers) => {
        assert.equal(headers.get("cookie"), "dbx-tools-session=valid");
        return "owner@databricks.com";
      },
    };
    plugin.runtime.routes.canHandleUpgrade = () => true;
    plugin.runtime.routes.handleUpgrade = (request) => {
      handled = true;
      assert.equal(request.headers[USER_ID_HEADER], "owner@databricks.com");
      assert.equal(request.headers[USER_EMAIL_HEADER], "owner@databricks.com");
      return true;
    };
    const request = upgradeRequest({
      host: "demo.apps.dbx.tools",
      cookie: "dbx-tools-session=valid",
      [USER_ID_HEADER]: "spoofed@databricks.com",
      [USER_EMAIL_HEADER]: "spoofed@databricks.com",
    });

    try {
      await internals.handleUpgrade(request, new Socket(), Buffer.alloc(0));
      assert.equal(handled, true);
    } finally {
      await plugin.shutdown();
    }
  });

  it("rejects tunnel WebSocket upgrades without a verified session", async () => {
    const plugin = new AppKitSshPlugin({ auto: false });
    const internals = plugin as unknown as UpgradeTestInternals;
    let handled = false;
    internals.upgradeIdentityGate = {
      isProtectedHost: () => true,
      session: async () => undefined,
    };
    plugin.runtime.routes.canHandleUpgrade = () => true;
    plugin.runtime.routes.handleUpgrade = () => {
      handled = true;
      return true;
    };
    const socket = new Socket();
    const request = upgradeRequest({
      host: "demo.apps.dbx.tools",
      [USER_ID_HEADER]: "spoofed@databricks.com",
      [USER_EMAIL_HEADER]: "spoofed@databricks.com",
    });

    try {
      await internals.handleUpgrade(request, socket, Buffer.alloc(0));
      assert.equal(socket.destroyed, true);
      assert.equal(handled, false);
      assert.equal(request.headers[USER_ID_HEADER], undefined);
      assert.equal(request.headers[USER_EMAIL_HEADER], undefined);
    } finally {
      await plugin.shutdown();
    }
  });
});
