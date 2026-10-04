import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import * as environmentUtils from "@dbx-tools/shared-core/environment-utils";

import { AuthError } from "./errors.ts";
import {
  cleanList,
  type Environment,
  inferTarget,
  type IniConfig,
  loadRawProfile,
  missing,
  nonempty,
  normalizeHost,
  parseDatabricksConfig,
  parseTarget,
  requestOboToken,
  resolveAuthKind,
  resolveProfileName,
  SETTINGS_SECTION,
} from "./_profile-core.ts";
import {
  AUTH_TYPE_APP_OBO,
  AUTH_TYPE_APP_SP,
  AuthKind,
  type DatabricksAuthOptions,
  type DatabricksProfile,
  type DatabricksProfileSummary,
  DEFAULT_CLIENT_ID,
  DEFAULT_CONFIG_FILE,
} from "./types.ts";

const configCache = new Map<string, IniConfig | Error | undefined>();

export { normalizeHost, parseDatabricksConfig } from "./_profile-core.ts";

/** Expand and resolve the selected Databricks CLI configuration path. */
export function resolveConfigFile(
  explicit?: string,
  environment: Environment = process.env,
): string {
  const selected =
    nonempty(explicit) ?? nonempty(environment.DATABRICKS_CONFIG_FILE) ?? DEFAULT_CONFIG_FILE;
  const expanded =
    selected === "~"
      ? homedir()
      : selected.startsWith("~/")
        ? resolve(homedir(), selected.slice(2))
        : selected;
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
        authKind: resolveAuthKind(
          profile.authType,
          profile.clientId,
          profile.clientSecret,
          profile.accessToken,
        ),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Resolve options, environment, request headers, and CLI configuration into one profile. */
export function resolveDatabricksProfile(
  options: DatabricksAuthOptions,
  environment: Environment = process.env,
): DatabricksProfile {
  const inApp = environmentUtils.isDatabricksAppEnv({ ...environment });
  const environmentProfile = nonempty(environment.DATABRICKS_CONFIG_PROFILE);
  const explicitProfile = Boolean(nonempty(options.profile) ?? environmentProfile);
  const requestToken = requestOboToken(options.requestHeaders, options.accessTokenHeader);
  const explicitAuthType =
    nonempty(options.authType)?.toLowerCase() ??
    (!inApp ? nonempty(environment.DATABRICKS_AUTH_TYPE)?.toLowerCase() : undefined);
  const appServicePrincipal = [
    environment.DATABRICKS_HOST,
    environment.DATABRICKS_CLIENT_ID,
    environment.DATABRICKS_CLIENT_SECRET,
  ].every(nonempty);
  const selectedAuthType =
    !inApp || explicitProfile || explicitAuthType
      ? explicitAuthType
      : requestToken
        ? AUTH_TYPE_APP_OBO
        : appServicePrincipal
          ? AUTH_TYPE_APP_SP
          : undefined;
  const appAuth = [AUTH_TYPE_APP_OBO, "app-obo", AUTH_TYPE_APP_SP, "app-sp"].includes(
    selectedAuthType ?? "",
  );
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
  const configured = loadRawProfile(config, profileName);
  const ambient = (name: keyof NodeJS.ProcessEnv): string | undefined =>
    ignoreAmbientCredentials ? undefined : nonempty(environment[name]);
  const host = normalizeHost(
    options.host ?? ambient("DATABRICKS_HOST") ?? configured.host,
    profileName,
  );
  const accountId =
    nonempty(options.accountId) ??
    ambient("DATABRICKS_ACCOUNT_ID") ??
    nonempty(configured.accountId);
  const workspaceId =
    nonempty(options.workspaceId) ??
    ambient("DATABRICKS_WORKSPACE_ID") ??
    nonempty(configured.workspaceId);
  const clientIdValue =
    nonempty(options.clientId) ?? ambient("DATABRICKS_CLIENT_ID") ?? nonempty(configured.clientId);
  const clientSecret =
    nonempty(options.clientSecret) ??
    ambient("DATABRICKS_CLIENT_SECRET") ??
    nonempty(configured.clientSecret);
  const accessToken =
    selectedAuthType === AUTH_TYPE_APP_OBO || selectedAuthType === "app-obo"
      ? requestToken
      : (nonempty(options.accessToken) ??
        ambient("DATABRICKS_TOKEN") ??
        nonempty(configured.accessToken));
  const authType =
    selectedAuthType ??
    ambient("DATABRICKS_AUTH_TYPE") ??
    nonempty(configured.authType)?.toLowerCase();
  const authKind = resolveAuthKind(authType, clientIdValue, clientSecret, accessToken);
  const clientId =
    authKind === AuthKind.UserToMachine
      ? (clientIdValue ?? DEFAULT_CLIENT_ID)
      : authKind === AuthKind.MachineToMachine || authKind === AuthKind.AppServicePrincipal
        ? (clientIdValue ?? missing(profileName, "client_id"))
        : (clientIdValue ?? "");
  const scopes = options.scopes?.length
    ? cleanList(options.scopes)
    : cleanList(configured.scopes?.split(",") ?? ["all-apis"]);
  const target = options.target ? parseTarget(options.target) : inferTarget(host, accountId);
  const groupId =
    nonempty(options.groupId) ?? ambient("DATABRICKS_GROUP_ID") ?? nonempty(configured.groupId);
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
    accessToken,
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
    ...(authType ? { authType } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    ...(accessToken ? { accessToken } : {}),
    cacheKey,
    principal,
  };
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
    const error =
      cause instanceof Error ? cause : new AuthError("config", `Could not read ${path}`, { cause });
    configCache.set(path, error);
    throw error;
  }
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
    | "authKind"
    | "accessToken"
  >,
): string {
  if (profile.authKind === AuthKind.UserToMachine) return profile.name;
  if (profile.authKind === AuthKind.PersonalAccessToken) {
    const digest = createHash("sha256")
      .update(profile.accessToken ?? "")
      .digest("hex");
    return `${profile.name}-pat-${digest}`;
  }
  if (profile.authKind === AuthKind.AppOnBehalfOf) return `${profile.name}-app-obo`;
  const identity = [
    profile.host,
    profile.accountId ?? "",
    profile.workspaceId ?? "",
    profile.clientId,
    profile.groupId ?? "",
    machineScopes(profile.scopes).join(" "),
  ].join("\0");
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
