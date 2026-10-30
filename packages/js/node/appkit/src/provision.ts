/**
 * Lakebase grant provisioning for AppKit and consuming applications.
 *
 * AppKit's persistent cache uses the `appkit` schema. Local development can
 * grant the resolved application role access before AppKit initializes, and
 * consuming applications can add schema-wide or table-specific targets. A
 * schema target is attempted first; explicit tables under it remain fallbacks
 * and run only when the schema-wide transaction cannot be applied.
 *
 * Provisioning never creates schemas or tables. It is skipped inside a
 * Databricks App, where the app service principal cannot grant and its
 * PostgreSQL role does not exist until its first connection.
 *
 * @module
 */

import { createLakebasePool, ValidationError } from "@databricks/appkit";
import { configUtils } from "@dbx-tools/core";
import { postgresConnectionOptions, quotePostgresIdentifier } from "@dbx-tools/postgres";
import { log, isDatabricksAppEnv, parseList, toError, type Logger } from "@dbx-tools/shared-core";
import { z } from "zod";

import { createWorkspaceClient } from "./databricks.ts";

const defaultLogger = log.logger("provision");

/** Logical config key for additional Lakebase provisioning targets. */
export const LAKEBASE_PROVISION_TARGETS_CONFIG_KEY = "APPKIT_LAKEBASE_PROVISION_TARGETS";

/** Targets always provisioned before consuming-application additions. */
export const DEFAULT_LAKEBASE_PROVISION_TARGETS = ["appkit", "mastra_instance"] as const;

const POSTGRES_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

/** A PostgreSQL `schema` or `schema.table` provisioning target. */
export const LakebaseProvisionTargetSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, context) => {
    const identifiers = value.split(".");
    if (
      identifiers.length > 2 ||
      identifiers.some((identifier) => !POSTGRES_IDENTIFIER_PATTERN.test(identifier))
    ) {
      context.addIssue({
        code: "custom",
        message: "Expected a PostgreSQL schema or schema.table target",
      });
    }
  })
  .describe("PostgreSQL schema or schema.table to grant to the resolved application role.");

/** PostgreSQL schema or table provisioning target. */
export type LakebaseProvisionTarget = z.infer<typeof LakebaseProvisionTargetSchema>;

/** Parsed target used by the in-process provisioning plan. */
interface ParsedProvisionTarget {
  /** Original normalized target. */
  readonly value: LakebaseProvisionTarget;
  /** PostgreSQL schema name. */
  readonly schema: string;
  /** PostgreSQL table name, absent for a schema-wide target. */
  readonly table?: string;
}

/**
 * Characters a Lakebase Postgres role can legitimately contain: workspace
 * identities are emails, service principals are UUIDs.
 */
const ROLE_PATTERN = /^[A-Za-z0-9._@+-]{1,255}$/;

/**
 * Provisioning runs at boot as the local developer identity, before any plugin
 * exists, so it is outside AppKit's interceptor chain and inherits no timeout
 * from it. Both bounds are explicit for that reason.
 */
const CONNECT_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 15_000;

function parseTarget(target: string): ParsedProvisionTarget {
  const value = LakebaseProvisionTargetSchema.parse(target);
  const [schema, table] = value.split(".");
  return { value, schema: schema!, ...(table ? { table } : {}) };
}

/**
 * Resolve the built-in AppKit target plus configured and environment targets.
 *
 * The option and `DBX_TOOLS_APPKIT_LAKEBASE_PROVISION_TARGETS` are additive.
 * Exact duplicates are removed. A table under a configured schema remains in
 * the plan as a fallback: provisioning skips it after a successful schema-wide
 * transaction and attempts it only when that broader grant fails.
 */
export function resolveLakebaseProvisionTargets(
  configured?: readonly string[],
): LakebaseProvisionTarget[] {
  const environment = configUtils.list(undefined, LAKEBASE_PROVISION_TARGETS_CONFIG_KEY);
  const normalized = [
    ...DEFAULT_LAKEBASE_PROVISION_TARGETS,
    ...parseList(configured),
    ...environment,
  ].map((target) => LakebaseProvisionTargetSchema.parse(target));
  return [...new Set(normalized)];
}

function validateRole(role: string): void {
  if (!ROLE_PATTERN.test(role)) {
    throw ValidationError.invalidValue("role", role, "a Postgres role name");
  }
}

/**
 * Idempotent grants for one schema or table target.
 *
 * Schema grants include existing and future tables and sequences. A table
 * target grants only that table so it can succeed when the caller owns the
 * table but cannot modify schema-wide privileges.
 */
export function lakebaseGrantStatements(target: string, role: string): readonly string[] {
  validateRole(role);
  const parsed = parseTarget(target);
  const schema = quotePostgresIdentifier(parsed.schema);
  const grantee = quotePostgresIdentifier(role);
  if (parsed.table) {
    const table = `${schema}.${quotePostgresIdentifier(parsed.table)}`;
    return [`GRANT ALL PRIVILEGES ON TABLE ${table} TO ${grantee}`];
  }
  return [
    `GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${grantee}`,
    `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} TO ${grantee}`,
    `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} TO ${grantee}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON TABLES TO ${grantee}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON SEQUENCES TO ${grantee}`,
  ];
}

/** Minimal PostgreSQL client used by the in-process provisioning plan. */
export interface LakebaseProvisionClient {
  /** Execute one parameterized or transaction-control statement. */
  query(text: string, values?: unknown[]): Promise<{ readonly rowCount: number | null }>;
}

async function targetExists(client: LakebaseProvisionClient, target: ParsedProvisionTarget) {
  if (!target.table) {
    const found = await client.query(
      "SELECT 1 FROM information_schema.schemata WHERE schema_name = $1",
      [target.schema],
    );
    return found.rowCount !== 0;
  }
  const found = await client.query(
    "SELECT 1 FROM pg_catalog.pg_class AS table_class JOIN pg_catalog.pg_namespace AS table_schema ON table_schema.oid = table_class.relnamespace WHERE table_schema.nspname = $1 AND table_class.relname = $2 AND table_class.relkind IN ('r', 'p', 'v', 'm', 'f')",
    [target.schema, target.table],
  );
  return found.rowCount !== 0;
}

async function provisionTarget(
  client: LakebaseProvisionClient,
  target: ParsedProvisionTarget,
  role: string,
  logger: Logger,
): Promise<boolean> {
  try {
    if (!(await targetExists(client, target))) {
      logger.debug("autopg: skip absent provisioning target", { target: target.value });
      return false;
    }
    await client.query("BEGIN");
    try {
      for (const sql of lakebaseGrantStatements(target.value, role)) {
        await client.query(sql);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
    logger.info("autopg: granted Lakebase target", { target: target.value, role });
    return true;
  } catch (error) {
    logger.warn("autopg: Lakebase target provisioning failed (continuing)", {
      target: target.value,
      error: toError(error),
    });
    return false;
  }
}

/**
 * Apply a resolved target list through an existing PostgreSQL client.
 *
 * Schema targets run first. Tables under a successfully granted schema are
 * skipped; if the schema transaction fails, those table targets remain
 * independent fallbacks. Missing schemas and tables are debug-logged and
 * skipped without issuing grant statements.
 */
export async function applyLakebaseProvisionTargets(
  client: LakebaseProvisionClient,
  role: string,
  targets: readonly string[],
  logger: Logger = defaultLogger,
): Promise<void> {
  validateRole(role);
  const parsed = [...new Set(targets)].map(parseTarget);
  const schemas = parsed.filter((target) => !target.table);
  const tables = parsed.filter((target) => target.table);
  const provisionedSchemas = new Set<string>();
  for (const target of schemas) {
    if (await provisionTarget(client, target, role, logger)) {
      provisionedSchemas.add(target.schema);
    }
  }
  for (const target of tables) {
    if (provisionedSchemas.has(target.schema)) {
      logger.debug("autopg: skip table covered by schema grant", { target: target.value });
      continue;
    }
    await provisionTarget(client, target, role, logger);
  }
}

/**
 * Grant `role` rights on existing Lakebase schemas and tables.
 *
 * Schema targets run before table targets. A successful schema-wide transaction
 * suppresses its table targets; if it fails, each explicit table is attempted
 * independently. Failures are logged and never block startup.
 *
 * @param role - Postgres role to grant to and connect as; skips when undefined.
 * @param targets - Existing schemas or schema.table targets to grant.
 * @param logger - Logger to report progress on. Defaults to this module's.
 *
 * @example
 * import { provision } from "@dbx-tools/appkit";
 *
 * await provision.provisionLakebaseAccess(
 *   "app-service-principal@databricks.com",
 *   ["appkit", "reporting", "operations.events"],
 * );
 */
export async function provisionLakebaseAccess(
  role: string | undefined,
  targets: readonly string[] = DEFAULT_LAKEBASE_PROVISION_TARGETS,
  logger: Logger = defaultLogger,
): Promise<void> {
  if (isDatabricksAppEnv()) {
    logger.debug("autopg: skip Lakebase provisioning (inside a Databricks App)");
    return;
  }
  if (!role) {
    logger.warn("autopg: skip Lakebase provisioning (could not resolve connecting role)");
    return;
  }
  validateRole(role);

  // Pass `user` explicitly: auto-configuration resolves the connection target
  // (host/database/endpoint) but not the identity, so createLakebasePool's
  // synchronous username lookup would otherwise throw. The auth-backed AppKit
  // client retains dbx-tools profile selection and interactive CLI recovery.
  const workspaceClient = (await createWorkspaceClient()).toLegacyWorkspaceClient();
  const pool = createLakebasePool(
    postgresConnectionOptions({
      user: role,
      workspaceClient,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    }),
  );
  const client = await pool.connect();
  try {
    await applyLakebaseProvisionTargets(client, role, targets, logger);
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}
