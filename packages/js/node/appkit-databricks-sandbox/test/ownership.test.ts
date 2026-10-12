import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/appkit";
import { resolveSshPluginConfig } from "../src/config.ts";
import { DiskMachineOwnershipStore, LakebaseMachineOwnershipStore } from "../src/ownership.ts";
import { SshRuntime } from "../src/runtime.ts";

const temporaryDirectories: string[] = [];

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
      query: async () => ({ rows: [], rowCount: 0 }),
    } as unknown as Parameters<typeof LakebaseMachineOwnershipStore.create>[0];

    await LakebaseMachineOwnershipStore.create(pool);

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
        path: "/sandbox/assigned/terminal",
        state: "stopped",
      },
      {
        kind: "stats",
        path: "/sandbox/assigned/stats",
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
    const runtime = new SshRuntime(resolveSshPluginConfig({ ownershipPath: path }));

    const created = await runtime.createMachine(client, "user-a", { name: "project" });
    await assert.rejects(
      runtime.deleteMachine(client, "user-b", created.id),
      /not assigned to the current user/,
    );
    assert.deepEqual(await runtime.deleteMachine(client, "user-a", created.id), {
      deleted: true,
    });

    assert.equal(created.id, "created");
    assert.deepEqual(requests[0]?.payload, { sandbox: { name: "project" } });
    assert.equal(requests.at(-1)?.method, "DELETE");
    await runtime.close();
  });
});
