import { homedir } from "node:os";
import { join } from "node:path";

import { configUtils } from "@dbx-tools/core";

import { AuthError } from "./errors.ts";
import { DatabricksCliProvider, resolveDatabricksCli } from "./databricks-cli.ts";
import { AuthClient, publicToken } from "./lifecycle.ts";
import { FileCredentialStore } from "./node-storage.ts";
import { machineScopes, resolveConfigFile, resolveDatabricksProfile } from "./profile.ts";
import { DatabricksServicePrincipalProvider } from "./service-principal.ts";
import { MemoryCredentialStore } from "./storage.ts";
import {
  AuthKind,
  AuthOptions,
  type CredentialStore,
  type DatabricksAuthOptions,
  type DatabricksAuthStatus,
  type DatabricksProfile,
  DEFAULT_ACCESS_TOKEN_HEADER,
  type PersistentAuthLike,
  Storage,
  TargetKind,
  type Token,
  WORKSPACE_ID_HEADER,
} from "./types.ts";

/** Injectable host capabilities for Databricks authentication. */
export interface DatabricksAuthDependencies {
  environment?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
  resolveCli?: () => Promise<string | undefined>;
}

/** Persistent Databricks auth facade over the provider-neutral lifecycle. */
export class PersistentAuth implements PersistentAuthLike {
  constructor(
    private readonly profileValue: DatabricksProfile,
    private readonly storageValue: Storage,
    private readonly client?: AuthClient,
    private readonly requestToken?: Token,
  ) {}

  async challenge(): Promise<void> {
    if (!this.client)
      throw new AuthError("oauth", "app_obo uses the current request token and cannot start login");
    await this.client.login();
  }

  token(login?: boolean) {
    return this.requestToken
      ? Promise.resolve(publicToken(this.requestToken))
      : this.requiredClient().tokenWithLogin(login);
  }

  async authenticate(login?: boolean): Promise<Record<string, string>> {
    const token = await this.token(login);
    return {
      [DEFAULT_ACCESS_TOKEN_HEADER]: `${token.tokenType} ${token.accessToken}`,
      ...(this.profileValue.workspaceId
        ? { [WORKSPACE_ID_HEADER]: this.profileValue.workspaceId }
        : {}),
    };
  }

  async authorizationHeaderForUrl(
    requestUrl: string,
    login?: boolean,
  ): Promise<string | undefined> {
    return (await this.requestHeadersForUrl(requestUrl, login))[DEFAULT_ACCESS_TOKEN_HEADER];
  }

  async requestHeadersForUrl(requestUrl: string, login?: boolean): Promise<Record<string, string>> {
    const request = new URL(requestUrl);
    if (request.origin !== new URL(this.profileValue.host).origin) return {};
    return this.authenticate(login);
  }

  forceRefreshToken(login = true) {
    return this.requestToken
      ? Promise.resolve(publicToken(this.requestToken))
      : this.requiredClient().forceRefresh(login);
  }

  refreshRejectedToken(staleAccessToken: string, login = true) {
    return this.requestToken
      ? Promise.resolve(publicToken(this.requestToken))
      : this.requiredClient().refreshRejectedToken(staleAccessToken, login);
  }

  logout(): Promise<void> {
    return this.client?.logout() ?? Promise.resolve();
  }

  status(): DatabricksAuthStatus {
    return {
      profile: this.profileValue.name,
      host: this.profileValue.host,
      storage: this.storageValue,
    };
  }

  principal(): string {
    return this.profileValue.principal;
  }

  workspaceId(): string | undefined {
    return this.profileValue.workspaceId;
  }

  authKind(): AuthKind {
    return this.profileValue.authKind;
  }

  profile(): DatabricksProfile {
    return { ...this.profileValue, scopes: [...this.profileValue.scopes] };
  }

  private requiredClient(): AuthClient {
    if (!this.client) throw new AuthError("oauth", "Authentication lifecycle is not available");
    return this.client;
  }
}

/** Resolve a Databricks profile and open built-in credential storage. */
export async function createPersistentAuth(
  options: DatabricksAuthOptions = { preferUserToMachine: true },
  storage = Storage.Auto,
  dependencies: DatabricksAuthDependencies = {},
): Promise<PersistentAuth> {
  const environment = dependencies.environment ?? process.env;
  const profile = resolveDatabricksProfile(options, environment);
  const inApp =
    profile.authKind === AuthKind.AppOnBehalfOf ||
    profile.authKind === AuthKind.AppServicePrincipal;
  const backend = storage === Storage.Auto ? (inApp ? Storage.Memory : Storage.File) : storage;
  const store =
    backend === Storage.Memory
      ? new MemoryCredentialStore()
      : new FileCredentialStore(options.cacheDir ?? join(homedir(), ".databricks"));
  return createPersistentAuthWithStorage(options, store, storage, dependencies, profile);
}

/** Resolve a Databricks profile using caller-owned generic storage. */
export async function createPersistentAuthWithStorage(
  options: DatabricksAuthOptions,
  store: CredentialStore,
  storage = store.name() === "memory" ? Storage.Memory : Storage.File,
  dependencies: DatabricksAuthDependencies = {},
  resolvedProfile?: DatabricksProfile,
): Promise<PersistentAuth> {
  const profile =
    resolvedProfile ?? resolveDatabricksProfile(options, dependencies.environment ?? process.env);
  if (profile.authKind === AuthKind.AppOnBehalfOf) {
    return new PersistentAuth(profile, Storage.Memory, undefined, {
      accessToken: profile.accessToken!,
      tokenType: "Bearer",
      scopes: [...profile.scopes],
    });
  }
  const provider = await providerFor(profile, options, dependencies);
  const client = new AuthClient(
    profile.cacheKey,
    provider,
    store,
    AuthOptions.create(options.auth),
  );
  return new PersistentAuth(
    profile,
    storage === Storage.Auto ? storageFromName(store.name()) : storage,
    client,
  );
}

async function providerFor(
  profile: DatabricksProfile,
  options: DatabricksAuthOptions,
  dependencies: DatabricksAuthDependencies,
): Promise<DatabricksCliProvider | DatabricksServicePrincipalProvider> {
  const environment = dependencies.environment ?? process.env;
  const inApp = configUtils.isDatabricksAppEnv({ ...environment });
  switch (profile.authKind) {
    case AuthKind.UserToMachine:
    case AuthKind.PersonalAccessToken: {
      if (inApp)
        throw new AuthError(
          "config",
          "Databricks Apps use app_obo request headers or app_sp environment credentials",
        );
      const executable = await (
        dependencies.resolveCli ?? (() => resolveDatabricksCli(environment))
      )();
      if (!executable) throw new AuthError("cli", "Databricks CLI is unavailable on this platform");
      return new DatabricksCliProvider(
        profile.name,
        executable,
        profile.authKind,
        cliEnvironment(profile, resolveConfigFile(options.configFile, environment)),
      );
    }
    case AuthKind.MachineToMachine:
    case AuthKind.AppServicePrincipal: {
      const endpoints = await resolveOAuthEndpoints(profile, dependencies.fetch);
      return new DatabricksServicePrincipalProvider({
        tokenEndpoint: endpoints.tokenEndpoint,
        clientId: profile.clientId,
        clientSecret: profile.clientSecret!,
        scopes: machineScopes(profile.scopes),
        ...(profile.groupId ? { groupId: profile.groupId } : {}),
        allowInsecureRequests: isLoopbackHttp(profile.host),
        fetch: dependencies.fetch,
      });
    }
    case AuthKind.AppOnBehalfOf:
      throw new AuthError("config", "App OBO tokens do not use a persistent provider");
  }
}

interface AuthorizationServer {
  tokenEndpoint: string;
}

async function resolveOAuthEndpoints(
  profile: DatabricksProfile,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<AuthorizationServer> {
  const host = profile.host.replace(/\/$/, "");
  if (profile.target === TargetKind.Account) {
    if (!profile.accountId) throw new AuthError("config", "Account target requires account_id");
    return {
      tokenEndpoint: `${host}/oidc/accounts/${profile.accountId}/v1/token`,
    };
  }
  const discovery =
    profile.target === TargetKind.Unified
      ? `${host}/oidc/accounts/${requiredAccountId(profile)}/.well-known/oauth-authorization-server`
      : `${host}/oidc/.well-known/oauth-authorization-server`;
  const response = await fetcher(discovery, { redirect: "manual" });
  if (response.status === 404)
    throw new AuthError("oauth", `OAuth is not supported at ${discovery}`);
  if (!response.ok)
    throw new AuthError("oauth", `OAuth discovery returned HTTP ${response.status}`);
  const value = (await response.json()) as Record<string, unknown>;
  const tokenEndpoint = stringValue(value.token_endpoint);
  if (!tokenEndpoint) throw new AuthError("oauth", "OAuth discovery response is incomplete");
  return { tokenEndpoint };
}

function requiredAccountId(profile: DatabricksProfile): string {
  if (!profile.accountId) throw new AuthError("config", "Unified target requires account_id");
  return profile.accountId;
}

function storageFromName(name: string): Storage {
  return name === "memory" ? Storage.Memory : Storage.File;
}

function isLoopbackHttp(host: string): boolean {
  const url = new URL(host);
  return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
}

function cliEnvironment(profile: DatabricksProfile, configFile: string): Record<string, string> {
  return {
    DATABRICKS_CONFIG_FILE: configFile,
    DATABRICKS_CONFIG_PROFILE: profile.name,
    DATABRICKS_HOST: profile.host,
    ...(profile.accountId ? { DATABRICKS_ACCOUNT_ID: profile.accountId } : {}),
    ...(profile.workspaceId ? { DATABRICKS_WORKSPACE_ID: profile.workspaceId } : {}),
    ...(profile.authKind === AuthKind.PersonalAccessToken
      ? {
          DATABRICKS_AUTH_TYPE: "pat",
          DATABRICKS_TOKEN: profile.accessToken!,
        }
      : {}),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
