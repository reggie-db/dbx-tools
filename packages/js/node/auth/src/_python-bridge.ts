import { environmentUtils } from "@dbx-tools/shared-core";

import { DatabricksCliProvider, resolveDatabricksCli } from "./databricks-cli.ts";
import { AuthError } from "./errors.ts";
import { AuthClient } from "./lifecycle.ts";
import { DatabricksPersonalAccessTokenProvider } from "./personal-access-token.ts";
import {
  resolveConfigFile,
  resolveDatabricksProfile,
} from "./profile.ts";
import {
  AuthKind,
  AuthOptions,
  type CredentialStore,
  DEFAULT_ACCESS_TOKEN_HEADER,
  type DatabricksAuthOptions,
  type DatabricksAuthStatus,
  type TokenProvider,
  WORKSPACE_ID_HEADER,
} from "./types.ts";

export interface PythonAuthClient {
  storeName(): string;
  login(): ReturnType<AuthClient["login"]>;
  token(login?: boolean): ReturnType<AuthClient["tokenWithLogin"]>;
  forceRefresh(login?: boolean): ReturnType<AuthClient["forceRefresh"]>;
  refreshRejectedToken(
    staleAccessToken: string,
    login?: boolean,
  ): ReturnType<AuthClient["refreshRejectedToken"]>;
  logout(): ReturnType<AuthClient["logout"]>;
}

export function createAuthClient(
  key: string,
  provider: TokenProvider,
  store: CredentialStore,
  options: Partial<AuthOptions> = {},
): PythonAuthClient {
  const client = new AuthClient(key, provider, store, AuthOptions.create(options));
  return {
    storeName: () => client.storeName(),
    login: () => client.login(),
    token: (login) => client.tokenWithLogin(login),
    forceRefresh: (login) => client.forceRefresh(login),
    refreshRejectedToken: (staleAccessToken, login) =>
      client.refreshRejectedToken(staleAccessToken, login),
    logout: () => client.logout(),
  };
}

export interface PythonDatabricksAuthOptions extends DatabricksAuthOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  executable?: string;
}

export interface PythonDatabricksAuth extends PythonAuthClient {
  authenticate(login?: boolean): Promise<Record<string, string>>;
  authKind(): AuthKind;
  principal(): string;
  requestHeadersForUrl(requestUrl: string, login?: boolean): Promise<Record<string, string>>;
  status(): DatabricksAuthStatus;
  workspaceId(): string | undefined;
}

export async function createDatabricksAuth(
  options: PythonDatabricksAuthOptions,
  store: CredentialStore,
): Promise<PythonDatabricksAuth> {
  const environment = options.environment ?? process.env;
  const profile = resolveDatabricksProfile(options, environment);
  const provider = providerFor(
    profile.authKind,
    profile.name,
    profile.accessToken,
    options,
    environment,
  );
  const client = createAuthClient(profile.cacheKey, provider, store, options.auth);
  const authenticate = async (login?: boolean): Promise<Record<string, string>> => {
    const token = await client.token(login);
    return {
      [DEFAULT_ACCESS_TOKEN_HEADER]: `${token.tokenType} ${token.accessToken}`,
      ...(profile.workspaceId ? { [WORKSPACE_ID_HEADER]: profile.workspaceId } : {}),
    };
  };
  return {
    ...client,
    authenticate,
    authKind: () => profile.authKind,
    principal: () => profile.principal,
    requestHeadersForUrl: async (requestUrl, login) =>
      new URL(requestUrl).origin === new URL(profile.host).origin ? authenticate(login) : {},
    status: () => ({
      profile: profile.name,
      host: profile.host,
      storage: store.name() === "memory" ? "memory" : "file",
    }),
    workspaceId: () => profile.workspaceId,
  };
}

function providerFor(
  authKind: AuthKind,
  profile: string,
  accessToken: string | undefined,
  options: PythonDatabricksAuthOptions,
  environment: Readonly<Record<string, string | undefined>>,
): TokenProvider {
  if (authKind === AuthKind.PersonalAccessToken) {
    return new DatabricksPersonalAccessTokenProvider(accessToken!);
  }
  if (authKind !== AuthKind.UserToMachine) {
    throw new AuthError(
      "config",
      `Profile ${profile} requires ${authKind}; Python auth currently supports CLI U2M and PAT profiles`,
    );
  }
  const configFile = resolveConfigFile(options.configFile, environment);
  const inApp = environmentUtils.isDatabricksAppEnv({ ...environment });
  const executable = options.executable;
  return new DatabricksCliProvider(
    profile,
    executable
      ? executable
      : () =>
          resolveDatabricksCli(environment, {
            install: !inApp || options.installCliInApp === true,
          }),
    {
      ...Object.fromEntries(
        Object.entries(environment).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      DATABRICKS_CONFIG_FILE: configFile,
      DATABRICKS_CONFIG_PROFILE: profile,
    },
  );
}
