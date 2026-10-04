/** Node-native Lakebase PostgreSQL address parsing and local proxy URLs. */

import { object } from "@dbx-tools/shared-core";

export const SSL_MODES = ["require", "disable", "prefer"] as const;
export type SslMode = (typeof SSL_MODES)[number];

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

export type ParsedAddress = LakebaseConnectionInputs;

const URL_SCHEME_RE = /^(postgres|postgresql):\/\//i;
const PROJECT_ID_RE = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOSTNAME_HINT_RE = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/i;

export function parseAddress(input: string | null | undefined): ParsedAddress {
  const value = input?.trim();
  if (!value) return {};
  if (URL_SCHEME_RE.test(value)) return parseUri(value);
  if (value.startsWith("projects/")) return parseResourcePath(value);
  if (HOSTNAME_HINT_RE.test(value)) return { host: value };
  if (PROJECT_ID_RE.test(value)) return { project: value };
  return {};
}

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

export function parseSslMode(input: string | null | undefined): SslMode | undefined {
  const value = input?.trim().toLowerCase();
  return SSL_MODES.find((mode) => mode === value);
}

export function requireAddress(input: string): ParsedAddress {
  const address = parseAddress(input);
  if (Object.keys(address).length === 0) {
    throw new Error(`Lakebase address is not recognized: ${input}`);
  }
  return address;
}

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
