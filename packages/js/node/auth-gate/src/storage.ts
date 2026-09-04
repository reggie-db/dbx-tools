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
import envPaths from "env-paths";

const logger = log.logger("auth:storage");

export type AuthStorageMode = "auto" | "lakebase" | "sqlite";

export interface AuthStorageConfig {
  storage?: AuthStorageMode;
  sqlitePath?: string;
}

export interface ResolvedAuthStorageConfig {
  mode: AuthStorageMode;
  sqlitePath: string;
}

export type AuthDatabase = NonNullable<BetterAuthOptions["database"]>;

export interface AuthStorage {
  kind: "lakebase" | "sqlite" | "memory";
  database: AuthDatabase;
  pool?: PgPoolLike;
  path?: string;
  close(): Promise<void>;
}

type MigrationModule = {
  getMigrations(options: BetterAuthOptions): Promise<{
    runMigrations(): Promise<void>;
  }>;
};

interface SqliteDatabase {
  exec(sql: string): unknown;
  close(): void;
}

interface BunSqliteModule {
  Database: new (path: string, options?: { create?: boolean; strict?: boolean }) => SqliteDatabase;
}

const MIGRATION_LOCK = ["auth", "better-auth", "migrations"] as const;

export function resolveAuthStorageConfig(
  config: AuthStorageConfig = {},
): ResolvedAuthStorageConfig {
  const mode = config.storage ?? "auto";
  if (mode !== "auto" && mode !== "lakebase" && mode !== "sqlite") {
    throw new TypeError('auth storage must be "auto", "lakebase", or "sqlite"');
  }
  const dataDirectory = envPaths("dbx-tools", { suffix: "" }).data;
  return {
    mode,
    sqlitePath: resolve(config.sqlitePath ?? resolve(dataDirectory, "auth", "auth.sqlite")),
  };
}

export function shouldUseLakebase(config: AuthStorageConfig = {}): boolean {
  const resolved = resolveAuthStorageConfig(config);
  if (resolved.mode === "lakebase") return true;
  if (resolved.mode === "sqlite") return false;
  return Boolean(process.env.LAKEBASE_ENDPOINT ?? process.env.PGHOST);
}

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

export async function migrateAuth(options: BetterAuthOptions, storage: AuthStorage): Promise<void> {
  // The in-memory adapter builds its schema in memory on init — there is no
  // database to migrate.
  if (storage.kind === "memory") return;

  const run = async (): Promise<void> => {
    const module = (await import(migrationModuleUrl())) as MigrationModule;
    const migrations = await module.getMigrations(options);
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

function migrationModuleUrl(): string {
  const entry = import.meta.resolve("better-auth");
  return new URL("./db/get-migration.mjs", entry).href;
}
