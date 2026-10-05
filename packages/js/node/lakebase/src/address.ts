/** Node-native Lakebase PostgreSQL address parsing and local proxy URLs. */

import * as object from "@dbx-tools/shared-core/object";

/** Supported PostgreSQL SSL mode values. */
export const SSL_MODES = ["require", "disable", "prefer"] as const;
/** PostgreSQL SSL mode accepted by Lakebase address helpers. */
export type SslMode = (typeof SSL_MODES)[number];

/** Normalized fields parsed from a Lakebase address. */
export interface LakebaseConnectionInputs {
  project?: string;
  branch?: string;
  endpoint?: string;
  endpointId?: string;
  database?: string;
  databaseResourceId?: string;
  user?: string;
  host?: string;
  port?: number;
  sslMode?: SslMode;
}

/** Parsed Lakebase connection target. */
export type ParsedAddress = LakebaseConnectionInputs;

const URL_SCHEME_RE = /^(postgres|postgresql):\/\//i;
const PROJECT_ID_RE = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOSTNAME_HINT_RE = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/i;

/** Parse a PostgreSQL URL, Lakebase resource path, hostname, or project ID. */
export function parseAddress(input: string | null | undefined): ParsedAddress {
  const value = input?.trim();
  if (!value) return {};
  if (URL_SCHEME_RE.test(value)) return parseUri(value);
  if (value.startsWith("projects/")) return parseResourcePath(value);
  if (HOSTNAME_HINT_RE.test(value)) return { host: value };
  if (PROJECT_ID_RE.test(value)) return { project: value };
  return {};
}

/** Parse a canonical Lakebase project, branch, endpoint, or database path. */
export function parseResourcePath(input: string | null | undefined): ParsedAddress {
  const value = input?.trim();
  if (!value?.startsWith("projects/")) return {};
  const parts = value.split("/");
  const project = parts[1];
  if (!project) return {};
  if (parts.length === 2) return { project };
  const branch = parts[2] === "branches" ? parts[3] : undefined;
  if (!branch) return {};
  if (parts.length === 4) return { project, branch };
  if (parts.length !== 6 || !parts[5]) return {};
  if (parts[4] === "endpoints") {
    return { project, branch, endpoint: value, endpointId: parts[5] };
  }
  if (parts[4] === "databases") {
    return { project, branch, databaseResourceId: parts[5] };
  }
  return {};
}

/** Parse a supported PostgreSQL SSL mode. */
export function parseSslMode(input: string | null | undefined): SslMode | undefined {
  const value = input?.trim().toLowerCase();
  return SSL_MODES.find((mode) => mode === value);
}

/** Parse a Lakebase address or throw when the input is not recognized. */
export function requireAddress(input: string): ParsedAddress {
  const address = parseAddress(input);
  if (Object.keys(address).length === 0) {
    throw new Error(`Lakebase address is not recognized: ${input}`);
  }
  return address;
}

/** Format a local proxy URL whose database path contains the Lakebase target. */
export function connectionUrl(target: string, host = "localhost", port = 5432): string {
  requireAddress(target);
  const url = new URL("postgresql://localhost");
  url.hostname = host;
  url.port = String(port);
  url.pathname = `/${target}`;
  url.searchParams.set("sslmode", "disable");
  return url.toString();
}

function parseUri(value: string): ParsedAddress {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {};
  }
  const target = decode(url.pathname.replace(/^\//, ""));
  const result = target.startsWith("projects/") ? parseResourcePath(target) : {};
  if (url.hostname) result.host = url.hostname;
  const port = object.toNumber(url.port);
  if (port !== undefined) result.port = port;
  if (url.username) result.user = decode(url.username);
  if (target && !result.project) result.database = target;
  result.sslMode = parseSslMode(
    url.searchParams.get("sslmode") ?? url.searchParams.get("sslMode"),
  );
  if (result.sslMode === undefined) delete result.sslMode;
  return result;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
