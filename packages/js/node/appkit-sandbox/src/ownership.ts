import { advisoryLock, type PgPoolLike, type PgQueryable } from "@dbx-tools/postgres";
import { z } from "zod";

const MIGRATION_LOCK = ["appkit-sandbox", "machine-ownership", "migrations"] as const;
const REAPER_LOCK = ["appkit-sandbox", "machine-ownership", "reaper"] as const;
const SCHEMA = "dbx_tools_databricks_sandbox";
const TABLE = `${SCHEMA}.machine_assignments`;

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

type LakebasePool = PgPoolLike & PgQueryable;

/**
 * Lakebase-backed ownership and expiration records shared by every app instance.
 *
 * The runtime treats these records as its application-level machine visibility
 * boundary. Databricks workspace authorization remains authoritative for the
 * underlying REST and SSH operations.
 */
export class LakebaseMachineOwnershipStore {
  private constructor(private readonly pool: LakebasePool) {}

  /** Creates the assignments table and returns a store backed by the given pool. */
  static async create(pool: LakebasePool): Promise<LakebaseMachineOwnershipStore> {
    const store = new LakebaseMachineOwnershipStore(pool);
    await store.migrate();
    return store;
  }

  /** Lists assignments in one workspace, optionally restricted to one AppKit user. */
  async listAssignments(workspaceScope: string, userId?: string): Promise<MachineAssignment[]> {
    const values = userId ? [workspaceScope, userId] : [workspaceScope];
    const condition = userId ? "workspace_scope = $1 AND user_id = $2" : "workspace_scope = $1";
    const result = await this.pool.query<AssignmentRow>(
      `SELECT workspace_scope, user_id, machine_id, managed_name, expires_at, created_at
       FROM ${TABLE}
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
       FROM ${TABLE}
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
      `INSERT INTO ${TABLE}
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
      `DELETE FROM ${TABLE}
       WHERE workspace_scope = $1 AND user_id = $2 AND machine_id = $3`,
      [workspaceScope, userId, machineId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Removes every assignment for one Sandbox and returns the deleted row count. */
  async unassignAll(workspaceScope: string, machineId: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM ${TABLE} WHERE workspace_scope = $1 AND machine_id = $2`,
      [workspaceScope, machineId],
    );
    return result.rowCount ?? 0;
  }

  /** Runs one reconciliation pass while holding a workspace-scoped advisory lock. */
  async withReaperLock<T>(workspaceScope: string, operation: () => Promise<T>): Promise<T> {
    return advisoryLock.withAdvisoryLock(this.pool, [...REAPER_LOCK, workspaceScope], operation);
  }

  /** Releases store-owned resources. The shared AppKit Lakebase pool remains open. */
  async close(): Promise<void> {}

  private async migrate(): Promise<void> {
    await advisoryLock.withAdvisoryLock(this.pool, MIGRATION_LOCK, async (client) => {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          workspace_scope TEXT NOT NULL,
          user_id TEXT NOT NULL,
          machine_id TEXT NOT NULL,
          managed_name TEXT,
          expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (workspace_scope, user_id, machine_id)
        )
      `);
      await client.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS managed_name TEXT`);
      await client.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS machine_assignments_expiry_idx
         ON ${TABLE} (workspace_scope, expires_at)`,
      );
    });
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

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
