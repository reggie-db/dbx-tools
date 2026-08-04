/**
 * Reading configuration out of the environment.
 *
 * Every plugin config in this repo resolves the same way: take the typed
 * config value when the caller set one, else fall back to one or more
 * environment variables, else a default. Written by hand that becomes a
 * `config.x ?? Number(process.env.X)` chain per field, and each package grew
 * its own `fromEnv` / `resolvePositiveInt` helper with slightly different
 * coercion rules. These are those helpers, once.
 *
 * Browser-safe: `process` is reached through `globalThis` and guarded, so this
 * module needs no Node types and is inert in a browser (every lookup misses and
 * the caller's fallback applies).
 *
 * @module
 */

import { toBoolean, toNumber } from "./object.ts";
import { parseList, trimToNull } from "./string.ts";

/** `process`-shaped view off `globalThis`, so no node types are needed. */
interface ProcessLike {
  env?: Record<string, string | undefined>;
}

/** Highest valid TCP port number. */
export const MAX_TCP_PORT = 65_535;

/** One env var name, or several tried in order. */
export type EnvKey = string | readonly string[];

/** The ambient environment, or `{}` off-process (a browser). */
function environment(): Record<string, string | undefined> {
  return (globalThis as { process?: ProcessLike }).process?.env ?? {};
}

/**
 * Detect the Databricks App runtime from its required environment shape.
 *
 * A valid app has a non-empty name, an HTTP(S) workspace host, and a valid
 * `DATABRICKS_APP_PORT`. Reads the ambient environment when none is supplied.
 */
export function isAppEnv(source: Record<string, string | undefined> = environment()): boolean {
  const appName = source.DATABRICKS_APP_NAME?.trim();
  const host = source.DATABRICKS_HOST?.trim();
  const port = source.DATABRICKS_APP_PORT?.trim();
  if (!appName || !host || !port) return false;

  try {
    if (!["http:", "https:"].includes(new URL(host).protocol)) return false;
  } catch {
    return false;
  }

  const portNumber = toNumber(port);
  return (
    portNumber !== undefined &&
    Number.isInteger(portNumber) &&
    portNumber >= 1 &&
    portNumber <= MAX_TCP_PORT
  );
}

/**
 * The PRIMARY (current, non-deprecated) name in an {@link EnvKey}.
 *
 * Use this when naming a variable in a log line or error rather than indexing
 * `keys[0]`: an {@link EnvKey} may be a bare string, and `"TUNNEL_X"[0]` is the
 * character `"T"`, which produces a message naming a variable that does not
 * exist. Returns `""` only for an empty list, which no caller should have.
 *
 * @example
 * logger.warn(`${env.name(JWT_SECRET_ENV)} is not set`);
 */
export function name(keys: EnvKey): string {
  return typeof keys === "string" ? keys : (keys[0] ?? "");
}

/**
 * First non-empty value among `keys`, trimmed, else `null`.
 *
 * Several names for one setting is the norm (a package-specific variable plus
 * the Databricks-standard one), so `keys` is order-sensitive: earlier names win.
 *
 * @example
 * env.text(["TEAMS_APP_ID", "MICROSOFT_APP_ID"]);
 */
export function text(keys: EnvKey): string | null {
  const env = environment();
  for (const key of typeof keys === "string" ? [keys] : keys) {
    const value = trimToNull(env[key]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Resolve a string setting: `configured` when set and non-empty, else the first
 * non-empty variable among `keys`, else `null`.
 *
 * @example
 * env.string(config.host, "SMTP_HOST");
 */
export function string(configured: unknown, keys: EnvKey): string | null {
  return trimToNull(configured) ?? text(keys);
}

/**
 * Resolve a boolean setting through {@link toBoolean}, so the loose spellings an
 * env var actually carries (`1`, `on`, `yes`, ...) are accepted. Returns
 * `undefined` when neither source is interpretable, letting the caller pick a
 * default with `??`.
 *
 * @example
 * env.boolean(config.fuzzy, "WEB_SEARCH_FUZZY") ?? true;
 */
export function boolean(configured: unknown, keys: EnvKey): boolean | undefined {
  return toBoolean(configured) ?? toBoolean(text(keys));
}

/**
 * Resolve a positive-number setting that may be fractional (a score threshold,
 * a ratio): `configured` when it is a finite number greater than zero, else the
 * first variable among `keys` that parses that way, else `fallback`.
 *
 * {@link positiveInt} is the right choice for a count; this one keeps the
 * fraction, so a `0.4` threshold does not floor to `0`.
 *
 * @example
 * env.positiveNumber(config.fuzzyThreshold, "SEARCH_FUZZY_THRESHOLD", 0.4);
 */
export function positiveNumber(configured: unknown, keys: EnvKey, fallback: number): number {
  return toPositiveNumber(configured) ?? toPositiveNumber(text(keys)) ?? fallback;
}

/**
 * Resolve a positive-integer setting (a port, timeout, page size, or cap):
 * `configured` when it is a finite number greater than zero, else the first
 * variable among `keys` that parses that way, else `fallback`. Floored, so a
 * fractional value can't leak into a count.
 *
 * A non-numeric or non-positive value is treated as absent rather than fatal -
 * these are ceilings and timeouts where a sane default beats a boot failure.
 *
 * @example
 * env.positiveInt(config.timeoutMs, "SEARCH_TIMEOUT_MS", 30_000);
 */
export function positiveInt(configured: unknown, keys: EnvKey, fallback: number): number {
  return toPositiveInt(configured) ?? toPositiveInt(text(keys)) ?? fallback;
}

function toPositiveNumber(value: unknown): number | undefined {
  const parsed = toNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function toPositiveInt(value: unknown): number | undefined {
  const parsed = toPositiveNumber(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

/**
 * Resolve a list setting through {@link parseList}, so an array from typed
 * config and a `"a, b c"` env string normalize identically. Returns `[]` when
 * neither source has entries.
 *
 * @example
 * env.list(config.modelFallbacks, "WEB_SEARCH_MODEL_FALLBACKS");
 */
export function list(
  configured: string | readonly string[] | undefined | null,
  keys: EnvKey,
  transform?: (entry: string) => string,
): string[] {
  const fromConfig = parseList(configured, transform);
  return fromConfig.length > 0 ? fromConfig : parseList(text(keys), transform);
}
