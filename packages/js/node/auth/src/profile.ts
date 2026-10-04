import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { configUtils } from "@dbx-tools/core";

import { AuthError } from "./errors.ts";
import {
  AUTH_TYPE_APP_OBO,
  AUTH_TYPE_APP_SP,
  AuthKind,
  type DatabricksAuthOptions,
  type DatabricksProfile,
  type DatabricksProfileSummary,
  DEFAULT_ACCESS_TOKEN_HEADER,
  DEFAULT_CLIENT_ID,
  DEFAULT_CONFIG_FILE,
  TargetKind,
} from "./types.ts";

const SETTINGS_SECTION = "__settings__";
const configCache = new Map<string, IniConfig | Error | undefined>();

type Environment = Readonly<Record<string, string | undefined>>;
type IniConfig = Map<string, Map<string, string>>;

interface RawProfile {
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

/** Expand and resolve the selected Databricks CLI configuration path. */
export function resolveConfigFile(
  explicit?: string,
  environment: Environment = process.env,
): string {
  const selected = nonempty(explicit) ?? nonempty(environment.DATABRICKS_CONFIG_FILE) ?? DEFAULT_CONFIG_FILE;
  const expanded = selected === "~" ? homedir() : selected.startsWith("~/") ? resolve(homedir(), selected.slice(2)) : selected;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** Invalidate the process-wide parsed configuration cache after an external write. */
export function invalidateConfigFile(configFile?: string): void {
  configCache.delete(resolveConfigFile(configFile));
}

/** Return whether a named profile exists in the selected configuration. */
export function configProfileExists(profile: string, configFile?: string): boolean {
  if (!profile.trim() || profile === SETTINGS_SECTION) return false;
  return loadConfig(resolveConfigFile(configFile))?.has(profile) ?? false;
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

/** Enumerate secret-free profile metadata from the cached CLI configuration. */
export function listDatabricksProfiles(
  configFile?: string,
  refresh = false,
  environment: Environment = process.env,
): DatabricksProfileSummary[] {
  const path = resolveConfigFile(configFile, environment);
  if (refresh) configCache.delete(path);
  const config = loadConfig(path);
  if (!config) return [];
  return [...config.keys()]
    .filter((name) => name !== SETTINGS_SECTION)
    .map((name) => {
      const profile = loadRawProfile(config, name);
      const host = nonempty(profile.host);
      const accountId = nonempty(profile.accountId);
      return {
        name,
        ...(host ? { host } : {}),
        ...(accountId ? { accountId } : {}),
        ...(nonempty(profile.workspaceId) ? { workspaceId: nonempty(profile.workspaceId) } : {}),
        target: inferTarget(host, accountId),
        authKind: resolveAuthKind(profile.authType, profile.clientId, profile.clientSecret, profile.accessToken),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Resolve options, environment, request headers, and CLI configuration into one profile. */
export function resolveDatabricksProfile(
  options: DatabricksAuthOptions,
  environment: Environment = process.env,
): DatabricksProfile {
  const inApp = configUtils.isDatabricksAppEnv({ ...environment });
  const environmentProfile = nonempty(environment.DATABRICKS_CONFIG_PROFILE);
  const explicitProfile = Boolean(nonempty(options.profile) ?? environmentProfile);
  const requestToken = requestOboToken(options.requestHeaders, options.accessTokenHeader);
  const explicitAuthType = nonempty(options.authType)?.toLowerCase() ?? (!inApp ? nonempty(environment.DATABRICKS_AUTH_TYPE)?.toLowerCase() : undefined);
  const appServicePrincipal = [environment.DATABRICKS_HOST, environment.DATABRICKS_CLIENT_ID, environment.DATABRICKS_CLIENT_SECRET].every(nonempty);
  const selectedAuthType =
    !inApp || explicitProfile || explicitAuthType
      ? explicitAuthType
      : requestToken
        ? AUTH_TYPE_APP_OBO
        : appServicePrincipal
          ? AUTH_TYPE_APP_SP
          : undefined;
  const appAuth = [AUTH_TYPE_APP_OBO, "app-obo", AUTH_TYPE_APP_SP, "app-sp"].includes(selectedAuthType ?? "");
  const ignoreAmbientCredentials = inApp && explicitProfile && !appAuth;
  const configPath = resolveConfigFile(options.configFile, environment);
  const config = loadConfig(configPath);
  const requestedName = nonempty(options.profile) ?? environmentProfile;
  const profileName = resolveProfileName(
    requestedName,
    explicitProfile,
    config,
    options.preferUserToMachine,
  );
  let configured = loadRawProfile(config, profileName);
  if (inApp && !explicitProfile && (configured.authType === "pat" || configured.accessToken)) configured = {};
  const ambient = (name: keyof NodeJS.ProcessEnv): string | undefined =>
    ignoreAmbientCredentials ? undefined : nonempty(environment[name]);
  const host = normalizeHost(options.host ?? ambient("DATABRICKS_HOST") ?? configured.host, profileName);
  const accountId = nonempty(options.accountId) ?? ambient("DATABRICKS_ACCOUNT_ID") ?? nonempty(configured.accountId);
  const workspaceId = nonempty(options.workspaceId) ?? ambient("DATABRICKS_WORKSPACE_ID") ?? nonempty(configured.workspaceId);
  const clientIdValue = nonempty(options.clientId) ?? ambient("DATABRICKS_CLIENT_ID") ?? nonempty(configured.clientId);
  const clientSecret = nonempty(options.clientSecret) ?? ambient("DATABRICKS_CLIENT_SECRET") ?? nonempty(configured.clientSecret);
  const accessToken =
    selectedAuthType === AUTH_TYPE_APP_OBO || selectedAuthType === "app-obo"
      ? requestToken
      : nonempty(options.accessToken) ?? ambient("DATABRICKS_TOKEN") ?? nonempty(configured.accessToken);
  const authType = selectedAuthType ?? (!inApp ? ambient("DATABRICKS_AUTH_TYPE") : undefined) ?? nonempty(configured.authType)?.toLowerCase();
  const authKind = resolveAuthKind(authType, clientIdValue, clientSecret, accessToken);
  const clientId =
    authKind === AuthKind.UserToMachine
      ? clientIdValue ?? DEFAULT_CLIENT_ID
      : authKind === AuthKind.MachineToMachine || authKind === AuthKind.AppServicePrincipal
        ? clientIdValue ?? missing(profileName, "client_id")
        : clientIdValue ?? "";
  const scopes = options.scopes?.length
    ? cleanList(options.scopes)
    : cleanList(configured.scopes?.split(",") ?? ["all-apis"]);
  const target = options.target ? parseTarget(options.target) : inferTarget(host, accountId);
  const groupId = nonempty(options.groupId) ?? ambient("DATABRICKS_GROUP_ID") ?? nonempty(configured.groupId);
  const principal =
    authKind === AuthKind.MachineToMachine || authKind === AuthKind.AppServicePrincipal
      ? clientId
      : profileName;
  const cacheKey = credentialCacheKey({
    name: profileName,
    host,
    accountId,
    workspaceId,
    clientId,
    groupId,
    scopes,
    authKind,
  });
  return {
    name: profileName,
    host,
    ...(accountId ? { accountId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    clientId,
    ...(groupId ? { groupId } : {}),
    scopes,
    target,
    authKind,
    ...(clientSecret ? { clientSecret } : {}),
    ...(accessToken ? { accessToken } : {}),
    cacheKey,
    principal,
  };
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

function loadConfig(path: string): IniConfig | undefined {
  if (configCache.has(path)) {
    const cached = configCache.get(path);
    if (cached instanceof Error) throw cached;
    return cached;
  }
  if (!existsSync(path)) {
    configCache.set(path, undefined);
    return undefined;
  }
  try {
    const config = parseDatabricksConfig(readFileSync(path, "utf8"));
    configCache.set(path, config);
    return config;
  } catch (cause) {
    const error = cause instanceof Error ? cause : new AuthError("config", `Could not read ${path}`, { cause });
    configCache.set(path, error);
    throw error;
  }
}

function loadRawProfile(config: IniConfig | undefined, name: string): RawProfile {
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

function resolveProfileName(
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
  if (selected === SETTINGS_SECTION) throw new AuthError("config", `${SETTINGS_SECTION} is reserved`);
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

function sameTarget(left: RawProfile, right: RawProfile): boolean {
  try {
    if (normalizeHost(left.host) !== normalizeHost(right.host)) return false;
  } catch {
    return false;
  }
  return (!left.accountId || left.accountId === right.accountId) && (!left.workspaceId || left.workspaceId === right.workspaceId);
}

function isM2mProfile(profile: RawProfile): boolean {
  return profile.authType === "oauth-m2m" || (!profile.authType && Boolean(profile.clientId && profile.clientSecret));
}

function resolveAuthKind(
  authType: string | undefined,
  clientId: string | undefined,
  clientSecret: string | undefined,
  accessToken: string | undefined,
): AuthKind {
  switch (authType) {
    case "databricks-cli":
      return AuthKind.UserToMachine;
    case "oauth-m2m":
      if (!clientId || !clientSecret) throw new AuthError("config", "oauth-m2m requires client_id and client_secret");
      return AuthKind.MachineToMachine;
    case "pat":
      if (!accessToken) throw new AuthError("config", "pat requires token");
      return AuthKind.PersonalAccessToken;
    case AUTH_TYPE_APP_OBO:
    case "app-obo":
      if (!accessToken) throw new AuthError("config", "app_obo requires the configured access token header");
      return AuthKind.AppOnBehalfOf;
    case AUTH_TYPE_APP_SP:
    case "app-sp":
      if (!clientId || !clientSecret) throw new AuthError("config", "app_sp requires client id and secret");
      return AuthKind.AppServicePrincipal;
    case undefined:
      if (clientId && clientSecret) return AuthKind.MachineToMachine;
      if (clientSecret) throw new AuthError("config", "oauth-m2m client_secret requires client_id");
      return accessToken ? AuthKind.PersonalAccessToken : AuthKind.UserToMachine;
    default:
      throw new AuthError("config", `Authentication type ${authType} is not supported`);
  }
}

function requestOboToken(headers?: Record<string, string>, headerName = DEFAULT_ACCESS_TOKEN_HEADER): string | undefined {
  const entry = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === headerName.toLowerCase());
  const value = nonempty(entry?.[1]);
  if (!value) return undefined;
  if (headerName.toLowerCase() !== DEFAULT_ACCESS_TOKEN_HEADER) return value;
  const [scheme, ...parts] = value.split(/\s+/);
  return scheme?.toLowerCase() === "bearer" ? nonempty(parts.join(" ")) : undefined;
}

function credentialCacheKey(profile: Pick<DatabricksProfile, "name" | "host" | "accountId" | "workspaceId" | "clientId" | "groupId" | "scopes" | "authKind">): string {
  if (profile.authKind === AuthKind.UserToMachine) return profile.name;
  if (profile.authKind === AuthKind.PersonalAccessToken) return `${profile.name}-pat`;
  if (profile.authKind === AuthKind.AppOnBehalfOf) return `${profile.name}-app-obo`;
  const identity = [profile.host, profile.accountId ?? "", profile.workspaceId ?? "", profile.clientId, profile.groupId ?? "", machineScopes(profile.scopes).join(" ")].join("\0");
  const digest = createHash("sha256").update(identity).digest("hex");
  return `${profile.name}-${profile.authKind === AuthKind.AppServicePrincipal ? "app-sp" : "oauth-m2m"}-${digest}`;
}

export function effectiveScopes(scopes: readonly string[]): string[] {
  return cleanList(["offline_access", ...scopes]);
}

export function machineScopes(scopes: readonly string[]): string[] {
  const values = cleanList(scopes.length ? scopes : ["all-apis"]);
  return [...values].sort();
}

function inferTarget(host: string | undefined, accountId: string | undefined): TargetKind {
  if (accountId && host) {
    try {
      if (new URL(normalizeHost(host)).hostname === "accounts.cloud.databricks.com") return TargetKind.Account;
    } catch {}
  }
  return TargetKind.Workspace;
}

function parseTarget(value: string): TargetKind {
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

function cleanList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function nonempty(value: string | undefined): string | undefined {
  const selected = value?.trim();
  return selected ? selected : undefined;
}

function missing(profile: string, field: string): never {
  throw new AuthError("config", `Profile ${profile} requires ${field}`);
}
