import { homedir } from "node:os";
import { join } from "node:path";

import * as environmentUtils from "@dbx-tools/shared-core/environment-utils";

import { authLogger, tokenMetadata } from "./_logging.ts";
import { AuthError } from "./errors.ts";
import { DatabricksCliProvider, resolveDatabricksCli } from "./databricks-cli.ts";
import { AuthClient, publicToken } from "./lifecycle.ts";
import { FileCredentialStore } from "./node-storage.ts";
import { DatabricksPersonalAccessTokenProvider } from "./personal-access-token.ts";
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
  type TokenProvider,
  WORKSPACE_ID_HEADER,
} from "./types.ts";

const logger = authLogger("databricks");

/** Injectable host capabilities for Databricks authentication. */
export interface DatabricksAuthDependencies {
  environment?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
  resolveCli?: (options: { install: boolean }) => Promise<string | undefined>;
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
    logger.debug("authentication challenge requested", this.context());
    await this.client.login();
    logger.debug("authentication challenge completed", this.context());
  }

  token(login?: boolean) {
    logger.debug("Databricks token requested", {
      ...this.context(),
      login: login ?? "auto",
      source: this.requestToken ? "request" : "lifecycle",
    });
    return this.requestToken
      ? Promise.resolve(publicToken(this.requestToken))
      : this.requiredClient().tokenWithLogin(login);
  }

  async authenticate(login?: boolean): Promise<Record<string, string>> {
    const token = await this.token(login);
    const headers = {
      [DEFAULT_ACCESS_TOKEN_HEADER]: `${token.tokenType} ${token.accessToken}`,
      ...(this.profileValue.workspaceId
        ? { [WORKSPACE_ID_HEADER]: this.profileValue.workspaceId }
        : {}),
    };
    logger.debug("generated Databricks authentication headers", {
      ...this.context(),
      headerNames: Object.keys(headers),
      token: tokenMetadata(token),
    });
    return headers;
  }

  async authorizationHeaderForUrl(
    requestUrl: string,
    login?: boolean,
  ): Promise<string | undefined> {
    return (await this.requestHeadersForUrl(requestUrl, login))[DEFAULT_ACCESS_TOKEN_HEADER];
  }

  async requestHeadersForUrl(requestUrl: string, login?: boolean): Promise<Record<string, string>> {
    const request = new URL(requestUrl);
    const credentialOrigin = new URL(this.profileValue.host).origin;
    if (request.origin !== credentialOrigin) {
      logger.debug("skipped authentication for different origin", {
        ...this.context(),
        requestOrigin: request.origin,
        credentialOrigin,
      });
      return {};
    }
    logger.debug("applying authentication to matching origin", {
      ...this.context(),
      requestOrigin: request.origin,
    });
    return this.authenticate(login);
  }

  forceRefreshToken(login = true) {
    logger.debug("Databricks token force refresh requested", { ...this.context(), login });
    return this.requestToken
      ? Promise.resolve(publicToken(this.requestToken))
      : this.requiredClient().forceRefresh(login);
  }

  refreshRejectedToken(staleAccessToken: string, login = true) {
    logger.debug("Databricks rejected token refresh requested", {
      ...this.context(),
      login,
      requestToken: Boolean(this.requestToken),
    });
    return this.requestToken
      ? Promise.resolve(publicToken(this.requestToken))
      : this.requiredClient().refreshRejectedToken(staleAccessToken, login);
  }

  logout(): Promise<void> {
    logger.debug("Databricks logout requested", this.context());
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

  private context(): Record<string, unknown> {
    return {
      profile: this.profileValue.name,
      host: this.profileValue.host,
      authKind: this.profileValue.authKind,
      storage: this.storageValue,
      hasWorkspaceId: Boolean(this.profileValue.workspaceId),
    };
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
  const backend = storage === Storage.Auto ? Storage.Memory : storage;
  logger.debug("creating persistent Databricks auth", {
    profile: profile.name,
    host: profile.host,
    authKind: profile.authKind,
    requestedStorage: storage,
    resolvedStorage: backend,
    inApp,
  });
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
    logger.debug("created request-scoped App OBO authentication", {
      profile: profile.name,
      host: profile.host,
      hasWorkspaceId: Boolean(profile.workspaceId),
    });
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
  const persistent = new PersistentAuth(
    profile,
    storage === Storage.Auto ? storageFromName(store.name()) : storage,
    client,
  );
  logger.debug("created persistent authentication lifecycle", {
    profile: profile.name,
    host: profile.host,
    authKind: profile.authKind,
    storage: persistent.status().storage,
  });
  return persistent;
}

async function providerFor(
  profile: DatabricksProfile,
  options: DatabricksAuthOptions,
  dependencies: DatabricksAuthDependencies,
): Promise<TokenProvider> {
  const environment = dependencies.environment ?? process.env;
  const inApp = environmentUtils.isDatabricksAppEnv({ ...environment });
  switch (profile.authKind) {
    case AuthKind.UserToMachine: {
      const install = !inApp || options.installCliInApp === true;
      logger.debug("selected Databricks CLI provider", {
        profile: profile.name,
        inApp,
        install,
      });
      return new DatabricksCliProvider(
        profile.name,
        () =>
          dependencies.resolveCli
            ? dependencies.resolveCli({ install })
            : resolveDatabricksCli(environment, { install }),
        cliEnvironment(profile, resolveConfigFile(options.configFile, environment)),
      );
    }
    case AuthKind.PersonalAccessToken:
      logger.debug("selected personal access token provider", { profile: profile.name });
      return new DatabricksPersonalAccessTokenProvider(profile.accessToken!);
    case AuthKind.MachineToMachine:
    case AuthKind.AppServicePrincipal: {
      logger.debug("selected service-principal provider", {
        profile: profile.name,
        authKind: profile.authKind,
        target: profile.target,
      });
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
    const endpoints = {
      tokenEndpoint: `${host}/oidc/accounts/${profile.accountId}/v1/token`,
    };
    logger.debug("resolved account OAuth endpoint", {
      profile: profile.name,
      tokenOrigin: new URL(endpoints.tokenEndpoint).origin,
    });
    return endpoints;
  }
  const discovery =
    profile.target === TargetKind.Unified
      ? `${host}/oidc/accounts/${requiredAccountId(profile)}/.well-known/oauth-authorization-server`
      : `${host}/oidc/.well-known/oauth-authorization-server`;
  logger.debug("requesting OAuth discovery", {
    profile: profile.name,
    target: profile.target,
    discovery,
  });
  const response = await fetcher(discovery, { redirect: "manual" });
  logger.debug("received OAuth discovery response", {
    profile: profile.name,
    status: response.status,
  });
  if (response.status === 404)
    throw new AuthError("oauth", `OAuth is not supported at ${discovery}`);
  if (!response.ok)
    throw new AuthError("oauth", `OAuth discovery returned HTTP ${response.status}`);
  const value = (await response.json()) as Record<string, unknown>;
  const tokenEndpoint = stringValue(value.token_endpoint);
  if (!tokenEndpoint) throw new AuthError("oauth", "OAuth discovery response is incomplete");
  logger.debug("resolved OAuth token endpoint", {
    profile: profile.name,
    tokenOrigin: new URL(tokenEndpoint).origin,
  });
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
