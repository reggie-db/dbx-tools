import type { DatabricksProfileSummary } from "@dbx-tools/shared-auth/profile";

/** Stored OAuth credential with renewal metadata. */
export interface Token {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  expiry?: string;
  scopes: string[];
}

/** Resolved profile with secrets retained for provider construction. */
export interface DatabricksProfile extends DatabricksProfileSummary {
  host: string;
  selectedProfile?: string;
  clientId: string;
  groupId?: string;
  scopes: string[];
  clientSecret?: string;
  accessToken?: string;
  cacheKey: string;
}

/** Process-local credential lease adapter. */
export interface LockAdapter {
  acquire(key: string, timeoutMs?: number): Promise<string>;
  release(lease: string): Promise<void>;
}

/** Internal credential lifecycle storage. */
export interface CredentialStore {
  load(key: string): Promise<Token | undefined>;
  save(key: string, token: Token): Promise<void>;
  remove(key: string): Promise<void>;
  acquireLock(key: string, timeoutMs?: number): Promise<string>;
  releaseLock(lease: string): Promise<void>;
}

/** Provider-specific token acquisition. */
export interface TokenProvider {
  authenticate(timeoutMs: number): Promise<Token>;
  login(timeoutMs: number): Promise<Token>;
  refresh(token: Token): Promise<Token>;
  canAuthenticateSilently(): boolean;
}
