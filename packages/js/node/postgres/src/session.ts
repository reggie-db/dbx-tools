/**
 * Shared PostgreSQL session configuration.
 *
 * @module
 */
import {
  postgresEnvironmentNames,
  postgresRoleSchema,
} from "@dbx-tools/shared-core/options";

/** Pool/client options required to set PostgreSQL startup parameters. */
export interface PostgresConnectionOptions {
  options?: string;
}

/** Resolve and validate an explicit or environment-provided PostgreSQL role. */
export function resolvePostgresRole(
  role?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return postgresRoleSchema.optional().parse(
    role ?? environment[postgresEnvironmentNames.postgresRole],
  );
}

/** Quote one PostgreSQL identifier. */
export function quotePostgresIdentifier(value: string): string {
  if (value.includes("\0")) throw new TypeError("PostgreSQL identifiers cannot contain NUL");
  return `"${value.replaceAll('"', '""')}"`;
}

/** Build a `SET ROLE` statement, or `undefined` when no role is configured. */
export function postgresRoleStatement(role?: string): string | undefined {
  const resolved = resolvePostgresRole(role);
  return resolved ? `SET ROLE ${quotePostgresIdentifier(resolved)}` : undefined;
}

/** Merge the configured role into asyncpg-compatible server settings. */
export function postgresServerSettings(
  role?: string,
  settings: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const resolved = resolvePostgresRole(role);
  return resolved ? { ...settings, role: resolved } : { ...settings };
}

/** Merge the configured role into `pg` startup options. */
export function postgresConnectionOptions<T extends object>(
  options: T,
  role?: string,
): T & PostgresConnectionOptions {
  const resolved = resolvePostgresRole(role);
  if (!resolved) return options;
  const connectionOptions = options as T & PostgresConnectionOptions;
  const configured = connectionOptions.options?.trim();
  const roleOption = `-c role=${resolved}`;
  return {
    ...options,
    options: configured ? `${configured} ${roleOption}` : roleOption,
  };
}
