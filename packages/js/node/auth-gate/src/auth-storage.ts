/**
 * Better Auth database selection and migration locking.
 *
 * Callers pass a native AppKit Lakebase pool when available. Otherwise auth
 * uses SQLite in the operating system's application-data directory.
 *
 * @module
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileLock } from "@dbx-tools/core";
import { advisoryLock, type PgPoolLike } from "@dbx-tools/postgres";
import { log } from "@dbx-tools/shared-core";
import type { BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import envPaths from "env-paths";
import { z } from "zod";

const logger = log.logger("auth:storage");

export const AuthStorageModeSchema = z
  .enum(["auto", "lakebase", "sqlite"])
  .describe("Supported persistence choices for Better Auth state.");

export const AuthStorageConfigSchema = z
  .object({
    storage: AuthStorageModeSchema.optional().describe("Authentication storage mode."),
    sqlitePath: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Optional local SQLite database path."),
  })
  .strict()
  .describe("Caller-selected authentication storage configuration.");

export type AuthStorageMode = z.infer<typeof AuthStorageModeSchema>;

export type AuthStorageConfig = z.input<typeof AuthStorageConfigSchema>;

/** Authentication storage configuration after defaults and path resolution. */
export interface ResolvedAuthStorageConfig {
  mode: AuthStorageMode;
  sqlitePath: string;
}

/** Database adapter value accepted by Better Auth. */
export type AuthDatabase = NonNullable<BetterAuthOptions["database"]>;

/** Open authentication storage backend and its cleanup lifecycle. */
export interface AuthStorage {
  kind: "lakebase" | "sqlite" | "memory";
  database: AuthDatabase;
  pool?: PgPoolLike;
  path?: string;
  close(): Promise<void>;
}

interface SqliteDatabase {
  exec(sql: string): unknown;
  close(): void;
}

interface BunSqliteModule {
  Database: new (path: string, options?: { create?: boolean; strict?: boolean }) => SqliteDatabase;
}

const MIGRATION_LOCK = ["auth", "better-auth", "migrations"] as const;

/** Resolve explicit or environment-driven authentication storage settings. */
export function resolveAuthStorageConfig(
  config: AuthStorageConfig = {},
): ResolvedAuthStorageConfig {
  const parsed = AuthStorageConfigSchema.parse({
    storage: config.storage,
    sqlitePath: config.sqlitePath,
  });
  const mode = parsed.storage ?? "auto";
  const dataDirectory = envPaths("dbx-tools", { suffix: "" }).data;
  return {
    mode,
    sqlitePath: resolve(parsed.sqlitePath ?? resolve(dataDirectory, "auth", "auth.sqlite")),
  };
}

/** Return whether the resolved authentication storage uses Lakebase. */
export function shouldUseLakebase(config: AuthStorageConfig = {}): boolean {
  const resolved = resolveAuthStorageConfig(config);
  if (resolved.mode === "lakebase") return true;
  if (resolved.mode === "sqlite") return false;
  return Boolean(process.env.LAKEBASE_ENDPOINT ?? process.env.PGHOST);
}

/** Create the configured Better Auth storage backend. */
export async function createAuthStorage(
  config: AuthStorageConfig,
  pool?: PgPoolLike,
): Promise<AuthStorage> {
  const resolved = resolveAuthStorageConfig(config);
  if (pool && resolved.mode !== "sqlite") {
    return {
      kind: "lakebase",
      database: pool,
      pool,
      close: async () => undefined,
    };
  }
  if (resolved.mode === "lakebase") {
    throw new Error("auth storage is lakebase but no Lakebase pool was supplied");
  }

  // Prefer SQLite (durable, survives restarts) when a SQLite binding is present
  // — bun:sqlite in Bun, node:sqlite in Node. Both are optional runtime
  // features, so fall back to an in-memory adapter when neither can be opened
  // rather than failing the whole gate. Memory loses sessions/OTPs on restart
  // but keeps sign-in working; an explicit `--auth-storage sqlite` still errors
  // if SQLite is genuinely unavailable, so the fallback is auto-mode only.
  try {
    mkdirSync(dirname(resolved.sqlitePath), { recursive: true });
    const database = await openSqlite(resolved.sqlitePath);
    return {
      kind: "sqlite",
      database,
      path: resolved.sqlitePath,
      close: async () => {
        database.close();
      },
    };
  } catch (error) {
    if (resolved.mode === "sqlite") throw error;
    logger.warn("sqlite unavailable for auth storage; using in-memory adapter", { error });
    const { memoryAdapter } = await import("better-auth/adapters/memory");
    return {
      kind: "memory",
      database: memoryAdapter({}) as unknown as AuthDatabase,
      close: async () => undefined,
    };
  }
}

/** Apply Better Auth migrations to persistent authentication storage. */
export async function migrateAuth(options: BetterAuthOptions, storage: AuthStorage): Promise<void> {
  // The in-memory adapter builds its schema in memory on init — there is no
  // database to migrate.
  if (storage.kind === "memory") return;

  const run = async (): Promise<void> => {
    const migrations = await getMigrations(options);
    await migrations.runMigrations();
  };

  if (storage.kind === "lakebase" && storage.pool) {
    await advisoryLock.withAdvisoryLock(storage.pool, MIGRATION_LOCK, run);
    return;
  }
  await fileLock.withFileLock(MIGRATION_LOCK, run);
}

async function openSqlite(path: string): Promise<AuthDatabase & { close(): void }> {
  if (process.versions.bun) {
    const specifier = "bun:sqlite";
    const { Database } = (await import(specifier)) as BunSqliteModule;
    const database = new Database(path, { create: true, strict: true });
    database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON");
    return database;
  }
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON");
  return database;
}
