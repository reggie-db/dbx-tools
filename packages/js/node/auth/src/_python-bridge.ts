import { AuthClient } from "./lifecycle.ts";
import {
  loadRawProfile,
  normalizeHost,
  parseDatabricksConfig,
  resolveAuthKind,
  resolveProfileName,
} from "./_profile-core.ts";
import { AuthError } from "./errors.ts";
import { AuthKind, AuthOptions, type CredentialStore, type TokenProvider } from "./types.ts";

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

export function resolveDatabricksCliProfile(
  configSource: string,
  requested?: string,
  preferUserToMachine = true,
): { name: string; host?: string; workspaceId?: string } {
  const selected = requested?.trim() || undefined;
  const config = configSource.trim() ? parseDatabricksConfig(configSource) : undefined;
  const name = resolveProfileName(selected, Boolean(selected), config, preferUserToMachine);
  const profile = loadRawProfile(config, name);
  const authKind = resolveAuthKind(
    profile.authType,
    profile.clientId,
    profile.clientSecret,
    profile.accessToken,
  );
  if (authKind !== AuthKind.UserToMachine) {
    throw new AuthError("config", `Profile ${name} does not use Databricks CLI authentication`);
  }
  return {
    name,
    ...(profile.host ? { host: normalizeHost(profile.host, name) } : {}),
    ...(profile.workspaceId ? { workspaceId: profile.workspaceId } : {}),
  };
}
