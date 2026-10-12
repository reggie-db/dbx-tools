import {
  advisoryLock,
  quotePostgresIdentifier,
  type PgPoolLike,
  type PgQueryable,
} from "@dbx-tools/postgres";
import { hash } from "@dbx-tools/shared-core";
import type { AddSshProjectRequest } from "@dbx-tools/shared-databricks-sandbox";
import { z } from "zod";

type ProjectConfig = NonNullable<AddSshProjectRequest["config"]>;

const MIGRATION_LOCK = ["appkit-sandbox", "machine-ownership", "migrations"] as const;
const REAPER_LOCK = ["appkit-sandbox", "machine-ownership", "reaper"] as const;
/** Shared prefix; each Lakebase connector owns `${prefix}_${hash(current_user)}`. */
export const OWNERSHIP_SCHEMA_PREFIX = "dbx_tools_databricks_sandbox";

/**
 * Partition ownership tables under the existing schema name plus a hash of the
 * Lakebase login (workspace user or app service principal).
 */
export function ownershipSchemaName(role: string): string {
  return `${OWNERSHIP_SCHEMA_PREFIX}_${hash.fnvHash(role.trim())}`;
}

/** Resolve the Postgres role that is actually connected to Lakebase. */
export async function connectingLakebaseRole(pool: PgQueryable): Promise<string> {
  const result = await pool.query<{ role: string }>("SELECT current_user AS role");
  const role = result.rows[0]?.role?.trim();
  if (!role) {
    throw new Error(
      "Lakebase ownership could not resolve the connecting user or service principal",
    );
  }
  return role;
}

export const MachineAssignmentSchema = z
  .object({
    workspaceScope: z.string().min(1).describe("Workspace identity that contains the machine."),
    userId: z.string().min(1).describe("AppKit user identity allowed to use the machine."),
    machineId: z.string().min(1).describe("Databricks Sandbox identifier."),
    managedName: z
      .string()
      .min(1)
      .optional()
      .describe("Service-generated Sandbox name; absent only on legacy rows awaiting reaping."),
    expiresAt: z
      .string()
      .datetime()
      .optional()
      .describe("Service-managed expiration; absent only on legacy rows awaiting reaping."),
    createdAt: z.string().datetime().describe("Time the assignment was first persisted."),
  })
  .strict()
  .describe("One Lakebase-persisted AppKit user-to-Sandbox assignment.");

export type MachineAssignment = z.infer<typeof MachineAssignmentSchema>;

export const NewMachineAssignmentSchema = MachineAssignmentSchema.omit({ createdAt: true })
  .required({ managedName: true, expiresAt: true })
  .describe("New service-managed Sandbox assignment written to Lakebase.");

export type NewMachineAssignment = z.infer<typeof NewMachineAssignmentSchema>;

export const SandboxProjectRecordSchema = z
  .object({
    workspaceScope: z.string().min(1).describe("Workspace identity that contains the machine."),
    userId: z.string().min(1).describe("AppKit user identity that owns the project."),
    projectId: z.string().min(1).describe("Stable project identifier."),
    name: z.string().min(1).describe("Project name and directory slug."),
    machineId: z.string().min(1).describe("Databricks Sandbox that hosts the project."),
    directory: z.string().min(1).describe("User-owned project directory on the Sandbox."),
    projectPath: z.string().min(1).describe("Project path relative to the Sandbox projects root."),
    path: z.string().startsWith("/").describe("AppKit route path for the project."),
    openPath: z.string().min(1).optional().describe("Optional project-relative entry URL."),
    port: z.number().int().min(1).max(65535).describe("Sandbox-side loopback port."),
    config: z
      .record(z.string(), z.json())
      .describe("JSON representation of the project's mise configuration."),
    stripPrefix: z.boolean().describe("Whether AppKit strips the project route prefix."),
    createdAt: z.string().datetime().describe("Time the project was first persisted."),
    updatedAt: z.string().datetime().describe("Time the project configuration last changed."),
  })
  .strict()
  .describe("One Lakebase-persisted Sandbox project.");

export type SandboxProjectRecord = z.infer<typeof SandboxProjectRecordSchema>;

export const NewSandboxProjectRecordSchema = SandboxProjectRecordSchema.omit({
  createdAt: true,
  updatedAt: true,
}).describe("Sandbox project configuration written to Lakebase.");

export type NewSandboxProjectRecord = z.infer<typeof NewSandboxProjectRecordSchema>;

type LakebasePool = PgPoolLike & PgQueryable;

/**
 * Lakebase-backed ownership and expiration records for one connecting role.
 *
 * Tables live in `dbx_tools_databricks_sandbox_<hash(current_user)>` so each
 * workspace user or app service principal owns its partition. The runtime
 * treats these records as its application-level machine visibility boundary.
 * Databricks workspace authorization remains authoritative for the underlying
 * REST and SSH operations.
 */
export class LakebaseMachineOwnershipStore {
  private constructor(
    private readonly pool: LakebasePool,
    readonly schema: string,
  ) {}

  /** Detects the connecting Lakebase role, then creates tables in its schema. */
  static async create(pool: LakebasePool): Promise<LakebaseMachineOwnershipStore> {
    const role = await connectingLakebaseRole(pool);
    const store = new LakebaseMachineOwnershipStore(pool, ownershipSchemaName(role));
    await store.migrate();
    return store;
  }

  /** Schema-qualified table name for this connector's partition. */
  private table(name: "machine_assignments" | "projects"): string {
    return `${quotePostgresIdentifier(this.schema)}.${quotePostgresIdentifier(name)}`;
  }

  /** Lists assignments in one workspace, optionally restricted to one AppKit user. */
  async listAssignments(workspaceScope: string, userId?: string): Promise<MachineAssignment[]> {
    const values = userId ? [workspaceScope, userId] : [workspaceScope];
    const condition = userId ? "workspace_scope = $1 AND user_id = $2" : "workspace_scope = $1";
    const result = await this.pool.query<AssignmentRow>(
      `SELECT workspace_scope, user_id, machine_id, managed_name, expires_at, created_at
       FROM ${this.table("machine_assignments")}
       WHERE ${condition}
       ORDER BY created_at, machine_id`,
      values,
    );
    return result.rows.map(parseAssignmentRow);
  }

  /** Returns one assignment by workspace, user, and Sandbox ID. */
  async get(
    workspaceScope: string,
    userId: string,
    machineId: string,
  ): Promise<MachineAssignment | undefined> {
    const result = await this.pool.query<AssignmentRow>(
      `SELECT workspace_scope, user_id, machine_id, managed_name, expires_at, created_at
       FROM ${this.table("machine_assignments")}
       WHERE workspace_scope = $1 AND user_id = $2 AND machine_id = $3`,
      [workspaceScope, userId, machineId],
    );
    const row = result.rows[0];
    return row ? parseAssignmentRow(row) : undefined;
  }

  /** Inserts or replaces one assignment and its managed name and expiration. */
  async assign(input: NewMachineAssignment): Promise<void> {
    const assignment = NewMachineAssignmentSchema.parse(input);
    await this.pool.query(
      `INSERT INTO ${this.table("machine_assignments")}
         (workspace_scope, user_id, machine_id, managed_name, expires_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz)
       ON CONFLICT (workspace_scope, user_id, machine_id)
       DO UPDATE SET managed_name = EXCLUDED.managed_name, expires_at = EXCLUDED.expires_at`,
      [
        assignment.workspaceScope,
        assignment.userId,
        assignment.machineId,
        assignment.managedName,
        assignment.expiresAt,
      ],
    );
  }

  /** Removes one user's assignment and returns whether a row was deleted. */
  async unassign(workspaceScope: string, userId: string, machineId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM ${this.table("machine_assignments")}
       WHERE workspace_scope = $1 AND user_id = $2 AND machine_id = $3`,
      [workspaceScope, userId, machineId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Removes every assignment for one Sandbox and returns the deleted row count. */
  async unassignAll(workspaceScope: string, machineId: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM ${this.table("machine_assignments")} WHERE workspace_scope = $1 AND machine_id = $2`,
      [workspaceScope, machineId],
    );
    return result.rowCount ?? 0;
  }

  /** Lists persisted projects in one workspace with optional owner and machine filters. */
  async listProjects(
    workspaceScope: string,
    filters: { userId?: string; machineId?: string } = {},
  ): Promise<SandboxProjectRecord[]> {
    const values: string[] = [workspaceScope];
    const conditions = ["workspace_scope = $1"];
    if (filters.userId) {
      values.push(filters.userId);
      conditions.push(`user_id = $${values.length}`);
    }
    if (filters.machineId) {
      values.push(filters.machineId);
      conditions.push(`machine_id = $${values.length}`);
    }
    const result = await this.pool.query<ProjectRow>(
      `SELECT workspace_scope, user_id, project_id, project_name, machine_id,
              directory_path, project_path, route_path, open_path, port,
              project_config, strip_prefix, created_at, updated_at
       FROM ${this.table("projects")}
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at, project_id`,
      values,
    );
    return result.rows.map(parseProjectRow);
  }

  /** Returns one persisted project by workspace, owner, and project ID. */
  async getProject(
    workspaceScope: string,
    userId: string,
    projectId: string,
  ): Promise<SandboxProjectRecord | undefined> {
    const result = await this.pool.query<ProjectRow>(
      `SELECT workspace_scope, user_id, project_id, project_name, machine_id,
              directory_path, project_path, route_path, open_path, port,
              project_config, strip_prefix, created_at, updated_at
       FROM ${this.table("projects")}
       WHERE workspace_scope = $1 AND user_id = $2 AND project_id = $3`,
      [workspaceScope, userId, projectId],
    );
    return result.rows[0] ? parseProjectRow(result.rows[0]) : undefined;
  }

  /** Returns one persisted project by workspace, owner, machine, and name. */
  async getProjectByName(
    workspaceScope: string,
    userId: string,
    machineId: string,
    name: string,
  ): Promise<SandboxProjectRecord | undefined> {
    const result = await this.pool.query<ProjectRow>(
      `SELECT workspace_scope, user_id, project_id, project_name, machine_id,
              directory_path, project_path, route_path, open_path, port,
              project_config, strip_prefix, created_at, updated_at
       FROM ${this.table("projects")}
       WHERE workspace_scope = $1 AND user_id = $2 AND machine_id = $3 AND project_name = $4`,
      [workspaceScope, userId, machineId, name],
    );
    return result.rows[0] ? parseProjectRow(result.rows[0]) : undefined;
  }

  /** Inserts or updates one persisted Sandbox project. */
  async upsertProject(input: NewSandboxProjectRecord): Promise<void> {
    const project = NewSandboxProjectRecordSchema.parse(input);
    await this.pool.query(
      `INSERT INTO ${this.table("projects")}
         (workspace_scope, user_id, project_id, project_name, machine_id,
          directory_path, project_path, route_path, open_path, port, project_config, strip_prefix)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (workspace_scope, user_id, project_id)
       DO UPDATE SET project_name = EXCLUDED.project_name,
                     machine_id = EXCLUDED.machine_id,
                     directory_path = EXCLUDED.directory_path,
                     project_path = EXCLUDED.project_path,
                     route_path = EXCLUDED.route_path,
                     open_path = EXCLUDED.open_path,
                     port = EXCLUDED.port,
                     project_config = EXCLUDED.project_config,
                     strip_prefix = EXCLUDED.strip_prefix,
                     updated_at = now()`,
      [
        project.workspaceScope,
        project.userId,
        project.projectId,
        project.name,
        project.machineId,
        project.directory,
        project.projectPath,
        project.path,
        project.openPath ?? null,
        project.port,
        project.config,
        project.stripPrefix,
      ],
    );
  }

  /** Deletes one persisted project and returns whether a row was removed. */
  async deleteProject(workspaceScope: string, userId: string, projectId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM ${this.table("projects")}
       WHERE workspace_scope = $1 AND user_id = $2 AND project_id = $3`,
      [workspaceScope, userId, projectId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Deletes all persisted projects for one Sandbox. */
  async deleteProjectsForMachine(workspaceScope: string, machineId: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM ${this.table("projects")} WHERE workspace_scope = $1 AND machine_id = $2`,
      [workspaceScope, machineId],
    );
    return result.rowCount ?? 0;
  }

  /** Runs one reconciliation pass while holding a workspace-scoped advisory lock. */
  async withReaperLock<T>(workspaceScope: string, operation: () => Promise<T>): Promise<T> {
    return advisoryLock.withAdvisoryLock(
      this.pool,
      [...REAPER_LOCK, this.schema, workspaceScope],
      operation,
    );
  }

  /** Releases store-owned resources without closing the caller-owned pool. */
  async close(): Promise<void> {}

  private async migrate(): Promise<void> {
    const assignments = this.table("machine_assignments");
    const projects = this.table("projects");
    await advisoryLock.withAdvisoryLock(
      this.pool,
      [...MIGRATION_LOCK, this.schema],
      async (client) => {
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotePostgresIdentifier(this.schema)}`);
        await client.query(`
        CREATE TABLE IF NOT EXISTS ${assignments} (
          workspace_scope TEXT NOT NULL,
          user_id TEXT NOT NULL,
          machine_id TEXT NOT NULL,
          managed_name TEXT,
          expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (workspace_scope, user_id, machine_id)
        )
      `);
        await client.query(`ALTER TABLE ${assignments} ADD COLUMN IF NOT EXISTS managed_name TEXT`);
        await client.query(
          `ALTER TABLE ${assignments} ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
        );
        await client.query(
          `CREATE INDEX IF NOT EXISTS machine_assignments_expiry_idx
         ON ${assignments} (workspace_scope, expires_at)`,
        );
        await client.query(`
        CREATE TABLE IF NOT EXISTS ${projects} (
          workspace_scope TEXT NOT NULL,
          user_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          project_name TEXT NOT NULL,
          machine_id TEXT NOT NULL,
          directory_path TEXT NOT NULL,
          project_path TEXT NOT NULL,
          route_path TEXT NOT NULL,
          open_path TEXT,
          port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
          project_config JSONB NOT NULL DEFAULT '{}'::jsonb,
          remote_host TEXT,
          remote_port INTEGER,
          strip_prefix BOOLEAN NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (workspace_scope, user_id, project_id)
        )
      `);
        await client.query(`ALTER TABLE ${projects} ADD COLUMN IF NOT EXISTS project_path TEXT`);
        await client.query(`ALTER TABLE ${projects} ADD COLUMN IF NOT EXISTS port INTEGER`);
        await client.query(
          `ALTER TABLE ${projects} ADD COLUMN IF NOT EXISTS project_config JSONB NOT NULL DEFAULT '{}'::jsonb`,
        );
        await client.query(`ALTER TABLE ${projects} ALTER COLUMN remote_host DROP NOT NULL`);
        await client.query(`ALTER TABLE ${projects} ALTER COLUMN remote_port DROP NOT NULL`);
        await client.query(
          `UPDATE ${projects}
         SET project_path = COALESCE(project_path, project_name),
             port = COALESCE(port, remote_port),
             directory_path = CASE
               WHEN project_path IS NULL THEN '~/projects/' || project_name
               ELSE directory_path
             END
         WHERE project_path IS NULL OR port IS NULL`,
        );
        await client.query(`ALTER TABLE ${projects} ALTER COLUMN project_path SET NOT NULL`);
        await client.query(`ALTER TABLE ${projects} ALTER COLUMN port SET NOT NULL`);
        await client.query(
          `CREATE INDEX IF NOT EXISTS sandbox_projects_machine_idx
         ON ${projects} (workspace_scope, machine_id)`,
        );
        await client.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS sandbox_projects_machine_name_idx
         ON ${projects} (workspace_scope, machine_id, project_name)`,
        );
        await client.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS sandbox_projects_machine_path_idx
         ON ${projects} (workspace_scope, machine_id, project_path)`,
        );
        await client.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS sandbox_projects_machine_port_idx
         ON ${projects} (workspace_scope, machine_id, port)`,
        );
      },
    );
  }
}

interface AssignmentRow {
  workspace_scope: string;
  user_id: string;
  machine_id: string;
  managed_name: string | null;
  expires_at: Date | string | null;
  created_at: Date | string;
}

interface ProjectRow {
  workspace_scope: string;
  user_id: string;
  project_id: string;
  project_name: string;
  machine_id: string;
  directory_path: string;
  project_path: string;
  route_path: string;
  open_path: string | null;
  port: number;
  project_config: ProjectConfig;
  strip_prefix: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

function parseAssignmentRow(row: AssignmentRow): MachineAssignment {
  return MachineAssignmentSchema.parse({
    workspaceScope: row.workspace_scope,
    userId: row.user_id,
    machineId: row.machine_id,
    ...(row.managed_name ? { managedName: row.managed_name } : {}),
    ...(row.expires_at ? { expiresAt: isoTimestamp(row.expires_at) } : {}),
    createdAt: isoTimestamp(row.created_at),
  });
}

function parseProjectRow(row: ProjectRow): SandboxProjectRecord {
  return SandboxProjectRecordSchema.parse({
    workspaceScope: row.workspace_scope,
    userId: row.user_id,
    projectId: row.project_id,
    name: row.project_name,
    machineId: row.machine_id,
    directory: row.directory_path,
    projectPath: row.project_path,
    path: row.route_path,
    ...(row.open_path ? { openPath: row.open_path } : {}),
    port: row.port,
    config: row.project_config,
    stripPrefix: row.strip_prefix,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  });
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
