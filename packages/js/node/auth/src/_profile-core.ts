import { AuthError } from "./errors.ts";
import {
  AUTH_TYPE_APP_OBO,
  AUTH_TYPE_APP_SP,
  AuthKind,
  DEFAULT_ACCESS_TOKEN_HEADER,
  TargetKind,
} from "./types.ts";

export const SETTINGS_SECTION = "__settings__";

export type Environment = Readonly<Record<string, string | undefined>>;
export type IniConfig = Map<string, Map<string, string>>;

export interface RawProfile {
  host?: string;
  accountId?: string;
  workspaceId?: string;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  groupId?: string;
  scopes?: string;
  authType?: string;
}

/** Parse Databricks INI text without introducing a runtime parser dependency. */
export function parseDatabricksConfig(source: string): IniConfig {
  const config: IniConfig = new Map();
  let section: Map<string, string> | undefined;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = /^\[([^\]]+)]$/.exec(line);
    if (sectionMatch) {
      const name = sectionMatch[1]!.trim();
      if (!name) throw new AuthError("config", "Databricks profile section must not be empty");
      section = config.get(name) ?? new Map();
      config.set(name, section);
      continue;
    }
    const delimiter = line.indexOf("=");
    if (delimiter < 0 || !section) {
      throw new AuthError("config", `Invalid Databricks configuration line: ${rawLine}`);
    }
    const key = line.slice(0, delimiter).trim().toLowerCase();
    const value = line.slice(delimiter + 1).trim();
    if (!key) throw new AuthError("config", `Invalid Databricks configuration key: ${rawLine}`);
    section.set(key, value);
  }
  return config;
}

export function loadRawProfile(config: IniConfig | undefined, name: string): RawProfile {
  const section = config?.get(name);
  return {
    host: section?.get("host"),
    accountId: section?.get("account_id"),
    workspaceId: section?.get("workspace_id"),
    clientId: section?.get("client_id"),
    clientSecret: section?.get("client_secret"),
    accessToken: section?.get("token"),
    groupId: section?.get("group_id"),
    scopes: section?.get("scopes"),
    authType: nonempty(section?.get("auth_type"))?.toLowerCase(),
  };
}

export function resolveProfileName(
  requested: string | undefined,
  explicit: boolean,
  config: IniConfig | undefined,
  preferUserToMachine: boolean,
): string {
  let selected = requested;
  if (!selected) selected = nonempty(config?.get(SETTINGS_SECTION)?.get("default_profile"));
  if (!selected && config?.has("DEFAULT")) selected = "DEFAULT";
  if (!selected) {
    const profiles = [...(config?.keys() ?? [])].filter((name) => name !== SETTINGS_SECTION);
    if (profiles.length === 1) selected = profiles[0];
  }
  selected ??= "DEFAULT";
  if (selected === SETTINGS_SECTION)
    throw new AuthError("config", `${SETTINGS_SECTION} is reserved`);
  if (explicit || !preferUserToMachine || !config) return selected;
  const current = loadRawProfile(config, selected);
  if (!isM2mProfile(current) || !current.host) return selected;
  const matches = [...config.keys()].filter((name) => {
    if (name === selected || name === SETTINGS_SECTION) return false;
    const candidate = loadRawProfile(config, name);
    return candidate.authType === "databricks-cli" && sameTarget(current, candidate);
  });
  return matches.length === 1 ? matches[0]! : selected;
}

/** Normalize Databricks hosts and require TLS outside loopback development. */
export function normalizeHost(value: string | undefined, profile = "DEFAULT"): string {
  const selected = nonempty(value);
  if (!selected) throw new AuthError("config", `Profile ${profile} has no host`);
  const withScheme = /^https?:\/\//i.test(selected) ? selected : `https://${selected}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch (cause) {
    throw new AuthError("config", `Profile ${profile} has an invalid host`, { cause });
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new AuthError("config", "Databricks host must use HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

export function resolveAuthKind(
  authType: string | undefined,
  clientId: string | undefined,
  clientSecret: string | undefined,
  accessToken: string | undefined,
): AuthKind {
  switch (authType) {
    case "databricks-cli":
    case "oauth-u2m":
      return AuthKind.UserToMachine;
    case "oauth-m2m":
      if (!clientId || !clientSecret)
        throw new AuthError("config", "oauth-m2m requires client_id and client_secret");
      return AuthKind.MachineToMachine;
    case "pat":
      if (!accessToken) throw new AuthError("config", "pat requires token");
      return AuthKind.PersonalAccessToken;
    case AUTH_TYPE_APP_OBO:
    case "app-obo":
      if (!accessToken)
        throw new AuthError("config", "app_obo requires the configured access token header");
      return AuthKind.AppOnBehalfOf;
    case AUTH_TYPE_APP_SP:
    case "app-sp":
      if (!clientId || !clientSecret)
        throw new AuthError("config", "app_sp requires client id and secret");
      return AuthKind.AppServicePrincipal;
    case undefined:
      if (clientId && clientSecret) return AuthKind.MachineToMachine;
      if (clientSecret) throw new AuthError("config", "oauth-m2m client_secret requires client_id");
      return accessToken ? AuthKind.PersonalAccessToken : AuthKind.UserToMachine;
    default:
      throw new AuthError("config", `Authentication type ${authType} is not supported`);
  }
}

export function requestOboToken(
  headers?: Record<string, string>,
  headerName = DEFAULT_ACCESS_TOKEN_HEADER,
): string | undefined {
  const entry = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === headerName.toLowerCase(),
  );
  const value = nonempty(entry?.[1]);
  if (!value) return undefined;
  if (headerName.toLowerCase() !== DEFAULT_ACCESS_TOKEN_HEADER) return value;
  const [scheme, ...parts] = value.split(/\s+/);
  return scheme?.toLowerCase() === "bearer" ? nonempty(parts.join(" ")) : undefined;
}

export function inferTarget(host: string | undefined, accountId: string | undefined): TargetKind {
  if (accountId && host) {
    try {
      if (new URL(normalizeHost(host)).hostname === "accounts.cloud.databricks.com")
        return TargetKind.Account;
    } catch {}
  }
  return TargetKind.Workspace;
}

export function parseTarget(value: string): TargetKind {
  switch (value.trim().toLowerCase()) {
    case TargetKind.Workspace:
      return TargetKind.Workspace;
    case TargetKind.Account:
      return TargetKind.Account;
    case TargetKind.Unified:
      return TargetKind.Unified;
    default:
      throw new AuthError("config", "Target must be workspace, account, or unified");
  }
}

export function cleanList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function nonempty(value: string | undefined): string | undefined {
  const selected = value?.trim();
  return selected ? selected : undefined;
}

export function missing(profile: string, field: string): never {
  throw new AuthError("config", `Profile ${profile} requires ${field}`);
}

function sameTarget(left: RawProfile, right: RawProfile): boolean {
  try {
    if (normalizeHost(left.host) !== normalizeHost(right.host)) return false;
  } catch {
    return false;
  }
  return (
    (!left.accountId || left.accountId === right.accountId) &&
    (!left.workspaceId || left.workspaceId === right.workspaceId)
  );
}

function isM2mProfile(profile: RawProfile): boolean {
  return (
    profile.authType === "oauth-m2m" ||
    (!profile.authType && Boolean(profile.clientId && profile.clientSecret))
  );
}
