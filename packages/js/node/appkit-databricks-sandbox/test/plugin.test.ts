import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMockRouter } from "@databricks/appkit/testing";
import { resolveSshPluginConfig } from "../src/config.ts";
import { AppKitSshPlugin } from "../src/plugin.ts";
import { SshRuntime } from "../src/runtime.ts";

describe("AppKitSshPlugin", () => {
  it("registers lifecycle, command, and dynamic route APIs", () => {
    const { router, handlers } = createMockRouter();
    const plugin = new AppKitSshPlugin({ auto: false });
    plugin.injectRoutes(router);
    assert.deepEqual(Object.keys(handlers), [
      "GET:/machines",
      "POST:/machines/:machineId/start",
      "POST:/machines/:machineId/stop",
      "POST:/machines/:machineId/services/:service/start",
      "POST:/machines/:machineId/commands",
      "GET:/routes",
      "POST:/routes",
      "DELETE:/routes/:routeId",
    ]);
    assert.deepEqual(
      plugin.getAgentTools().map(({ name }) => name),
      [
        "list_ssh_machines",
        "start_ssh_machine",
        "stop_ssh_machine",
        "execute_ssh_command",
        "start_ssh_machine_service",
        "add_ssh_route",
        "remove_ssh_route",
      ],
    );
    assert.deepEqual(plugin.clientConfig(), { routePrefix: "/sandbox", defaultRemotePort: 3000 });
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
});
