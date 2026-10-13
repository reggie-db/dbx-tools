import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/appkit";
import { completedSshCommand } from "./ssh-command.ts";
import { resolveSshPluginConfig } from "../src/config.ts";
import { createSandboxName, sandboxDisplayName } from "../src/managed-name.ts";
import {
  LakebaseMachineOwnershipStore,
  OWNERSHIP_SCHEMA_PREFIX,
  ownershipSchemaName,
  type MachineAssignment,
  type MachineServiceProjectRecord,
  type NewMachineAssignment,
  type NewMachineServiceProjectRecord,
  type NewSandboxProjectRecord,
  type SandboxProjectRecord,
} from "../src/ownership.ts";
import type { SandboxEntry } from "../src/rest.ts";
import { SshRuntime } from "../src/runtime.ts";
import { SshCommand, type SshSession } from "../src/session.ts";

const unusedSession = {
  close: () => undefined,
  execute: (command: string, args: string[]) => completedSshCommand(command, args),
  executePrivileged: (command: string, args: string[]) => completedSshCommand(command, args),
  forwardOut: async () => assert.fail("not used"),
} as unknown as SshSession;

class MemoryOwnershipStore {
  readonly assignments: MachineAssignment[] = [];
  readonly projects: SandboxProjectRecord[] = [];
  readonly serviceProjects: MachineServiceProjectRecord[] = [];
  serviceLockCount = 0;

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

  async getByMachine(
    workspaceScope: string,
    machineId: string,
  ): Promise<MachineAssignment | undefined> {
    return this.assignments.find(
      (assignment) =>
        assignment.workspaceScope === workspaceScope && assignment.machineId === machineId,
    );
  }

  async assign(input: NewMachineAssignment): Promise<void> {
    const owner = await this.getByMachine(input.workspaceScope, input.machineId);
    if (owner && owner.userId !== input.userId) {
      throw new Error(`SSH machine ${input.machineId} is already assigned to another user`);
    }
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

  async listProjects(
    workspaceScope: string,
    filters: { userId?: string; machineId?: string } = {},
  ): Promise<SandboxProjectRecord[]> {
    return this.projects.filter(
      (project) =>
        project.workspaceScope === workspaceScope &&
        (filters.userId === undefined || project.userId === filters.userId) &&
        (filters.machineId === undefined || project.machineId === filters.machineId),
    );
  }

  async getProject(
    workspaceScope: string,
    userId: string,
    projectId: string,
  ): Promise<SandboxProjectRecord | undefined> {
    return this.projects.find(
      (project) =>
        project.workspaceScope === workspaceScope &&
        project.userId === userId &&
        project.projectId === projectId,
    );
  }

  async getProjectByName(
    workspaceScope: string,
    userId: string,
    machineId: string,
    name: string,
  ): Promise<SandboxProjectRecord | undefined> {
    return this.projects.find(
      (project) =>
        project.workspaceScope === workspaceScope &&
        project.userId === userId &&
        project.machineId === machineId &&
        project.name === name,
    );
  }

  async upsertProject(input: NewSandboxProjectRecord): Promise<void> {
    const existing = this.projects.findIndex(
      (project) =>
        project.workspaceScope === input.workspaceScope &&
        project.userId === input.userId &&
        project.projectId === input.projectId,
    );
    const now = new Date().toISOString();
    const record = {
      ...input,
      route: input.route ?? true,
      serviceDependencies: input.serviceDependencies ?? [],
      createdAt: existing >= 0 ? this.projects[existing]!.createdAt : now,
      updatedAt: now,
    };
    if (existing >= 0) this.projects.splice(existing, 1, record);
    else this.projects.push(record);
  }

  async deleteProject(workspaceScope: string, userId: string, projectId: string): Promise<boolean> {
    const index = this.projects.findIndex(
      (project) =>
        project.workspaceScope === workspaceScope &&
        project.userId === userId &&
        project.projectId === projectId,
    );
    if (index < 0) return false;
    this.projects.splice(index, 1);
    return true;
  }

  async deleteProjectsForMachine(workspaceScope: string, machineId: string): Promise<number> {
    const retained = this.projects.filter(
      (project) => project.workspaceScope !== workspaceScope || project.machineId !== machineId,
    );
    const removed = this.projects.length - retained.length;
    this.projects.splice(0, this.projects.length, ...retained);
    return removed;
  }

  async deleteProjectsForOwnerMachine(
    workspaceScope: string,
    userId: string,
    machineId: string,
  ): Promise<number> {
    const retained = this.projects.filter(
      (project) =>
        project.workspaceScope !== workspaceScope ||
        project.userId !== userId ||
        project.machineId !== machineId,
    );
    const removed = this.projects.length - retained.length;
    this.projects.splice(0, this.projects.length, ...retained);
    return removed;
  }

  async listMachineServiceProjects(
    workspaceScope: string,
    machineId?: string,
  ): Promise<MachineServiceProjectRecord[]> {
    return this.serviceProjects.filter(
      (project) =>
        project.workspaceScope === workspaceScope &&
        (machineId === undefined || project.machineId === machineId),
    );
  }

  async getMachineServiceProject(
    workspaceScope: string,
    machineId: string,
    serviceKind: MachineServiceProjectRecord["serviceKind"],
  ): Promise<MachineServiceProjectRecord | undefined> {
    return this.serviceProjects.find(
      (project) =>
        project.workspaceScope === workspaceScope &&
        project.machineId === machineId &&
        project.serviceKind === serviceKind,
    );
  }

  async upsertMachineServiceProject(input: NewMachineServiceProjectRecord): Promise<void> {
    const existing = this.serviceProjects.findIndex(
      (project) =>
        project.workspaceScope === input.workspaceScope &&
        project.machineId === input.machineId &&
        project.serviceKind === input.serviceKind,
    );
    const now = new Date().toISOString();
    const record = {
      ...input,
      createdAt: existing >= 0 ? this.serviceProjects[existing]!.createdAt : now,
      updatedAt: now,
    };
    if (existing >= 0) this.serviceProjects.splice(existing, 1, record);
    else this.serviceProjects.push(record);
  }

  async deleteMachineServiceProject(
    workspaceScope: string,
    machineId: string,
    serviceKind: MachineServiceProjectRecord["serviceKind"],
  ): Promise<boolean> {
    const index = this.serviceProjects.findIndex(
      (project) =>
        project.workspaceScope === workspaceScope &&
        project.machineId === machineId &&
        project.serviceKind === serviceKind,
    );
    if (index < 0) return false;
    this.serviceProjects.splice(index, 1);
    return true;
  }

  async deleteMachineServiceProjectsForMachine(
    workspaceScope: string,
    machineId: string,
  ): Promise<number> {
    const retained = this.serviceProjects.filter(
      (project) => project.workspaceScope !== workspaceScope || project.machineId !== machineId,
    );
    const removed = this.serviceProjects.length - retained.length;
    this.serviceProjects.splice(0, this.serviceProjects.length, ...retained);
    return removed;
  }

  async withMachineServiceProjectLock<T>(
    _workspaceScope: string,
    _machineId: string,
    _serviceKind: MachineServiceProjectRecord["serviceKind"],
    operation: () => Promise<T>,
  ): Promise<T> {
    this.serviceLockCount += 1;
    return operation();
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

function sandboxClient(initial: SandboxEntry[], transitions: Record<string, SandboxEntry[]> = {}) {
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
        const transition = transitions[machineId]?.shift();
        if (transition) entries.set(machineId, transition);
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

interface SessionRuntimeInternals {
  ensureSession(
    client: WorkspaceClient,
    userId: string,
    machine: SandboxEntry,
    epoch: { machine: number; owner: number },
  ): Promise<SshSession>;
  createSession(): Promise<SshSession>;
}

const CONNECTING_ROLE = "app-sp";
const OWNERSHIP_SCHEMA = ownershipSchemaName(CONNECTING_ROLE);

function ownershipPool(
  queryImpl?: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>,
): Parameters<typeof LakebaseMachineOwnershipStore.create>[0] {
  const query = async (text: string, values?: unknown[]) => {
    if (text.includes("current_user")) {
      return { rows: [{ role: CONNECTING_ROLE }], rowCount: 1 };
    }
    if (text.includes("pg_advisory_unlock")) {
      return { rows: [{ unlocked: true }], rowCount: 1 };
    }
    return queryImpl ? queryImpl(text, values) : { rows: [], rowCount: 0 };
  };
  return {
    connect: async () => ({ query, release: () => undefined }),
    query,
  } as unknown as Parameters<typeof LakebaseMachineOwnershipStore.create>[0];
}

describe("managed Sandbox ownership", () => {
  it("appends the connecting Lakebase role hash to the existing schema name", () => {
    assert.equal(OWNERSHIP_SCHEMA.startsWith(`${OWNERSHIP_SCHEMA_PREFIX}_`), true);
    assert.notEqual(ownershipSchemaName("user@example.com"), ownershipSchemaName("app-sp"));
  });

  it("generates a display name without encoding owner or expiration", () => {
    const name = createSandboxName("00112233");
    assert.equal(name, "dbx-bright-falcon-00112233");
    assert.equal(sandboxDisplayName(name), "bright-falcon-00112233");
    assert.equal(
      sandboxDisplayName(
        "dbx-calm-falcon-d472ea63_uid_6XThSiNANaqfSm4_ZxQU1aBBJMsM_N5DqMREyrWvEVM_exp_1791924464757",
      ),
      "calm-falcon-d472ea63",
    );
  });

  it("migrates Lakebase ownership rows with managed names and expirations", async () => {
    const statements: string[] = [];
    const pool = ownershipPool(async (text) => {
      statements.push(text);
      return { rows: [], rowCount: 0 };
    });

    const store = await LakebaseMachineOwnershipStore.create(pool);

    assert.equal(store.schema, OWNERSHIP_SCHEMA);
    assert.ok(statements.some((statement) => statement.includes(`"${OWNERSHIP_SCHEMA}"`)));
    assert.ok(statements.some((statement) => statement.includes("managed_name TEXT")));
    assert.ok(statements.some((statement) => statement.includes("expires_at TIMESTAMPTZ")));
    assert.ok(statements.some((statement) => statement.includes("machine_assignments_expiry_idx")));
    assert.ok(
      statements.some((statement) => statement.includes(`"${OWNERSHIP_SCHEMA}"."projects"`)),
    );
    assert.ok(statements.some((statement) => statement.includes("open_path TEXT")));
    assert.ok(statements.some((statement) => statement.includes("project_config JSONB")));
    assert.ok(statements.some((statement) => statement.includes("route_enabled BOOLEAN")));
    assert.ok(statements.some((statement) => statement.includes("service_dependencies JSONB")));
    assert.ok(statements.some((statement) => statement.includes("sandbox_projects_machine_idx")));
    assert.ok(
      statements.some((statement) => statement.includes("sandbox_projects_machine_port_idx")),
    );
    assert.ok(
      statements.some((statement) =>
        statement.includes(`"${OWNERSHIP_SCHEMA}"."machine_service_projects"`),
      ),
    );
    assert.ok(statements.some((statement) => statement.includes("definition_version INTEGER")));
    assert.ok(
      statements.some((statement) => statement.includes("machine_service_projects_machine_idx")),
    );
  });

  it("copies legacy unhashed ownership tables into the hashed role schema", async () => {
    const statements: string[] = [];
    const pool = ownershipPool(async (text) => {
      statements.push(text);
      if (text.includes("information_schema.tables")) {
        return {
          rows: [
            { table_name: "machine_assignments" },
            { table_name: "projects" },
            { table_name: "machine_service_projects" },
          ],
          rowCount: 3,
        };
      }
      if (text.includes("INSERT INTO") && text.includes("ON CONFLICT DO NOTHING")) {
        return { rows: [], rowCount: 2 };
      }
      return { rows: [], rowCount: 0 };
    });

    await LakebaseMachineOwnershipStore.create(pool);

    const quotedLegacy = `"${OWNERSHIP_SCHEMA_PREFIX}"`;
    assert.ok(
      statements.some(
        (statement) =>
          statement.includes(`INSERT INTO "${OWNERSHIP_SCHEMA}"."machine_assignments"`) &&
          statement.includes(`FROM ${quotedLegacy}.machine_assignments`),
      ),
    );
    assert.ok(
      statements.some(
        (statement) =>
          statement.includes(`INSERT INTO "${OWNERSHIP_SCHEMA}"."projects"`) &&
          statement.includes(`FROM ${quotedLegacy}.projects`),
      ),
    );
    assert.ok(
      statements.some(
        (statement) =>
          statement.includes(`INSERT INTO "${OWNERSHIP_SCHEMA}"."machine_service_projects"`) &&
          statement.includes(`FROM ${quotedLegacy}.machine_service_projects`),
      ),
    );
    assert.ok(
      statements.some(
        (statement) =>
          statement.includes("DELETE FROM") &&
          statement.includes("(winner.created_at, winner.user_id) <"),
      ),
    );
    assert.ok(
      statements.some((statement) => statement.includes("machine_assignments_machine_owner_idx")),
    );
  });

  it("writes, reads, and deletes persisted project records", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const row = {
      workspace_scope: "workspace",
      user_id: "user-a",
      project_id: "project-1",
      project_name: "demo",
      machine_id: "machine-1",
      directory_path: "/home/sandbox-user/projects/demo",
      project_path: "demo",
      route_path: "/sandbox/hash/demo",
      open_path: "open.html",
      port: 8080,
      project_config: { tools: { node: "lts" } },
      route_enabled: true,
      service_dependencies: { 0: "desktop" },
      strip_prefix: true,
      created_at: new Date("2026-10-12T10:00:00.000Z"),
      updated_at: new Date("2026-10-12T10:01:00.000Z"),
    };
    const pool = ownershipPool(async (text, values) => {
      queries.push({ text, values });
      if (
        text.includes("SELECT workspace_scope") &&
        text.includes(`"${OWNERSHIP_SCHEMA}"."projects"`)
      ) {
        return { rows: [row], rowCount: 1 };
      }
      if (text.includes(`DELETE FROM "${OWNERSHIP_SCHEMA}"."projects"`)) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const store = await LakebaseMachineOwnershipStore.create(pool);

    await store.upsertProject({
      workspaceScope: "workspace",
      userId: "user-a",
      projectId: "project-1",
      name: "demo",
      machineId: "machine-1",
      directory: "/home/sandbox-user/projects/demo",
      projectPath: "demo",
      path: "/sandbox/hash/demo",
      openPath: "open.html",
      port: 8080,
      config: { tools: { node: "lts" } },
      stripPrefix: true,
    });
    const projects = await store.listProjects("workspace", {
      userId: "user-a",
      machineId: "machine-1",
    });

    assert.equal(projects[0]?.projectId, "project-1");
    assert.equal(projects[0]?.openPath, "open.html");
    assert.deepEqual(projects[0]?.serviceDependencies, ["desktop"]);
    assert.equal(await store.deleteProject("workspace", "user-a", "project-1"), true);
    assert.ok(
      queries.some(({ text }) => text.includes(`INSERT INTO "${OWNERSHIP_SCHEMA}"."projects"`)),
    );
    assert.ok(queries.some(({ text }) => text.includes("updated_at = now()")));
    assert.ok(queries.some(({ values }) => values?.includes("[]")));
  });

  it("writes, reads, locks, and deletes machine-owned service projects", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const row = {
      workspace_scope: "workspace",
      machine_id: "machine-1",
      service_kind: "desktop",
      definition_version: 2,
      directory_path: "~/.dbx-tools/services/desktop",
      route_path: "/sandbox/desktop/machine-1",
      open_path: "vnc.html?autoconnect=1",
      port: 8443,
      project_config: { tasks: { start: { run: "start-desktop" } } },
      strip_prefix: true,
      created_at: new Date("2026-10-12T10:00:00.000Z"),
      updated_at: new Date("2026-10-12T10:01:00.000Z"),
    };
    const pool = ownershipPool(async (text, values) => {
      queries.push({ text, values });
      if (
        text.includes("SELECT workspace_scope") &&
        text.includes(`"${OWNERSHIP_SCHEMA}"."machine_service_projects"`)
      ) {
        return { rows: [row], rowCount: 1 };
      }
      if (text.includes(`DELETE FROM "${OWNERSHIP_SCHEMA}"."machine_service_projects"`)) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const store = await LakebaseMachineOwnershipStore.create(pool);
    const input: NewMachineServiceProjectRecord = {
      workspaceScope: "workspace",
      machineId: "machine-1",
      serviceKind: "desktop",
      definitionVersion: 2,
      directory: "~/.dbx-tools/services/desktop",
      path: "/sandbox/desktop/machine-1",
      openPath: "vnc.html?autoconnect=1",
      port: 8443,
      config: { tasks: { start: { run: "start-desktop" } } },
      stripPrefix: true,
    };

    await store.upsertMachineServiceProject(input);
    const project = await store.getMachineServiceProject("workspace", "machine-1", "desktop");
    const listed = await store.listMachineServiceProjects("workspace", "machine-1");
    const locked = await store.withMachineServiceProjectLock(
      "workspace",
      "machine-1",
      "desktop",
      async () => "locked",
    );

    assert.equal(project?.definitionVersion, 2);
    assert.equal(project?.serviceKind, "desktop");
    assert.deepEqual(listed, [project] as MachineServiceProjectRecord[]);
    assert.equal(locked, "locked");
    assert.equal(
      await store.deleteMachineServiceProject("workspace", "machine-1", "desktop"),
      true,
    );
    assert.equal(await store.deleteMachineServiceProjectsForMachine("workspace", "machine-1"), 1);
    assert.ok(
      queries.some(
        ({ text, values }) =>
          text.includes(`INSERT INTO "${OWNERSHIP_SCHEMA}"."machine_service_projects"`) &&
          values?.[2] === "desktop",
      ),
    );
    assert.ok(
      queries.some(
        ({ text }) => text.includes("pg_advisory_lock") && !text.includes("pg_advisory_unlock"),
      ),
    );
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
    assert.equal(created.name, sandboxDisplayName(payloadName));
    assert.doesNotMatch(payloadName, /_uid_|_exp_/);
    assert.equal(created.expiresAt, row.expiresAt);
    assert.ok(Date.parse(created.expiresAt) > Date.now());
  });

  it("filters discovery and lifecycle operations through Lakebase ownership", async () => {
    const now = Date.now();
    const ownedName = createSandboxName("00112233");
    const otherName = createSandboxName("44556677");
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

  it("rejects a second owner for one assigned Sandbox", async () => {
    const now = Date.now();
    const expiresAtMs = now + 60_000;
    const managedName = createSandboxName("00112233");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("platform-user", "owned", managedName, expiresAtMs));

    await assert.rejects(
      store.assign({
        workspaceScope: "workspace",
        userId: "user@example.com",
        machineId: "owned",
        managedName,
        expiresAt: new Date(expiresAtMs).toISOString(),
      }),
      /already assigned/,
    );
    assert.equal(store.assignments.length, 1);
  });

  it("recovers built-in service state and logs after a runtime restart", async () => {
    const managedName = createSandboxName("00112233");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "owned", managedName, Date.now() + 60_000));
    const { client } = sandboxClient([
      {
        sandboxId: "owned",
        status: "RUNNING",
        name: managedName,
        gatewayHost: "gateway.example",
      },
    ]);
    const ssh = runtime(store);
    const session = {
      ...unusedSession,
      execute: (command: string, args: string[]) =>
        completedSshCommand(command, args, {
          stdout:
            "service\tterminal\tstarting\nservice-log\tterminal\taW5zdGFsbGluZyB0dHlkCg==\nservice\tdesktop\tstopped\nservice\tstats\tstopped\n",
        }),
    } as unknown as SshSession;
    Object.defineProperty(ssh, "ensureSession", { value: async () => session });

    const listed = await ssh.listMachines(client, "user-a");
    const terminal = listed.machines[0]?.services.find((service) => service.kind === "terminal");

    assert.equal(terminal?.state, "starting");
    assert.equal(terminal?.openUrl, "/sandbox/terminal/owned/");
    assert.equal(terminal?.log, "installing ttyd\n");
  });

  it("removes an expired sole owner and deletes its machine and projects", async () => {
    const now = Date.now();
    const managedName = createSandboxName("00112233");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("expired-user", "owned", managedName, now - 1_000));
    await store.upsertProject({
      workspaceScope: "workspace",
      userId: "expired-user",
      projectId: "expired-project",
      name: "expired-project",
      machineId: "owned",
      directory: "/home/sandbox-user/projects/expired-project",
      projectPath: "expired-project",
      path: "/sandbox/expired/project",
      port: 8_080,
      config: {},
      stripPrefix: true,
    });
    const { client, entries } = sandboxClient([
      { sandboxId: "owned", status: "RUNNING", name: managedName },
    ]);
    const ssh = runtime(store);
    Object.defineProperty(ssh, "ensureSession", { value: async () => unusedSession });

    assert.deepEqual(await ssh.reapMachines(client), {
      scanned: 1,
      deleted: 1,
      removedAssignments: 1,
      failures: 0,
    });
    assert.deepEqual([...entries.keys()], []);
    assert.deepEqual(store.assignments, []);
    assert.deepEqual(store.projects, []);
  });

  it("persists hidden service projects for the sole machine owner", async () => {
    const now = Date.now();
    const managedName = createSandboxName("00112233");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "owned", managedName, now + 60_000));
    const { client } = sandboxClient([
      {
        sandboxId: "owned",
        status: "RUNNING",
        name: managedName,
        gatewayHost: "gateway.example",
      },
    ]);
    const ssh = runtime(store, { machineSoftware: [] });
    const setupCommands: string[] = [];
    let operationLog = "";
    let releaseFirstSetup: (() => void) | undefined;
    const firstSetup = new Promise<void>((resolve) => {
      releaseFirstSetup = resolve;
    });
    const session = {
      ...unusedSession,
      execute: (command: string, args: string[]) =>
        new SshCommand(command, args, { timeoutMs: 1_000 }, async (execution) => {
          const script = args[1] ?? "";
          if (script.includes("/lifecycle.log") && script.includes("tail -n")) {
            execution.stdout(operationLog);
            return 0;
          }
          if (!script.endsWith("'start' 'true'")) return 0;
          setupCommands.push(script);
          if (setupCommands.length === 1) await firstSetup;
          return 0;
        }),
    } as unknown as SshSession;
    Object.defineProperty(ssh, "ensureSession", { value: async () => session });

    const observation = await ssh.observeService(client, "user-a", {
      machineId: "owned",
      service: "desktop",
    });
    const iterator = observation[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value?.state, "starting");
    operationLog = "__DBX_TOOLS_ATTEMPT__=1\ninstalling desktop\n";
    const output = await iterator.next();
    assert.equal(output.value?.state, "starting");
    assert.equal(output.value?.log, operationLog);
    releaseFirstSetup?.();
    const settled = await iterator.next();
    assert.equal(settled.value?.state, "ready");
    assert.equal((await iterator.next()).done, true);
    const repeated = await ssh.startService(client, "user-a", {
      machineId: "owned",
      service: "desktop",
    });

    assert.equal(repeated.state, "ready");
    assert.equal(store.serviceLockCount, 1);
    assert.equal(setupCommands.length, 1);
    assert.match(setupCommands[0] ?? "", /'start' 'true'$/);
    assert.equal(store.serviceProjects.length, 1);
    assert.equal(store.serviceProjects[0]?.definitionVersion, 13);
    assert.equal(
      store.serviceProjects[0]?.directory,
      "/home/sandbox-user/projects/.sandbox-services/desktop",
    );
    assert.deepEqual(
      ssh.routes.list("owned", "user-a", { includeInternal: true }).map((route) => route.path),
      ["/sandbox/desktop/owned"],
    );
    await ssh.close();
  });

  it("retains a successful SSH connection after its connect promise settles", async () => {
    const now = Date.now();
    const managedName = createSandboxName("00112233");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "owned", managedName, now + 60_000));
    const { client } = sandboxClient([]);
    const ssh = runtime(store);
    let closeCount = 0;
    const session = {
      close: () => {
        closeCount += 1;
      },
    } as unknown as SshSession;
    const internals = ssh as unknown as SessionRuntimeInternals;
    internals.createSession = async () => session;

    const connected = await internals.ensureSession(
      client,
      "user-a",
      { sandboxId: "owned", status: "RUNNING", name: managedName },
      { machine: 0, owner: 0 },
    );

    assert.equal(connected, session);
    assert.equal(closeCount, 0);
    await ssh.close();
    assert.equal(closeCount, 1);
  });

  it("does not wait for high-level restore work during shutdown", async () => {
    const ssh = runtime(new MemoryOwnershipStore());
    const never = new Promise<void>(() => undefined);
    (ssh as unknown as { machineSetup: Map<string, Promise<void>> }).machineSetup.set(
      "pending",
      never,
    );

    await Promise.race([
      ssh.close(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("runtime shutdown blocked")), 100),
      ),
    ]);
  });

  it("returns a live command before runtime session setup completes", async () => {
    const now = Date.now();
    const managedName = createSandboxName("00112233");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "owned", managedName, now + 60_000));
    const { client } = sandboxClient([
      { sandboxId: "owned", status: "RUNNING", name: managedName },
    ]);
    const ssh = runtime(store, { machineSoftware: [] });
    let finishSetup!: () => void;
    const setup = new Promise<void>((resolve) => {
      finishSetup = resolve;
    });
    Object.defineProperty(ssh, "ensureSession", {
      value: async () => {
        await setup;
        return unusedSession;
      },
    });

    const command = ssh.execute(client, "user-a", {
      machineId: "owned",
      command: "echo",
      args: ["ready"],
    });

    assert.ok(command instanceof SshCommand);
    assert.equal(command.exitCode, undefined);
    finishSetup();
    assert.equal(await command, 0);
    await ssh.close();
  });

  it("persists projects, updates open links, and removes only the project directory", async () => {
    const now = Date.now();
    const managedName = createSandboxName("00112233");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "owned", managedName, now + 60_000));
    const { client } = sandboxClient([
      { sandboxId: "owned", status: "RUNNING", name: managedName },
    ]);
    const commands: string[] = [];
    const session = {
      close: () => undefined,
      execute: (command: string, args: string[]) => {
        commands.push(`${command} ${args.join(" ")}`);
        return completedSshCommand(command, args);
      },
      forwardOut: async () => assert.fail("not used"),
    } as unknown as SshSession;
    const ssh = runtime(store, { machineSoftware: [] });
    Object.defineProperty(ssh, "ensureSession", { value: async () => session });

    const created = await ssh.addProject(client, "user-a", {
      machineId: "owned",
      name: "demo",
      port: 8080,
      path: "demo",
      openPath: "open.html",
    });
    const updated = await ssh.addProject(client, "user-a", {
      machineId: "owned",
      name: "demo",
      port: 8081,
      path: "demo",
      openPath: "dashboard.html?mode=full",
    });

    assert.equal(created.directory, "/home/sandbox-user/projects/demo");
    assert.equal(created.openUrl, `${ssh.projectPathPrefix("user-a")}/demo/open.html`);
    assert.equal(updated.id, created.id);
    assert.equal(updated.port, 8081);
    assert.equal(
      updated.openUrl,
      `${ssh.projectPathPrefix("user-a")}/demo/dashboard.html?mode=full`,
    );
    const startedServices: string[] = [];
    Object.defineProperty(ssh, "ensureServiceReady", {
      value: async (_client: WorkspaceClient, _userId: string, input: { service: string }) => {
        startedServices.push(input.service);
        return {
          kind: input.service,
          path: `/sandbox/${input.service}/owned`,
          openUrl: `/sandbox/${input.service}/owned`,
          state: "ready",
        };
      },
    });
    const routeLess = await ssh.addProject(client, "user-a", {
      machineId: "owned",
      projectId: created.id,
      route: false,
      serviceDependencies: ["desktop"],
    });
    assert.equal(routeLess.openUrl, undefined);
    assert.equal(routeLess.state, "ready");
    assert.equal(store.projects[0]?.route, false);
    assert.deepEqual(store.projects[0]?.serviceDependencies, ["desktop"]);
    assert.deepEqual(startedServices, ["desktop"]);
    const retained = await ssh.addProject(client, "user-a", {
      machineId: "owned",
      projectId: created.id,
      config: { env: { MODE: "desktop" } },
    });
    assert.equal(retained.openUrl, undefined);
    assert.equal(store.projects[0]?.route, false);
    assert.equal(store.projects.length, 1);
    assert.equal(await ssh.removeProject(client, "user-a", created.id), true);
    assert.deepEqual(store.projects, []);
    assert.ok(commands.some((command) => command.includes("base64 -d")));
  });

  it("generates project defaults and rejects duplicate machine paths and ports", async () => {
    const now = Date.now();
    const managedName = createSandboxName("00112233");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "owned", managedName, now + 60_000));
    const { client } = sandboxClient([
      { sandboxId: "owned", status: "RUNNING", name: managedName },
    ]);
    const ssh = runtime(store, { machineSoftware: [] });
    Object.defineProperty(ssh, "ensureSession", { value: async () => unusedSession });

    const generated = await ssh.addProject(client, "user-a", { machineId: "owned" });
    assert.match(generated.name, /^project-[a-f0-9]{6}$/);
    assert.equal(generated.directory, `/home/sandbox-user/projects/${generated.name}`);
    assert.equal(generated.path, `${ssh.projectPathPrefix("user-a")}/${generated.name}`);
    assert.ok(generated.port >= 8_000 && generated.port <= 49_151);

    const updated = await ssh.addProject(client, "user-a", {
      machineId: "owned",
      projectId: generated.id,
      openPath: "open.html",
      config: { tools: { node: "lts" } },
    });
    assert.equal(updated.name, generated.name);
    assert.equal(updated.path, generated.path);
    assert.equal(updated.port, generated.port);
    assert.equal(updated.openUrl, `${generated.path}/open.html`);

    const renamed = await ssh.addProject(client, "user-a", {
      machineId: "owned",
      projectId: generated.id,
      name: "renamed-project",
      path: "nested/renamed-project",
      port: 65_000,
      openPath: "",
    });
    assert.equal(renamed.name, "renamed-project");
    assert.equal(renamed.directory, "/home/sandbox-user/projects/nested/renamed-project");
    assert.equal(renamed.path, `${ssh.projectPathPrefix("user-a")}/nested/renamed-project`);
    assert.equal(renamed.openUrl, renamed.path);
    assert.equal(renamed.port, 65_000);

    await assert.rejects(
      ssh.addProject(client, "user-a", {
        machineId: "owned",
        name: "other-path",
        path: "nested/renamed-project",
      }),
      /path .* already in use/,
    );
    await assert.rejects(
      ssh.addProject(client, "user-a", {
        machineId: "owned",
        name: "other-port",
        port: 65_000,
      }),
      /port .* already in use/,
    );
    await assert.rejects(
      ssh.addProject(client, "user-a", {
        machineId: "owned",
        name: "desktop-port",
        port: 6_080,
        route: false,
      }),
      /port .* already in use/,
    );
  });

  it("resets a persisted project and opens its directory in ttyd", async () => {
    const now = Date.now();
    const managedName = createSandboxName("00112233");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "owned", managedName, now + 60_000));
    const { client } = sandboxClient([
      { sandboxId: "owned", status: "RUNNING", name: managedName },
    ]);
    const commands: Array<{ command: string; args: string[] }> = [];
    const session = {
      close: () => undefined,
      execute: (command: string, args: string[]) => {
        commands.push({ command, args });
        return completedSshCommand(command, args, {
          stdout: args[1]?.includes("sh -s -- 'demo' ''")
            ? "__DBX_PROJECT_DIRECTORY__=/home/sandbox-user/projects/demo\n"
            : "",
        });
      },
      forwardOut: async () => assert.fail("not used"),
    } as unknown as SshSession;
    const ssh = runtime(store, { machineSoftware: [] });
    Object.defineProperty(ssh, "ensureSession", { value: async () => session });
    const project = await ssh.addProject(client, "user-a", {
      machineId: "owned",
      name: "demo",
      config: { tools: { node: "lts" } },
    });
    commands.length = 0;

    const reset = await ssh.resetProject(client, "user-a", project.id);

    assert.equal(reset.directory, "/home/sandbox-user/projects/demo");
    assert.equal(reset.state, "ready");
    assert.ok(commands.some(({ args }) => args[1]?.endsWith("sh -s -- 'demo'")));
    assert.ok(commands.some(({ args }) => args[1]?.includes("sh -s -- 'demo' ''")));
    Object.defineProperty(ssh, "startService", {
      value: async () => ({
        kind: "terminal",
        path: "/sandbox/terminal/owned",
        openUrl: "/sandbox/terminal/owned/",
        state: "ready",
      }),
    });

    const terminal = await ssh.openProjectTerminal(client, "user-a", project.id);

    assert.equal(terminal.project.id, project.id);
    assert.equal(terminal.service.kind, "terminal");
    assert.equal(
      terminal.service.openUrl,
      "/sandbox/terminal/owned/?arg=%2Fhome%2Fsandbox-user%2Fprojects%2Fdemo",
    );
  });

  it("preserves projects when a machine stops and deletes records with the machine", async () => {
    const now = Date.now();
    const managedName = createSandboxName("00112233");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "owned", managedName, now + 60_000));
    const first = runtime(store, { machineSoftware: [], reaperIntervalSeconds: 0 });
    await store.upsertProject({
      workspaceScope: "workspace",
      userId: "user-a",
      projectId: "project-1",
      name: "demo",
      machineId: "owned",
      directory: "/home/sandbox-user/projects/demo",
      projectPath: "demo",
      path: `${first.projectPathPrefix("user-a")}/demo`,
      port: 8080,
      config: {},
      stripPrefix: true,
    });
    const { client } = sandboxClient([
      { sandboxId: "owned", status: "RUNNING", name: managedName },
    ]);
    const ssh = runtime(store, { machineSoftware: [] });

    const stopped = await ssh.stopMachine(client, "user-a", "owned");
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.projects.length, 1);
    assert.equal(store.projects.length, 1);

    assert.deepEqual(await ssh.deleteMachine(client, "user-a", "owned"), { deleted: true });
    assert.deepEqual(store.projects, []);
  });

  it("converges lifecycle requests across starting and stopping states", async () => {
    const now = Date.now();
    const managedName = createSandboxName("00112233");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "owned", managedName, now + 60_000));
    const stopping = { sandboxId: "owned", status: "STOPPING", name: managedName };
    const stopped = { ...stopping, status: "STOPPED" };
    const startClient = sandboxClient([stopping], { owned: [stopped] });
    const ssh = runtime(store, { machineSoftware: [] });
    Object.defineProperty(ssh, "startService", {
      value: async (_client: WorkspaceClient, _userId: string, input: { service: string }) => ({
        kind: input.service,
        path: `/sandbox/${input.service}/owned`,
        openUrl: `/sandbox/${input.service}/owned`,
        state: "ready",
      }),
    });

    assert.equal((await ssh.startMachine(startClient.client, "user-a", "owned")).status, "running");
    assert.ok(
      startClient.requests.some((request) => String(request.path).endsWith("/owned/start")),
    );

    const starting = { sandboxId: "owned", status: "STARTING", name: managedName };
    const running = { ...starting, status: "RUNNING" };
    const stopClient = sandboxClient([starting], { owned: [running] });
    assert.equal((await ssh.stopMachine(stopClient.client, "user-a", "owned")).status, "stopped");
    assert.ok(stopClient.requests.some((request) => String(request.path).endsWith("/owned/stop")));

    const stoppingAgain = { sandboxId: "owned", status: "STOPPING", name: managedName };
    const idempotentClient = sandboxClient([stoppingAgain], { owned: [stopped] });
    assert.equal(
      (await ssh.stopMachine(idempotentClient.client, "user-a", "owned")).status,
      "stopped",
    );
    assert.equal(
      idempotentClient.requests.filter((request) => String(request.path).endsWith("/owned/stop"))
        .length,
      0,
    );

    const queuedClient = sandboxClient([
      { sandboxId: "owned", status: "RUNNING", name: managedName },
    ]);
    const stop = ssh.stopMachine(queuedClient.client, "user-a", "owned");
    const restart = ssh.startMachine(queuedClient.client, "user-a", "owned");
    assert.equal((await stop).status, "stopped");
    assert.equal((await restart).status, "running");
    assert.equal(queuedClient.entries.get("owned")?.status, "RUNNING");
  });

  it("restores persisted project and built-in service routes after runtime restarts", async () => {
    const now = Date.now();
    const managedName = createSandboxName("00112233");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "owned", managedName, now + 60_000));
    const first = runtime(store, { machineSoftware: [], reaperIntervalSeconds: 0 });
    await store.upsertProject({
      workspaceScope: "workspace",
      userId: "user-a",
      projectId: "project-1",
      name: "demo",
      machineId: "owned",
      directory: "/home/sandbox-user/projects/demo",
      projectPath: "demo",
      path: `${first.projectPathPrefix("user-a")}/demo`,
      openPath: "open.html",
      port: 8080,
      config: {},
      stripPrefix: true,
    });
    await store.upsertMachineServiceProject({
      workspaceScope: "workspace",
      machineId: "owned",
      serviceKind: "desktop",
      definitionVersion: 11,
      directory: "/home/sandbox-user/projects/.sandbox-services/desktop",
      path: "/sandbox/desktop/owned",
      port: 6080,
      config: {},
      stripPrefix: true,
    });
    const { client } = sandboxClient([
      { sandboxId: "owned", status: "RUNNING", name: managedName },
    ]);
    Object.defineProperty(first, "ensureSession", { value: async () => unusedSession });
    await first.startReaper(client);
    assert.equal(first.routes.list("owned", "user-a").length, 1);
    assert.deepEqual(
      first.routes
        .list("owned", "user-a", { includeInternal: true })
        .map((route) => route.path)
        .sort(),
      ["/sandbox/desktop/owned", `${first.projectPathPrefix("user-a")}/demo`].sort(),
    );
    await first.close();
    assert.equal(store.projects.length, 1);

    const second = runtime(store, { machineSoftware: [], reaperIntervalSeconds: 0 });
    Object.defineProperty(second, "ensureSession", { value: async () => unusedSession });
    await second.startReaper(client);
    assert.equal(second.routes.list("owned", "user-a")[0]?.id, "project-1");
    assert.ok(
      second.routes
        .list("owned", "user-a", { includeInternal: true })
        .some((route) => route.path === "/sandbox/desktop/owned"),
    );
    await second.close();
  });

  it("reaps expired and missing Lakebase assignments without deleting unassigned sandboxes", async () => {
    const now = Date.now();
    const expiredName = createSandboxName("00112233");
    const liveName = createSandboxName("44556677");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "expired", expiredName, now - 1_000));
    store.assignments.push(assignment("user-b", "legacy", "legacy-name", now + 60_000));
    store.assignments.push(assignment("user-d", "missing", "missing-name", now + 60_000));
    const { client, entries } = sandboxClient([
      { sandboxId: "expired", status: "STOPPED", name: expiredName },
      { sandboxId: "legacy", status: "STOPPED", name: "legacy-name" },
      { sandboxId: "orphan", status: "STOPPED", name: liveName },
      { sandboxId: "foreign", status: "STOPPED", name: "manual-sandbox" },
      {
        sandboxId: "marker-foreign",
        status: "STOPPED",
        name: "dbx-calm-falcon-d472ea63_uid_legacy_exp_123",
      },
    ]);
    const ssh = runtime(store);

    const result = await ssh.reapMachines(client);

    assert.deepEqual(result, { scanned: 5, deleted: 1, removedAssignments: 2, failures: 0 });
    assert.deepEqual([...entries.keys()].sort(), ["foreign", "legacy", "marker-foreign", "orphan"]);
    assert.equal(store.assignments.length, 1);
    assert.equal(store.assignments[0]?.machineId, "legacy");
  });

  it("does not delete workspace sandboxes when Lakebase inventory is empty", async () => {
    const liveName = createSandboxName("00112233");
    const store = new MemoryOwnershipStore();
    const { client, entries } = sandboxClient([
      { sandboxId: "live", status: "STOPPED", name: liveName },
      {
        sandboxId: "legacy-named",
        status: "STOPPED",
        name: "dbx-calm-falcon-d472ea63_uid_legacy_exp_1791924464757",
      },
      { sandboxId: "malformed", status: "STOPPED", name: "dbx-not-a-managed-name" },
    ]);
    const ssh = runtime(store);

    const result = await ssh.reapMachines(client);

    assert.deepEqual(result, { scanned: 3, deleted: 0, removedAssignments: 0, failures: 0 });
    assert.deepEqual([...entries.keys()].sort(), ["legacy-named", "live", "malformed"]);
  });

  it("lists Lakebase-owned machines whose Databricks names still have a legacy uid_exp suffix", async () => {
    const now = Date.now();
    const legacyName =
      "dbx-calm-falcon-d472ea63_uid_6XThSiNANaqfSm4_ZxQU1aBBJMsM_N5DqMREyrWvEVM_exp_1791924464757";
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "eclectic-lioness-9811", legacyName, now + 60_000));
    store.projects.push({
      workspaceScope: "workspace",
      userId: "user-a",
      projectId: "6c73da4fc8073da8b58e9c4e08db8104",
      name: "demo",
      machineId: "eclectic-lioness-9811",
      directory: "/home/sandbox-user/projects/demo",
      projectPath: "demo",
      path: "/sandbox/22padc/demo",
      port: 45656,
      config: {},
      stripPrefix: true,
      route: true,
      serviceDependencies: [],
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
    const { client } = sandboxClient([
      { sandboxId: "eclectic-lioness-9811", status: "RUNNING", name: legacyName },
    ]);
    const ssh = runtime(store);

    const listed = await ssh.listMachines(client, "user-a");
    const projects = await ssh.projectList(client, "user-a");

    assert.equal(listed.machines[0]?.id, "eclectic-lioness-9811");
    assert.equal(listed.machines[0]?.name, "calm-falcon-d472ea63");
    assert.equal(listed.machines[0]?.projects[0]?.name, "demo");
    assert.deepEqual(
      projects.map((project) => project.id),
      ["6c73da4fc8073da8b58e9c4e08db8104"],
    );
  });

  it("removes a project created concurrently with expiration reaping", async () => {
    const now = Date.now();
    const futureName = createSandboxName("00112233");
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

    const pendingProject = ssh.addProject(client, "user-a", {
      machineId: "owned",
      name: "project",
      port: 3000,
      path: "project",
    });
    await routeWasAdded;
    const expiredAt = now - 1_000;
    const expiredName = createSandboxName("00112233");
    store.assignments[0] = assignment("user-a", "owned", expiredName, expiredAt);
    entries.set("owned", { sandboxId: "owned", status: "RUNNING", name: expiredName });
    await ssh.reapMachines(client);
    resumeAdd();

    await assert.rejects(pendingProject, /not assigned|operation was revoked/);
    assert.deepEqual(store.projects, []);
  });
});
