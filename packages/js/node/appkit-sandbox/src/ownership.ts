import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileLock } from "@dbx-tools/core";
import { advisoryLock, type PgPoolLike, type PgQueryable } from "@dbx-tools/postgres";
import { log } from "@dbx-tools/shared-core";
import { z } from "zod";

const logger = log.logger("appkit-sandbox:ownership");
const MIGRATION_LOCK = ["appkit-sandbox", "machine-ownership", "migrations"] as const;
const DISK_LOCK = ["appkit-sandbox", "machine-ownership", "disk"] as const;
const SCHEMA = "dbx_tools_databricks_sandbox";
const TABLE = `${SCHEMA}.machine_assignments`;

export const MachineAssignmentSchema = z
  .object({
    workspaceScope: z.string().min(1).describe("Workspace identity that contains the machine."),
    userId: z.string().min(1).describe("AppKit user identity allowed to use the machine."),
    machineId: z.string().min(1).describe("Databricks Sandbox identifier."),
    createdAt: z.string().datetime().describe("Time the assignment was first persisted."),
  })
  .strict()
  .describe("One persistent AppKit user-to-Sandbox assignment.");

export type MachineAssignment = z.infer<typeof MachineAssignmentSchema>;

const MachineAssignmentFileSchema = z
  .object({
    version: z.literal(1).describe("Machine assignment file format version."),
    assignments: z
      .array(MachineAssignmentSchema)
      .describe("Persisted user-to-machine assignments."),
  })
  .strict()
  .describe("Disk-backed Databricks Sandbox machine assignment file.");

/** Persistent ownership boundary for service-principal-visible Sandboxes. */
export interface MachineOwnershipStore {
  readonly kind: "lakebase" | "disk";
  listMachineIds(workspaceScope: string, userId: string): Promise<ReadonlySet<string>>;
  has(workspaceScope: string, userId: string, machineId: string): Promise<boolean>;
  assign(workspaceScope: string, userId: string, machineId: string): Promise<void>;
  unassign(workspaceScope: string, userId: string, machineId: string): Promise<boolean>;
  unassignAll(workspaceScope: string, machineId: string): Promise<number>;
  close(): Promise<void>;
}

/** Durable local assignment storage for apps without a Lakebase plugin. */
export class DiskMachineOwnershipStore implements MachineOwnershipStore {
  readonly kind = "disk" as const;

  constructor(readonly path: string) {}

  async listMachineIds(workspaceScope: string, userId: string): Promise<ReadonlySet<string>> {
    const assignments = await this.read();
    return new Set(
      assignments
        .filter(
          (assignment) =>
            assignment.workspaceScope === workspaceScope && assignment.userId === userId,
        )
        .map((assignment) => assignment.machineId),
    );
  }

  async has(workspaceScope: string, userId: string, machineId: string): Promise<boolean> {
    return (await this.listMachineIds(workspaceScope, userId)).has(machineId);
  }

  async assign(workspaceScope: string, userId: string, machineId: string): Promise<void> {
    await fileLock.withFileLock(DISK_LOCK, async () => {
      const assignments = await this.readUnlocked();
      if (
        assignments.some(
          (assignment) =>
            assignment.workspaceScope === workspaceScope &&
            assignment.userId === userId &&
            assignment.machineId === machineId,
        )
      ) {
        return;
      }
      assignments.push({ workspaceScope, userId, machineId, createdAt: new Date().toISOString() });
      await this.writeUnlocked(assignments);
    });
  }

  async unassign(workspaceScope: string, userId: string, machineId: string): Promise<boolean> {
    return fileLock.withFileLock(DISK_LOCK, async () => {
      const assignments = await this.readUnlocked();
      const filtered = assignments.filter(
        (assignment) =>
          assignment.workspaceScope !== workspaceScope ||
          assignment.userId !== userId ||
          assignment.machineId !== machineId,
      );
      if (filtered.length === assignments.length) return false;
      await this.writeUnlocked(filtered);
      return true;
    });
  }

  async unassignAll(workspaceScope: string, machineId: string): Promise<number> {
    return fileLock.withFileLock(DISK_LOCK, async () => {
      const assignments = await this.readUnlocked();
      const filtered = assignments.filter(
        (assignment) =>
          assignment.workspaceScope !== workspaceScope || assignment.machineId !== machineId,
      );
      const removed = assignments.length - filtered.length;
      if (removed === 0) return 0;
      await this.writeUnlocked(filtered);
      return removed;
    });
  }

  async close(): Promise<void> {}

  private read(): Promise<MachineAssignment[]> {
    return fileLock.withFileLock(DISK_LOCK, () => this.readUnlocked());
  }

  private async readUnlocked(): Promise<MachineAssignment[]> {
    try {
      const contents = await readFile(this.path, "utf8");
      return MachineAssignmentFileSchema.parse(JSON.parse(contents)).assignments;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeUnlocked(assignments: MachineAssignment[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const contents = `${JSON.stringify({ version: 1, assignments }, null, 2)}\n`;
    await writeFile(temporaryPath, contents, { mode: 0o600 });
    await rename(temporaryPath, this.path);
  }
}

type LakebasePool = PgPoolLike & PgQueryable;

/** Lakebase-backed assignment storage shared by every app instance. */
export class LakebaseMachineOwnershipStore implements MachineOwnershipStore {
  readonly kind = "lakebase" as const;

  private constructor(private readonly pool: LakebasePool) {}

  static async create(pool: LakebasePool): Promise<LakebaseMachineOwnershipStore> {
    await advisoryLock.withAdvisoryTransactionLock(pool, MIGRATION_LOCK, async (client) => {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          workspace_scope TEXT NOT NULL,
          user_id TEXT NOT NULL,
          machine_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (workspace_scope, user_id, machine_id)
        )
      `);
    });
    return new LakebaseMachineOwnershipStore(pool);
  }

  async listMachineIds(workspaceScope: string, userId: string): Promise<ReadonlySet<string>> {
    const result = await this.pool.query<{ machine_id: string }>(
      `SELECT machine_id FROM ${TABLE} WHERE workspace_scope = $1 AND user_id = $2`,
      [workspaceScope, userId],
    );
    return new Set(result.rows.map((row) => row.machine_id));
  }

  async has(workspaceScope: string, userId: string, machineId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM ${TABLE} WHERE workspace_scope = $1 AND user_id = $2 AND machine_id = $3`,
      [workspaceScope, userId, machineId],
    );
    return result.rowCount !== 0;
  }

  async assign(workspaceScope: string, userId: string, machineId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${TABLE} (workspace_scope, user_id, machine_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [workspaceScope, userId, machineId],
    );
  }

  async unassign(workspaceScope: string, userId: string, machineId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM ${TABLE} WHERE workspace_scope = $1 AND user_id = $2 AND machine_id = $3`,
      [workspaceScope, userId, machineId],
    );
    return result.rowCount !== 0;
  }

  async unassignAll(workspaceScope: string, machineId: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM ${TABLE} WHERE workspace_scope = $1 AND machine_id = $2`,
      [workspaceScope, machineId],
    );
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> {}
}

/** Prefer Lakebase, but transparently retain durable disk storage in auto mode. */
export async function createMachineOwnershipStore(options: {
  mode: "auto" | "lakebase" | "disk";
  path: string;
  pool?: LakebasePool;
}): Promise<MachineOwnershipStore> {
  if (options.pool && options.mode !== "disk") {
    try {
      return await LakebaseMachineOwnershipStore.create(options.pool);
    } catch (error) {
      if (options.mode === "lakebase") throw error;
      logger.warn("Lakebase machine ownership unavailable; using disk", { error });
    }
  } else if (options.mode === "lakebase") {
    throw new Error("SSH machine ownership storage is lakebase but no Lakebase pool was supplied");
  }
  return new DiskMachineOwnershipStore(options.path);
}
