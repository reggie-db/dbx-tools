import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/appkit";
import { resolveSshPluginConfig } from "../src/config.ts";
import {
  createManagedSandboxName,
  parseManagedSandboxName,
  sandboxUserId,
} from "../src/managed-name.ts";
import {
  LakebaseMachineOwnershipStore,
  type MachineAssignment,
  type NewMachineAssignment,
} from "../src/ownership.ts";
import { SshRuntime } from "../src/runtime.ts";
import type { SandboxEntry } from "../src/rest.ts";
import type { SshSession } from "../src/session.ts";

const unusedSession = {
  close: () => undefined,
  forwardOut: async () => assert.fail("not used"),
} as unknown as SshSession;

class MemoryOwnershipStore {
  readonly assignments: MachineAssignment[] = [];

  async listAssignments(workspaceScope: string, userId?: string): Promise<MachineAssignment[]> {
    return this.assignments.filter(
      (assignment) =>
        assignment.workspaceScope === workspaceScope &&
        (userId === undefined || assignment.userId === userId),
    );
  }

  async get(
    workspaceScope: string,
    userId: string,
    machineId: string,
  ): Promise<MachineAssignment | undefined> {
    return this.assignments.find(
      (assignment) =>
        assignment.workspaceScope === workspaceScope &&
        assignment.userId === userId &&
        assignment.machineId === machineId,
    );
  }

  async assign(input: NewMachineAssignment): Promise<void> {
    await this.unassign(input.workspaceScope, input.userId, input.machineId);
    this.assignments.push({ ...input, createdAt: new Date().toISOString() });
  }

  async unassign(workspaceScope: string, userId: string, machineId: string): Promise<boolean> {
    const index = this.assignments.findIndex(
      (assignment) =>
        assignment.workspaceScope === workspaceScope &&
        assignment.userId === userId &&
        assignment.machineId === machineId,
    );
    if (index < 0) return false;
    this.assignments.splice(index, 1);
    return true;
  }

  async unassignAll(workspaceScope: string, machineId: string): Promise<number> {
    const retained = this.assignments.filter(
      (assignment) =>
        assignment.workspaceScope !== workspaceScope || assignment.machineId !== machineId,
    );
    const removed = this.assignments.length - retained.length;
    this.assignments.splice(0, this.assignments.length, ...retained);
    return removed;
  }

  async withReaperLock<T>(_workspaceScope: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  async close(): Promise<void> {}
}

function assignment(
  userId: string,
  machineId: string,
  managedName: string,
  expiresAtMs: number,
): MachineAssignment {
  return {
    workspaceScope: "workspace",
    userId,
    machineId,
    managedName,
    expiresAt: new Date(expiresAtMs).toISOString(),
    createdAt: new Date(0).toISOString(),
  };
}

function sandboxClient(initial: SandboxEntry[]) {
  const entries = new Map(initial.map((entry) => [entry.sandboxId, entry]));
  const requests: Array<Record<string, unknown>> = [];
  const client = {
    config: { workspaceId: "workspace", host: "https://example.databricks.com" },
    apiClient: {
      request: async (request: Record<string, unknown>) => {
        requests.push(request);
        const path = String(request.path);
        const method = String(request.method);
        if (path.endsWith("/sandboxes") && method === "GET") {
          return { sandboxes: [...entries.values()] };
        }
        if (path.endsWith("/sandboxes") && method === "POST") {
          const name = (request.payload as { sandbox: { name: string } }).sandbox.name;
          const entry = { sandboxId: `created-${entries.size + 1}`, status: "STOPPED", name };
          entries.set(entry.sandboxId, entry);
          return entry;
        }
        const match = path.match(/\/sandboxes\/([^/]+)(?:\/(start|stop))?$/);
        if (!match) throw new Error(`Unexpected Sandbox request ${method} ${path}`);
        const machineId = decodeURIComponent(match[1]!);
        const action = match[2];
        const current = entries.get(machineId);
        if (method === "DELETE") {
          entries.delete(machineId);
          return {};
        }
        if (!current) throw Object.assign(new Error("missing"), { status: 404 });
        if (method === "POST" && action) {
          const updated = {
            ...current,
            status: action === "start" ? "RUNNING" : "STOPPED",
          };
          entries.set(machineId, updated);
          return updated;
        }
        return current;
      },
    },
  } as unknown as WorkspaceClient;
  return { client, entries, requests };
}

function runtime(
  store: MemoryOwnershipStore,
  config: Parameters<typeof resolveSshPluginConfig>[0] = {},
) {
  return new SshRuntime(
    resolveSshPluginConfig(config),
    store as unknown as LakebaseMachineOwnershipStore,
  );
}

describe("managed Sandbox ownership", () => {
  it("encodes a fun name, stable user identity, and expiration", () => {
    const expiresAtMs = 1_800_000_000_000;
    const name = createManagedSandboxName("user@example.com", expiresAtMs, "00112233");
    const parsed = parseManagedSandboxName(name);

    assert.equal(
      name,
      `dbx-bright-falcon-00112233_uid_${sandboxUserId("user@example.com")}_exp_1800000000000`,
    );
    assert.deepEqual(parsed, {
      displayName: "bright-falcon-00112233",
      ownerId: sandboxUserId("user@example.com"),
      expiresAtMs,
    });
  });

  it("migrates Lakebase ownership rows with managed names and expirations", async () => {
    const statements: string[] = [];
    const pool = {
      connect: async () => ({
        query: async (text: string) => {
          statements.push(text);
          if (text.includes("pg_advisory_unlock")) {
            return { rows: [{ unlocked: true }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
      }),
      query: async (text: string) => {
        statements.push(text);
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Parameters<typeof LakebaseMachineOwnershipStore.create>[0];

    await LakebaseMachineOwnershipStore.create(pool);

    assert.ok(statements.some((statement) => statement.includes("managed_name TEXT")));
    assert.ok(statements.some((statement) => statement.includes("expires_at TIMESTAMPTZ")));
    assert.ok(statements.some((statement) => statement.includes("machine_assignments_expiry_idx")));
  });

  it("creates generated names and persists ownership in Lakebase", async () => {
    const store = new MemoryOwnershipStore();
    const { client, requests } = sandboxClient([]);
    const ssh = runtime(store, { sandboxLifetimeSeconds: 3_600 });

    const created = await ssh.createMachine(client, "user-a");
    const row = store.assignments[0]!;
    const payloadName = (requests[0]?.payload as { sandbox: { name: string } }).sandbox.name;

    assert.equal(row.machineId, created.id);
    assert.equal(row.userId, "user-a");
    assert.equal(row.managedName, payloadName);
    assert.equal(created.name, parseManagedSandboxName(payloadName)?.displayName);
    assert.equal(created.expiresAt, row.expiresAt);
    assert.ok(Date.parse(created.expiresAt) > Date.now());
  });

  it("filters discovery and lifecycle operations through Lakebase ownership", async () => {
    const now = Date.now();
    const ownedName = createManagedSandboxName("user-a", now + 60_000, "00112233");
    const otherName = createManagedSandboxName("user-b", now + 60_000, "44556677");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "owned", ownedName, now + 60_000));
    store.assignments.push(assignment("user-b", "other", otherName, now + 60_000));
    const { client } = sandboxClient([
      { sandboxId: "owned", status: "STOPPED", name: ownedName },
      { sandboxId: "other", status: "STOPPED", name: otherName },
    ]);
    const ssh = runtime(store);

    assert.deepEqual(
      (await ssh.listMachines(client, "user-a")).machines.map((machine) => machine.id),
      ["owned"],
    );
    await assert.rejects(ssh.startMachine(client, "user-a", "other"), /not assigned/);
    await assert.rejects(ssh.startMachine(client, "user-b", "owned"), /not assigned/);
  });

  it("reaps expired, malformed, orphaned, and missing managed records", async () => {
    const now = Date.now();
    const expiredName = createManagedSandboxName("user-a", now - 1_000, "00112233");
    const orphanName = createManagedSandboxName("user-c", now + 60_000, "44556677");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "expired", expiredName, now - 1_000));
    store.assignments.push(assignment("user-b", "legacy", "legacy-name", now + 60_000));
    store.assignments.push(assignment("user-d", "missing", "missing-name", now + 60_000));
    const { client, entries } = sandboxClient([
      { sandboxId: "expired", status: "STOPPED", name: expiredName },
      { sandboxId: "legacy", status: "STOPPED", name: "legacy-name" },
      { sandboxId: "orphan", status: "STOPPED", name: orphanName },
      { sandboxId: "foreign", status: "STOPPED", name: "manual-sandbox" },
      { sandboxId: "marker-foreign", status: "STOPPED", name: "manual_uid_name_exp_123" },
    ]);
    const ssh = runtime(store);

    const result = await ssh.reapMachines(client);

    assert.deepEqual(result, { scanned: 5, deleted: 3, removedAssignments: 3, failures: 0 });
    assert.deepEqual([...entries.keys()], ["foreign", "marker-foreign"]);
    assert.deepEqual(store.assignments, []);
  });

  it("removes a route created concurrently with expiration reaping", async () => {
    const now = Date.now();
    const futureName = createManagedSandboxName("user-a", now + 60_000, "00112233");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "owned", futureName, now + 60_000));
    const { client, entries } = sandboxClient([
      { sandboxId: "owned", status: "RUNNING", name: futureName },
    ]);
    const ssh = runtime(store);
    Object.defineProperty(ssh, "ensureSession", { value: async () => unusedSession });
    const originalAdd = ssh.routes.add.bind(ssh.routes);
    let routeAdded!: () => void;
    let resumeAdd!: () => void;
    const routeWasAdded = new Promise<void>((resolve) => {
      routeAdded = resolve;
    });
    const resumeRouteAdd = new Promise<void>((resolve) => {
      resumeAdd = resolve;
    });
    ssh.routes.add = async (session, input) => {
      const route = await originalAdd(session, input);
      routeAdded();
      await resumeRouteAdd;
      return route;
    };

    const pendingRoute = ssh.addRoute(client, "user-a", {
      machineId: "owned",
      remotePort: 3000,
      path: "/project",
    });
    await routeWasAdded;
    const expiredAt = now - 1_000;
    const expiredName = createManagedSandboxName("user-a", expiredAt, "00112233");
    store.assignments[0] = assignment("user-a", "owned", expiredName, expiredAt);
    entries.set("owned", { sandboxId: "owned", status: "RUNNING", name: expiredName });
    await ssh.reapMachines(client);
    resumeAdd();

    await assert.rejects(pendingRoute, /not assigned|operation was revoked/);
    assert.deepEqual(ssh.routeList("user-a"), []);
  });
});
