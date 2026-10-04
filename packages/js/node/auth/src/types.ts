/** Authentication strategy selected from Databricks configuration. */
export enum AuthKind {
  UserToMachine = "user-to-machine",
  MachineToMachine = "machine-to-machine",
  PersonalAccessToken = "personal-access-token",
  AppServicePrincipal = "app-service-principal",
  AppOnBehalfOf = "app-on-behalf-of",
}

/** Scope of the Databricks authentication target. */
export enum TargetKind {
  Workspace = "workspace",
  Account = "account",
  Unified = "unified",
}

/** Built-in credential storage backend. */
export enum Storage {
  Auto = "auto",
  Memory = "memory",
  File = "file",
}

/** File organization used by a persistent credential store. */
export enum FileLayout {
  Single = "single",
  PerCredential = "per-credential",
}

/** Stored OAuth credential, including renewal metadata. */
export interface Token {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  expiry?: string;
  scopes: string[];
}

/** Public credential result; deliberately excludes the refresh token. */
export interface AccessToken {
  accessToken: string;
  tokenType: string;
  expiry?: string;
  scopes: string[];
}

/** Shared lifecycle configuration embedded by every provider. */
export interface AuthOptions {
  refreshBufferSeconds: number;
  lockTimeoutSeconds: number;
  loginTimeoutSeconds: number;
  callbackImageSrc?: string;
}

const AUTH_DEFAULTS: AuthOptions = {
  refreshBufferSeconds: 300,
  lockTimeoutSeconds: 30,
  loginTimeoutSeconds: 900,
};

/** Record-style factory retained for straightforward Node/Python bridging. */
export const AuthOptions = {
  create(options: Partial<AuthOptions> = {}): AuthOptions {
    return { ...AUTH_DEFAULTS, ...options };
  },
  defaults(): Readonly<AuthOptions> {
    return Object.freeze({ ...AUTH_DEFAULTS });
  },
};

/** Secret-free metadata discovered from one Databricks CLI profile. */
export interface DatabricksProfileSummary {
  name: string;
  host?: string;
  accountId?: string;
  workspaceId?: string;
  target: TargetKind;
  authKind: AuthKind;
}

/** Resolved Databricks identity and active storage backend. */
export interface DatabricksAuthStatus {
  profile: string;
  host: string;
  storage: Storage;
}

/** Public Databricks authentication options. */
export interface DatabricksAuthOptions {
  profile?: string;
  host?: string;
  accountId?: string;
  workspaceId?: string;
  configFile?: string;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  groupId?: string;
  authType?: string;
  scopes?: string[];
  target?: string;
  cacheDir?: string;
  auth?: AuthOptions;
  requestHeaders?: Record<string, string>;
  accessTokenHeader?: string;
  preferUserToMachine: boolean;
}

/** Record-style factory retained for callers migrating from generated bindings. */
export const DatabricksAuthOptions = {
  create(options: Partial<DatabricksAuthOptions> = {}): DatabricksAuthOptions {
    return { preferUserToMachine: true, ...options };
  },
  defaults(): Readonly<DatabricksAuthOptions> {
    return Object.freeze({ preferUserToMachine: true });
  },
};

/** Resolved profile with secrets retained only for provider construction. */
export interface DatabricksProfile extends DatabricksProfileSummary {
  host: string;
  authType?: string;
  clientId: string;
  groupId?: string;
  scopes: string[];
  clientSecret?: string;
  accessToken?: string;
  cacheKey: string;
  principal: string;
}

/** Cross-language lease adapter; implementations may use files, databases, or FFI. */
export interface LockAdapter {
  acquire(key: string, timeoutMs: number): Promise<string>;
  release(lease: string): Promise<void>;
}

/** Cross-language credential persistence contract. */
export interface CredentialStore {
  load(key: string): Promise<Token | undefined>;
  prepareWrite(): Promise<void>;
  save(key: string, token: Token): Promise<void>;
  remove(key: string): Promise<void>;
  acquireLock(key: string, timeoutMs: number): Promise<string>;
  releaseLock(lease: string): Promise<void>;
  name(): string;
}

/** Provider-specific token acquisition. */
export interface TokenProvider {
  authenticate(timeoutMs: number): Promise<Token>;
  login(timeoutMs: number): Promise<Token>;
  refresh(token: Token): Promise<Token>;
  canAuthenticateSilently(): boolean;
}

/** Stable facade shared by the CLI, HTTP client, and future language shims. */
export interface PersistentAuthLike {
  challenge(): Promise<void>;
  token(login?: boolean): Promise<AccessToken>;
  headers(login?: boolean): Promise<Record<string, string>>;
  authorizationHeaderForUrl(requestUrl: string, login?: boolean): Promise<string | undefined>;
  requestHeadersForUrl(requestUrl: string, login?: boolean): Promise<Record<string, string>>;
  forceRefreshToken(login?: boolean): Promise<AccessToken>;
  refreshRejectedToken(staleAccessToken: string, login?: boolean): Promise<AccessToken>;
  logout(): Promise<void>;
  status(): DatabricksAuthStatus;
  principal(): string;
  workspaceId(): string | undefined;
  authKind(): AuthKind;
}

/** Public OAuth client used by Databricks CLI-compatible user authentication. */
export const DEFAULT_CLIENT_ID = "databricks-cli";
/** Default Databricks profile configuration path. */
export const DEFAULT_CONFIG_FILE = "~/.databrickscfg";
/** Default Databricks account console origin. */
export const DEFAULT_ACCOUNTS_HOST = "https://accounts.cloud.databricks.com";
/** Canonical request header carrying a bearer access token. */
export const DEFAULT_ACCESS_TOKEN_HEADER = "authorization";
/** Canonical request header carrying the resolved Databricks workspace ID. */
export const WORKSPACE_ID_HEADER = "x-databricks-workspace-id";
/** Authentication type for Databricks App on-behalf-of request credentials. */
export const AUTH_TYPE_APP_OBO = "app_obo";
/** Authentication type for Databricks App service-principal credentials. */
export const AUTH_TYPE_APP_SP = "app_sp";
