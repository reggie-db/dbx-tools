import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/appkit";
import { resolveSshPluginConfig } from "../src/config.ts";
import { DiskMachineOwnershipStore, LakebaseMachineOwnershipStore } from "../src/ownership.ts";
import { SshRuntime } from "../src/runtime.ts";
import type { SshSession } from "../src/session.ts";

const temporaryDirectories: string[] = [];
const unusedSession = {
  close: () => undefined,
  forwardOut: async () => assert.fail("not used"),
} as unknown as SshSession;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function temporaryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dbx-tools-ssh-ownership-"));
  temporaryDirectories.push(directory);
  return join(directory, "assignments.json");
}

describe("machine ownership", () => {
  it("provisions the Lakebase table in its owning schema", async () => {
    const statements: string[] = [];
    const pool = {
      connect: async () => ({
        query: async (text: string) => {
          statements.push(text);
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
      }),
      query: async (text: string) => {
        statements.push(text);
        return { rows: [], rowCount: text.startsWith("DELETE") ? 2 : 0 };
      },
    } as unknown as Parameters<typeof LakebaseMachineOwnershipStore.create>[0];

    const ownership = await LakebaseMachineOwnershipStore.create(pool);

    assert.ok(
      statements.some((statement) =>
        statement.includes("CREATE SCHEMA IF NOT EXISTS dbx_tools_databricks_sandbox"),
      ),
    );
    assert.ok(
      statements.some((statement) =>
        statement.includes(
          "CREATE TABLE IF NOT EXISTS dbx_tools_databricks_sandbox.machine_assignments",
        ),
      ),
    );
    assert.equal(await ownership.unassignAll("workspace", "machine"), 2);
    assert.ok(
      statements.some((statement) =>
        statement.includes(
          "DELETE FROM dbx_tools_databricks_sandbox.machine_assignments WHERE workspace_scope = $1 AND machine_id = $2",
        ),
      ),
    );
  });

  it("persists user-scoped assignments on disk", async () => {
    const path = await temporaryPath();
    const first = new DiskMachineOwnershipStore(path);
    await first.assign("workspace", "user-a", "machine-a");
    await first.assign("workspace", "user-a", "machine-a");
    await first.assign("workspace", "user-b", "machine-b");

    const reopened = new DiskMachineOwnershipStore(path);
    assert.deepEqual([...(await reopened.listMachineIds("workspace", "user-a"))], ["machine-a"]);
    assert.equal(await reopened.has("workspace", "user-b", "machine-a"), false);
    assert.equal(await reopened.unassign("workspace", "user-a", "machine-a"), true);
    assert.equal(await reopened.has("workspace", "user-a", "machine-a"), false);
    await reopened.assign("workspace", "user-a", "machine-b");
    await reopened.assign("workspace", "user-b", "machine-b");
    assert.equal(await reopened.unassignAll("workspace", "machine-b"), 2);
    assert.equal(await reopened.has("workspace", "user-a", "machine-b"), false);
    assert.equal(await reopened.has("workspace", "user-b", "machine-b"), false);
  });

  it("filters service-principal discovery and rejects unassigned lifecycle access", async () => {
    const path = await temporaryPath();
    const requests: Array<Record<string, unknown>> = [];
    const client = {
      config: { workspaceId: "workspace", host: "https://example.databricks.com" },
      apiClient: {
        request: async (request: Record<string, unknown>) => {
          requests.push(request);
          return {
            sandboxes: [
              { sandboxId: "assigned", status: "RUNNING" },
              { sandboxId: "other", status: "RUNNING" },
            ],
          };
        },
      },
    } as unknown as WorkspaceClient;
    const runtime = new SshRuntime(
      resolveSshPluginConfig({
        ownershipPath: path,
        machineAssignments: [{ userId: "user-a", machineId: "assigned" }],
      }),
    );

    const visible = await runtime.listMachines(client, "user-a");
    assert.deepEqual(
      visible.machines.map((machine) => machine.id),
      ["assigned"],
    );
    assert.deepEqual(visible.machines[0]?.services, [
      {
        kind: "terminal",
        path: "/sandbox/terminal/assigned",
        state: "stopped",
      },
      {
        kind: "stats",
        path: "/sandbox/metrics/assigned",
        state: "stopped",
      },
    ]);
    assert.deepEqual((await runtime.listMachines(client, "user-b")).machines, []);
    await assert.rejects(
      runtime.startMachine(client, "user-b", "assigned"),
      /not assigned to the current user/,
    );
    assert.equal(requests.length, 2);
    await runtime.close();
  });

  it("starts a machine even when optional browser services cannot be provisioned", async () => {
    const path = await temporaryPath();
    const client = {
      config: { workspaceId: "workspace", host: "https://example.databricks.com" },
      apiClient: {
        request: async (request: { path: string; method: string }) => ({
          sandboxId: "assigned",
          status: request.method === "POST" ? "RUNNING" : "STOPPED",
        }),
      },
    } as unknown as WorkspaceClient;
    const runtime = new SshRuntime(
      resolveSshPluginConfig({
        ownershipPath: path,
        machineAssignments: [{ userId: "user-a", machineId: "assigned" }],
      }),
    );
    const attempted: string[] = [];
    runtime.startService = async (_client, _userId, input) => {
      attempted.push(input.service);
      throw new Error(`${input.service} unavailable`);
    };

    const machine = await runtime.startMachine(client, "user-a", "assigned");

    assert.equal(machine.status, "running");
    assert.deepEqual(attempted.sort(), ["stats", "terminal"]);
    await runtime.close();
  });

  it("assigns created machines to the caller and only lets that caller delete them", async () => {
    const path = await temporaryPath();
    const ownership = new DiskMachineOwnershipStore(path);
    const requests: Array<{ path: string; method: string; payload?: unknown }> = [];
    const client = {
      config: { workspaceId: "workspace", host: "https://example.databricks.com" },
      apiClient: {
        request: async (request: { path: string; method: string; payload?: unknown }) => {
          requests.push(request);
          if (request.method === "POST") {
            return { sandboxId: "created", status: "Running", name: "project" };
          }
          return {};
        },
      },
    } as unknown as WorkspaceClient;
    const runtime = new SshRuntime(resolveSshPluginConfig({ ownershipPath: path }), ownership);

    const created = await runtime.createMachine(client, "user-a", { name: "project" });
    await assert.rejects(
      runtime.deleteMachine(client, "user-b", created.id),
      /not assigned to the current user/,
    );
    await ownership.assign("workspace", "user-b", created.id);
    await runtime.routes.add(unusedSession, {
      ownerId: "user-a",
      machineId: created.id,
      remoteHost: "127.0.0.1",
      remotePort: 3000,
      path: "/project-a",
    });
    await runtime.routes.add(unusedSession, {
      ownerId: "user-b",
      machineId: created.id,
      remoteHost: "127.0.0.1",
      remotePort: 3000,
      path: "/project-b",
    });
    assert.deepEqual(await runtime.deleteMachine(client, "user-a", created.id), {
      deleted: true,
    });

    assert.equal(created.id, "created");
    assert.equal(await ownership.has("workspace", "user-a", created.id), false);
    assert.equal(await ownership.has("workspace", "user-b", created.id), false);
    assert.deepEqual(runtime.routeList(), []);
    assert.deepEqual(requests[0]?.payload, { sandbox: { name: "project" } });
    assert.equal(requests.at(-1)?.method, "DELETE");
    await runtime.close();
  });

  it("revokes one user's routes immediately when its assignment is removed", async () => {
    const path = await temporaryPath();
    const ownership = new DiskMachineOwnershipStore(path);
    await ownership.assign("workspace", "user-a", "assigned");
    const client = {
      config: { workspaceId: "workspace", host: "https://example.databricks.com" },
    } as unknown as WorkspaceClient;
    const runtime = new SshRuntime(resolveSshPluginConfig({ ownershipPath: path }), ownership);
    await runtime.routes.add(unusedSession, {
      ownerId: "user-a",
      machineId: "assigned",
      remoteHost: "127.0.0.1",
      remotePort: 3000,
      path: "/project",
    });

    assert.equal(await runtime.unassignMachine(client, "user-a", "assigned"), true);
    assert.deepEqual(runtime.routeList("user-a"), []);
    assert.equal(await ownership.has("workspace", "user-a", "assigned"), false);
    await runtime.close();
  });

  it("clears every user's runtime routes when a shared machine stops", async () => {
    const path = await temporaryPath();
    const ownership = new DiskMachineOwnershipStore(path);
    await ownership.assign("workspace", "user-a", "assigned");
    await ownership.assign("workspace", "user-b", "assigned");
    const client = {
      config: { workspaceId: "workspace", host: "https://example.databricks.com" },
      apiClient: {
        request: async (request: { method: string }) => ({
          sandboxId: "assigned",
          status: request.method === "POST" ? "STOPPED" : "RUNNING",
        }),
      },
    } as unknown as WorkspaceClient;
    const runtime = new SshRuntime(resolveSshPluginConfig({ ownershipPath: path }), ownership);
    for (const userId of ["user-a", "user-b"]) {
      await runtime.routes.add(unusedSession, {
        ownerId: userId,
        machineId: "assigned",
        remoteHost: "127.0.0.1",
        remotePort: 3000,
        path: `/${userId}`,
      });
    }

    await runtime.stopMachine(client, "user-a", "assigned");

    assert.deepEqual(runtime.routeList(), []);
    assert.equal(await ownership.has("workspace", "user-a", "assigned"), true);
    assert.equal(await ownership.has("workspace", "user-b", "assigned"), true);
    await runtime.close();
  });

  it("removes a route created concurrently with assignment revocation", async () => {
    const path = await temporaryPath();
    const ownership = new DiskMachineOwnershipStore(path);
    await ownership.assign("workspace", "user-a", "assigned");
    const client = {
      config: { workspaceId: "workspace", host: "https://example.databricks.com" },
      apiClient: {
        request: async () => ({ sandboxId: "assigned", status: "RUNNING" }),
      },
    } as unknown as WorkspaceClient;
    const runtime = new SshRuntime(resolveSshPluginConfig({ ownershipPath: path }), ownership);
    Object.defineProperty(runtime, "ensureSession", {
      value: async () => unusedSession,
    });
    const originalAdd = runtime.routes.add.bind(runtime.routes);
    let routeAdded!: () => void;
    let resumeAdd!: () => void;
    const routeWasAdded = new Promise<void>((resolve) => {
      routeAdded = resolve;
    });
    const resumeRouteAdd = new Promise<void>((resolve) => {
      resumeAdd = resolve;
    });
    runtime.routes.add = async (session, input) => {
      const route = await originalAdd(session, input);
      routeAdded();
      await resumeRouteAdd;
      return route;
    };

    const pendingRoute = runtime.addRoute(client, "user-a", {
      machineId: "assigned",
      remotePort: 3000,
      path: "/project",
    });
    await routeWasAdded;
    await runtime.unassignMachine(client, "user-a", "assigned");
    resumeAdd();

    await assert.rejects(pendingRoute, /not assigned to the current user|operation was revoked/);
    assert.deepEqual(runtime.routeList("user-a"), []);
    await runtime.close();
  });
});
