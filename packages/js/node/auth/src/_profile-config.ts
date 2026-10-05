import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { AuthType, TargetKind } from "@dbx-tools/shared-auth/config";
import type { DatabricksProfileSummary } from "@dbx-tools/shared-auth/profile";
import * as environmentUtils from "@dbx-tools/shared-core/environment-utils";
import * as object from "@dbx-tools/shared-core/object";
import * as stringUtils from "@dbx-tools/shared-core/string-utils";
import { trimToUndefined } from "@dbx-tools/shared-core/string-utils";
import { parse as parseIni } from "ini";

import { AuthError } from "./_errors.ts";
import { authLogger } from "./_logging.ts";
import type { DatabricksProfile } from "./_types.ts";
import {
  type DatabricksAuthOptions,
  DEFAULT_ACCESS_TOKEN_HEADER,
  DEFAULT_CLIENT_ID,
  DEFAULT_CONFIG_FILE,
} from "./config.ts";

const logger = authLogger("profile-selection");
const configCache = new Map<string, IniConfig | Error | undefined>();

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

/** Resolve the selected Databricks configuration path. */
export function resolveConfigFile(
  explicit?: string,
  environment: Environment = process.env,
): string {
  const selected =
    trimToUndefined(explicit) ??
    trimToUndefined(environment.DATABRICKS_CONFIG_FILE) ??
    DEFAULT_CONFIG_FILE;
  const expanded =
    selected === "~"
      ? homedir()
      : selected.startsWith("~/")
        ? resolve(homedir(), selected.slice(2))
        : selected;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** Load and cache the selected Databricks configuration. */
export function loadConfig(
  configFile?: string,
  refresh = false,
  environment: Environment = process.env,
): IniConfig | undefined {
  const path = resolveConfigFile(configFile, environment);
  if (refresh) configCache.delete(path);
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
    const error =
      cause instanceof Error ? cause : new AuthError("config", `Could not read ${path}`, { cause });
    configCache.set(path, error);
    throw error;
  }
}

/** Invalidate cached configuration after an external write. */
export function invalidateConfigFile(configFile?: string): void {
  configCache.delete(resolveConfigFile(configFile));
}

/** Parse Databricks INI text through the maintained `ini` package. */
export function parseDatabricksConfig(source: string): IniConfig {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseIni(source) as Record<string, unknown>;
  } catch (cause) {
    throw new AuthError("config", "Databricks configuration is not valid INI", { cause });
  }
  const config: IniConfig = new Map();
  for (const [name, value] of Object.entries(parsed)) {
    if (!name.trim() || !object.isRecord(value)) {
      throw new AuthError("config", "Databricks configuration values must belong to a profile");
    }
    const section = new Map<string, string>();
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined || entry === null) continue;
      section.set(key.trim().toLowerCase(), String(entry).trim());
    }
    config.set(name.trim(), section);
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
    authType: trimToUndefined(section?.get("auth_type"))?.toLowerCase(),
  };
}

export function resolveProfileName(
  requested: string | undefined,
  explicit: boolean,
  config: IniConfig | undefined,
  preferUserToMachine: boolean,
): string {
  let selected = requested;
  let source = requested ? "requested" : undefined;
  if (!selected) {
    selected = trimToUndefined(config?.get(SETTINGS_SECTION)?.get("default_profile"));
    if (selected) source = "settings-default";
  }
  if (!selected && config?.has("DEFAULT")) {
    selected = "DEFAULT";
    source = "default-section";
  }
  if (!selected) {
    const profiles = [...(config?.keys() ?? [])].filter((name) => name !== SETTINGS_SECTION);
    if (profiles.length === 1) {
      selected = profiles[0];
      source = "sole-profile";
    }
  }
  if (!selected) {
    selected = "DEFAULT";
    source = "fallback";
  }
  if (selected === SETTINGS_SECTION) {
    throw new AuthError("config", `${SETTINGS_SECTION} is reserved`);
  }
  if (explicit || !preferUserToMachine || !config) {
    logger.debug("selected Databricks profile", {
      profile: selected,
      source,
      explicit,
      preferUserToMachine,
    });
    return selected;
  }
  const current = loadRawProfile(config, selected);
  if (!isM2mProfile(current) || !current.host) {
    logger.debug("selected Databricks profile", {
      profile: selected,
      source,
      explicit,
      preferUserToMachine,
    });
    return selected;
  }
  const matches = [...config.keys()].filter((name) => {
    if (name === selected || name === SETTINGS_SECTION) return false;
    const candidate = loadRawProfile(config, name);
    return candidate.authType === "databricks-cli" && sameTarget(current, candidate);
  });
  const preferred = matches.length === 1 ? matches[0]! : selected;
  logger.debug("selected Databricks profile", {
    profile: preferred,
    source: preferred === selected ? source : "matching-cli-profile",
    originalProfile: preferred === selected ? undefined : selected,
    explicit,
    preferUserToMachine,
    matchingCliProfiles: matches.length,
  });
  return preferred;
}

/** Normalize Databricks hosts and require TLS outside loopback development. */
export function normalizeHost(value: string | undefined, profile = "DEFAULT"): string {
  const selected = trimToUndefined(value);
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

export function resolveAuthType(
  authType: AuthType | undefined,
  clientId: string | undefined,
  clientSecret: string | undefined,
  accessToken: string | undefined,
): AuthType {
  switch (authType) {
    case AuthType.DatabricksCli:
      return AuthType.DatabricksCli;
    case AuthType.OAuthM2M:
      if (!clientId || !clientSecret) {
        throw new AuthError("config", "oauth-m2m requires client_id and client_secret");
      }
      return AuthType.OAuthM2M;
    case AuthType.PersonalAccessToken:
      if (!accessToken) throw new AuthError("config", "pat requires token");
      return AuthType.PersonalAccessToken;
    case AuthType.AppOnBehalfOf:
      if (!accessToken) {
        throw new AuthError("config", "app_obo requires the configured access token header");
      }
      return AuthType.AppOnBehalfOf;
    case AuthType.AppServicePrincipal:
      if (!clientId || !clientSecret) {
        throw new AuthError("config", "app_sp requires client id and secret");
      }
      return AuthType.AppServicePrincipal;
    case undefined:
      if (clientId && clientSecret) return AuthType.OAuthM2M;
      if (clientSecret) throw new AuthError("config", "oauth-m2m client_secret requires client_id");
      return accessToken ? AuthType.PersonalAccessToken : AuthType.DatabricksCli;
  }
}

/** Parse one external auth-type value into the canonical enum. */
export function parseAuthType(value: string | undefined): AuthType | undefined {
  const selected = trimToUndefined(value)?.toLowerCase();
  if (selected === undefined) return undefined;
  if (Object.values(AuthType).includes(selected as AuthType)) return selected as AuthType;
  throw new AuthError("config", `Authentication type ${selected} is not supported`);
}

export function requestOboToken(
  headers?: Record<string, string>,
  headerName = DEFAULT_ACCESS_TOKEN_HEADER,
): string | undefined {
  const entry = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === headerName.toLowerCase(),
  );
  const value = trimToUndefined(entry?.[1]);
  if (!value) return undefined;
  if (headerName.toLowerCase() !== DEFAULT_ACCESS_TOKEN_HEADER) return value;
  const [scheme, ...parts] = value.split(/\s+/);
  return scheme?.toLowerCase() === "bearer" ? trimToUndefined(parts.join(" ")) : undefined;
}

export function inferTarget(host: string | undefined, accountId: string | undefined): TargetKind {
  if (accountId && host) {
    try {
      if (new URL(normalizeHost(host)).hostname === "accounts.cloud.databricks.com") {
        return TargetKind.Account;
      }
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
    profile.authType === AuthType.OAuthM2M ||
    (!profile.authType && Boolean(profile.clientId && profile.clientSecret))
  );
}

/** Enumerate secret-free profile metadata from cached configuration. */
export function listDatabricksProfiles(
  configFile?: string,
  refresh = false,
  environment: Environment = process.env,
): DatabricksProfileSummary[] {
  const path = resolveConfigFile(configFile, environment);
  const config = loadConfig(configFile, refresh, environment);
  if (!config) {
    logger.debug("listed Databricks profiles", { path, refresh, count: 0 });
    return [];
  }
  const profiles = [...config.keys()]
    .filter((name) => name !== SETTINGS_SECTION)
    .map((name) => {
      const profile = loadRawProfile(config, name);
      const host = stringUtils.trimToUndefined(profile.host);
      const accountId = stringUtils.trimToUndefined(profile.accountId);
      const workspaceId = stringUtils.trimToUndefined(profile.workspaceId);
      const authType = resolveAuthType(
        parseAuthType(profile.authType),
        profile.clientId,
        profile.clientSecret,
        profile.accessToken,
      );
      return {
        name,
        ...(host ? { host } : {}),
        ...(accountId ? { accountId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        target: inferTarget(host, accountId),
        authType,
        principal:
          authType === AuthType.OAuthM2M || authType === AuthType.AppServicePrincipal
            ? (stringUtils.trimToUndefined(profile.clientId) ?? name)
            : name,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  logger.debug("listed Databricks profiles", { path, refresh, count: profiles.length });
  return profiles;
}

/** Resolve options, environment, request headers, and configuration into credentials. */
export function resolveDatabricksProfile(
  options: DatabricksAuthOptions,
  environment: Environment = process.env,
): DatabricksProfile {
  const inApp = environmentUtils.isDatabricksAppEnv({ ...environment });
  const environmentProfile = stringUtils.trimToUndefined(environment.DATABRICKS_CONFIG_PROFILE);
  const explicitProfile = Boolean(
    stringUtils.trimToUndefined(options.profile) ?? environmentProfile,
  );
  const requestToken = requestOboToken(options.requestHeaders, options.accessTokenHeader);
  const explicitAuthType =
    options.authType ??
    (!inApp && !explicitProfile ? parseAuthType(environment.DATABRICKS_AUTH_TYPE) : undefined);
  const appServicePrincipal = [
    environment.DATABRICKS_HOST,
    environment.DATABRICKS_CLIENT_ID,
    environment.DATABRICKS_CLIENT_SECRET,
  ].every((value) => Boolean(stringUtils.trimToUndefined(value)));
  const selectedAuthType =
    !inApp || explicitProfile || explicitAuthType
      ? explicitAuthType
      : requestToken
        ? AuthType.AppOnBehalfOf
        : appServicePrincipal
          ? AuthType.AppServicePrincipal
          : undefined;
  const appAuth =
    selectedAuthType === AuthType.AppOnBehalfOf ||
    selectedAuthType === AuthType.AppServicePrincipal;
  const ignoreAmbientCredentials = explicitProfile && !appAuth;
  const configPath = resolveConfigFile(options.configFile, environment);
  const config = loadConfig(options.configFile, false, environment);
  const requestedName = stringUtils.trimToUndefined(options.profile) ?? environmentProfile;
  const profileName = resolveProfileName(
    requestedName,
    explicitProfile,
    config,
    options.preferUserToMachine ?? true,
  );
  const ambientCredentials = [
    options.accessToken,
    options.clientId,
    options.clientSecret,
    environment.DATABRICKS_TOKEN,
    environment.DATABRICKS_CLIENT_ID,
    environment.DATABRICKS_CLIENT_SECRET,
  ].some((value) => Boolean(stringUtils.trimToUndefined(value)));
  const selectedProfile =
    explicitProfile || (!ambientCredentials && config?.has(profileName)) ? profileName : undefined;
  const configured = loadRawProfile(config, profileName);
  const ambient = (name: keyof NodeJS.ProcessEnv): string | undefined =>
    ignoreAmbientCredentials ? undefined : stringUtils.trimToUndefined(environment[name]);
  const host = normalizeHost(
    options.host ?? ambient("DATABRICKS_HOST") ?? configured.host,
    profileName,
  );
  const accountId =
    stringUtils.trimToUndefined(options.accountId) ??
    ambient("DATABRICKS_ACCOUNT_ID") ??
    stringUtils.trimToUndefined(configured.accountId);
  const workspaceId =
    stringUtils.trimToUndefined(options.workspaceId) ??
    ambient("DATABRICKS_WORKSPACE_ID") ??
    stringUtils.trimToUndefined(configured.workspaceId);
  const clientIdValue =
    stringUtils.trimToUndefined(options.clientId) ??
    ambient("DATABRICKS_CLIENT_ID") ??
    stringUtils.trimToUndefined(configured.clientId);
  const clientSecret =
    stringUtils.trimToUndefined(options.clientSecret) ??
    ambient("DATABRICKS_CLIENT_SECRET") ??
    stringUtils.trimToUndefined(configured.clientSecret);
  const accessToken =
    selectedAuthType === AuthType.AppOnBehalfOf
      ? requestToken
      : (stringUtils.trimToUndefined(options.accessToken) ??
        ambient("DATABRICKS_TOKEN") ??
        stringUtils.trimToUndefined(configured.accessToken));
  const configuredAuthType =
    selectedAuthType ??
    parseAuthType(ambient("DATABRICKS_AUTH_TYPE")) ??
    parseAuthType(configured.authType);
  const authType = resolveAuthType(configuredAuthType, clientIdValue, clientSecret, accessToken);
  const clientId =
    authType === AuthType.DatabricksCli
      ? (clientIdValue ?? DEFAULT_CLIENT_ID)
      : authType === AuthType.OAuthM2M || authType === AuthType.AppServicePrincipal
        ? (clientIdValue ?? missing(profileName, "client_id"))
        : (clientIdValue ?? "");
  const scopes = options.scopes?.length
    ? stringUtils.parseList(options.scopes)
    : stringUtils.parseList(configured.scopes?.split(",") ?? ["all-apis"]);
  const target = options.target ? parseTarget(options.target) : inferTarget(host, accountId);
  const groupId =
    stringUtils.trimToUndefined(options.groupId) ??
    ambient("DATABRICKS_GROUP_ID") ??
    stringUtils.trimToUndefined(configured.groupId);
  const principal =
    authType === AuthType.OAuthM2M || authType === AuthType.AppServicePrincipal
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
    authType,
    accessToken,
  });
  logger.debug("resolved Databricks profile", {
    profile: profileName,
    host,
    authType,
    target,
    inApp,
    explicitProfile,
    configuredAuthType: configuredAuthType ?? "automatic",
    hasAccountId: Boolean(accountId),
    hasWorkspaceId: Boolean(workspaceId),
    hasGroupId: Boolean(groupId),
    scopeCount: scopes.length,
    configPath,
  });
  return {
    name: profileName,
    ...(selectedProfile ? { selectedProfile } : {}),
    host,
    ...(accountId ? { accountId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    clientId,
    ...(groupId ? { groupId } : {}),
    scopes,
    target,
    authType,
    ...(clientSecret ? { clientSecret } : {}),
    ...(accessToken ? { accessToken } : {}),
    cacheKey,
    principal,
  };
}

/** Normalize OAuth scopes for machine credentials. */
export function machineScopes(scopes: readonly string[]): string[] {
  return stringUtils.parseList(scopes.length ? scopes : ["all-apis"]).sort();
}

function credentialCacheKey(
  profile: Pick<
    DatabricksProfile,
    | "name"
    | "host"
    | "accountId"
    | "workspaceId"
    | "clientId"
    | "groupId"
    | "scopes"
    | "authType"
    | "accessToken"
  >,
): string {
  if (profile.authType === AuthType.DatabricksCli) return profile.name;
  if (profile.authType === AuthType.PersonalAccessToken) {
    const digest = createHash("sha256")
      .update(profile.accessToken ?? "")
      .digest("hex");
    return `${profile.name}-pat-${digest}`;
  }
  if (profile.authType === AuthType.AppOnBehalfOf) return `${profile.name}-app-obo`;
  const identity = [
    profile.host,
    profile.accountId ?? "",
    profile.workspaceId ?? "",
    profile.clientId,
    profile.groupId ?? "",
    machineScopes(profile.scopes).join(" "),
  ].join("\0");
  const digest = createHash("sha256").update(identity).digest("hex");
  return `${profile.name}-${profile.authType === AuthType.AppServicePrincipal ? "app-sp" : "oauth-m2m"}-${digest}`;
}
