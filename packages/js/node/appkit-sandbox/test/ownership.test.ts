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
  type NewSandboxProjectRecord,
  type SandboxProjectRecord,
} from "../src/ownership.ts";
import type { SandboxEntry } from "../src/rest.ts";
import { SshRuntime } from "../src/runtime.ts";
import type { SshSession } from "../src/session.ts";

const unusedSession = {
  close: () => undefined,
  execute: async (command: string, args: string[]) => ({
    success: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    executionTimeMs: 0,
    command,
    args,
  }),
  forwardOut: async () => assert.fail("not used"),
} as unknown as SshSession;

class MemoryOwnershipStore {
  readonly assignments: MachineAssignment[] = [];
  readonly projects: SandboxProjectRecord[] = [];

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

interface SessionRuntimeInternals {
  ensureSession(
    client: WorkspaceClient,
    userId: string,
    machine: SandboxEntry,
    epoch: { machine: number; owner: number },
  ): Promise<SshSession>;
  createSession(): Promise<SshSession>;
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
    assert.ok(
      statements.some((statement) => statement.includes("dbx_tools_databricks_sandbox.projects")),
    );
    assert.ok(statements.some((statement) => statement.includes("open_path TEXT")));
    assert.ok(statements.some((statement) => statement.includes("project_config JSONB")));
    assert.ok(statements.some((statement) => statement.includes("sandbox_projects_machine_idx")));
    assert.ok(
      statements.some((statement) => statement.includes("sandbox_projects_machine_port_idx")),
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
      directory_path: "~/projects/demo",
      project_path: "demo",
      route_path: "/sandbox/hash/demo",
      open_path: "open.html",
      port: 8080,
      project_config: { tools: { node: "lts" } },
      strip_prefix: true,
      created_at: new Date("2026-10-12T10:00:00.000Z"),
      updated_at: new Date("2026-10-12T10:01:00.000Z"),
    };
    const query = async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (text.includes("pg_advisory_unlock")) {
        return { rows: [{ unlocked: true }], rowCount: 1 };
      }
      if (
        text.includes("SELECT workspace_scope") &&
        text.includes("FROM dbx_tools_databricks_sandbox.projects")
      ) {
        return { rows: [row], rowCount: 1 };
      }
      if (text.includes("DELETE FROM dbx_tools_databricks_sandbox.projects")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const pool = {
      connect: async () => ({ query, release: () => undefined }),
      query,
    } as unknown as Parameters<typeof LakebaseMachineOwnershipStore.create>[0];
    const store = await LakebaseMachineOwnershipStore.create(pool);

    await store.upsertProject({
      workspaceScope: "workspace",
      userId: "user-a",
      projectId: "project-1",
      name: "demo",
      machineId: "machine-1",
      directory: "~/projects/demo",
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
    assert.equal(await store.deleteProject("workspace", "user-a", "project-1"), true);
    assert.ok(
      queries.some(({ text }) =>
        text.includes("INSERT INTO dbx_tools_databricks_sandbox.projects"),
      ),
    );
    assert.ok(queries.some(({ text }) => text.includes("updated_at = now()")));
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

  it("allows a second identity to use and retain one assigned Sandbox", async () => {
    const now = Date.now();
    const expiresAtMs = now + 60_000;
    const managedName = createManagedSandboxName("platform-user", expiresAtMs, "00112233");
    const store = new MemoryOwnershipStore();
    store.assignments.push(
      assignment("platform-user", "owned", managedName, expiresAtMs),
      assignment("user@example.com", "owned", managedName, expiresAtMs),
    );
    const { client, entries } = sandboxClient([
      { sandboxId: "owned", status: "RUNNING", name: managedName },
    ]);
    const ssh = runtime(store);

    assert.deepEqual(
      (await ssh.listMachines(client, "user@example.com")).machines.map((machine) => machine.id),
      ["owned"],
    );
    assert.deepEqual(await ssh.reapMachines(client), {
      scanned: 1,
      deleted: 0,
      removedAssignments: 0,
      failures: 0,
    });
    assert.deepEqual([...entries.keys()], ["owned"]);
    assert.equal(store.assignments.length, 2);
  });

  it("retains a successful SSH connection after its connect promise settles", async () => {
    const now = Date.now();
    const managedName = createManagedSandboxName("user-a", now + 60_000, "00112233");
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

  it("persists projects, updates open links, and removes only the project directory", async () => {
    const now = Date.now();
    const managedName = createManagedSandboxName("user-a", now + 60_000, "00112233");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "owned", managedName, now + 60_000));
    const { client } = sandboxClient([
      { sandboxId: "owned", status: "RUNNING", name: managedName },
    ]);
    const commands: string[] = [];
    const session = {
      close: () => undefined,
      execute: async (command: string, args: string[]) => {
        commands.push(`${command} ${args.join(" ")}`);
        return {
          success: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          executionTimeMs: 0,
          command,
          args,
        };
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

    assert.equal(created.directory, "~/projects/demo");
    assert.equal(created.openUrl, `${ssh.projectPathPrefix("user-a")}/demo/open.html`);
    assert.equal(updated.id, created.id);
    assert.equal(updated.port, 8081);
    assert.equal(
      updated.openUrl,
      `${ssh.projectPathPrefix("user-a")}/demo/dashboard.html?mode=full`,
    );
    assert.equal(store.projects.length, 1);
    assert.equal(await ssh.removeProject(client, "user-a", created.id), true);
    assert.deepEqual(store.projects, []);
    assert.ok(commands.some((command) => command.includes("base64 -d")));
  });

  it("generates project defaults and rejects duplicate machine paths and ports", async () => {
    const now = Date.now();
    const managedName = createManagedSandboxName("user-a", now + 60_000, "00112233");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "owned", managedName, now + 60_000));
    const { client } = sandboxClient([
      { sandboxId: "owned", status: "RUNNING", name: managedName },
    ]);
    const ssh = runtime(store, { machineSoftware: [] });
    Object.defineProperty(ssh, "ensureSession", { value: async () => unusedSession });

    const generated = await ssh.addProject(client, "user-a", { machineId: "owned" });
    assert.match(generated.name, /^project-[a-f0-9]{6}$/);
    assert.equal(generated.directory, `~/projects/${generated.name}`);
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
    assert.equal(renamed.directory, "~/projects/nested/renamed-project");
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
  });

  it("resets a persisted project and opens its directory in DinoTTY", async () => {
    const now = Date.now();
    const managedName = createManagedSandboxName("user-a", now + 60_000, "00112233");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "owned", managedName, now + 60_000));
    const { client } = sandboxClient([
      { sandboxId: "owned", status: "RUNNING", name: managedName },
    ]);
    const commands: Array<{ command: string; args: string[] }> = [];
    const session = {
      close: () => undefined,
      execute: async (command: string, args: string[]) => {
        commands.push({ command, args });
        return {
          success: true,
          exitCode: 0,
          stdout: args[1]?.includes("sh -s -- 'demo' ''")
            ? "__DBX_PROJECT_DIRECTORY__=/home/sandbox/projects/demo\n"
            : "",
          stderr: "",
          executionTimeMs: 0,
          command,
          args,
        };
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

    assert.equal(reset.directory, "/home/sandbox/projects/demo");
    assert.equal(reset.state, "ready");
    assert.ok(commands.some(({ args }) => args[1]?.endsWith("sh -s -- 'demo'")));
    assert.ok(commands.some(({ args }) => args[1]?.includes("sh -s -- 'demo' ''")));
    Object.defineProperty(ssh, "startService", {
      value: async () => ({
        kind: "terminal",
        path: "/sandbox/terminal/owned",
        openUrl: "/sandbox/terminal/owned",
        state: "ready",
      }),
    });

    const terminal = await ssh.openProjectTerminal(client, "user-a", project.id);

    assert.equal(terminal.project.id, project.id);
    assert.equal(terminal.service.kind, "terminal");
    assert.ok(commands.some(({ command, args }) => command === "python3" && args[0] === "-c"));
  });

  it("preserves projects when a machine stops and deletes records with the machine", async () => {
    const now = Date.now();
    const managedName = createManagedSandboxName("user-a", now + 60_000, "00112233");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "owned", managedName, now + 60_000));
    const first = runtime(store, { machineSoftware: [], reaperIntervalSeconds: 0 });
    await store.upsertProject({
      workspaceScope: "workspace",
      userId: "user-a",
      projectId: "project-1",
      name: "demo",
      machineId: "owned",
      directory: "~/projects/demo",
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

  it("restores persisted project routes after the runtime restarts", async () => {
    const now = Date.now();
    const managedName = createManagedSandboxName("user-a", now + 60_000, "00112233");
    const store = new MemoryOwnershipStore();
    store.assignments.push(assignment("user-a", "owned", managedName, now + 60_000));
    const first = runtime(store, { machineSoftware: [], reaperIntervalSeconds: 0 });
    await store.upsertProject({
      workspaceScope: "workspace",
      userId: "user-a",
      projectId: "project-1",
      name: "demo",
      machineId: "owned",
      directory: "~/projects/demo",
      projectPath: "demo",
      path: `${first.projectPathPrefix("user-a")}/demo`,
      openPath: "open.html",
      port: 8080,
      config: {},
      stripPrefix: true,
    });
    const { client } = sandboxClient([
      { sandboxId: "owned", status: "RUNNING", name: managedName },
    ]);
    Object.defineProperty(first, "ensureSession", { value: async () => unusedSession });
    await first.startReaper(client);
    assert.equal(first.routes.list("owned", "user-a").length, 1);
    await first.close();
    assert.equal(store.projects.length, 1);

    const second = runtime(store, { machineSoftware: [], reaperIntervalSeconds: 0 });
    Object.defineProperty(second, "ensureSession", { value: async () => unusedSession });
    await second.startReaper(client);
    assert.equal(second.routes.list("owned", "user-a")[0]?.id, "project-1");
    await second.close();
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

  it("removes a project created concurrently with expiration reaping", async () => {
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

    const pendingProject = ssh.addProject(client, "user-a", {
      machineId: "owned",
      name: "project",
      port: 3000,
      path: "project",
    });
    await routeWasAdded;
    const expiredAt = now - 1_000;
    const expiredName = createManagedSandboxName("user-a", expiredAt, "00112233");
    store.assignments[0] = assignment("user-a", "owned", expiredName, expiredAt);
    entries.set("owned", { sandboxId: "owned", status: "RUNNING", name: expiredName });
    await ssh.reapMachines(client);
    resumeAdd();

    await assert.rejects(pendingProject, /not assigned|operation was revoked/);
    assert.deepEqual(store.projects, []);
  });
});
