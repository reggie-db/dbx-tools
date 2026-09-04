/**
 * Stable TypeScript boundary for loading the generated U2M bindings.
 *
 * @module
 */

/** Public access-token fields exposed by the native binding. */
export interface AccessToken {
  accessToken: string;
  tokenType: string;
  expiry?: string;
  scopes: string[];
}

/** U2M configuration accepted by the native binding. */
export interface U2mOptions {
  profile?: string;
  host?: string;
  accountId?: string;
  workspaceId?: string;
  configFile?: string;
  clientId?: string;
  scopes?: string[];
  target?: string;
  cacheDir?: string;
  callbackImageSrc?: string;
  lockTimeoutSeconds: bigint;
  loginTimeoutSeconds: bigint;
  refreshBufferSeconds: bigint;
}

/** Resolved profile status returned by the native binding. */
export interface U2mStatus {
  profile: string;
  host: string;
  storage: number;
}

/** Credential storage callbacks accepted by the native binding. */
export interface StorageAdapter {
  load(profile: string, options?: { signal: AbortSignal }): Promise<string | undefined>;
  prepareWrite(options?: { signal: AbortSignal }): Promise<void>;
  save(profile: string, token: string, options?: { signal: AbortSignal }): Promise<void>;
  remove(profile: string, options?: { signal: AbortSignal }): Promise<void>;
  acquireLock(
    profile: string,
    timeoutMillis: bigint,
    options?: { signal: AbortSignal },
  ): Promise<string>;
  releaseLock(lease: string, options?: { signal: AbortSignal }): Promise<void>;
  name(): string;
}

/** Auth object exposed by the native binding. */
export interface PersistentAuthLike {
  challenge(options?: { signal: AbortSignal }): Promise<void>;
  forceRefreshToken(options?: { signal: AbortSignal }): Promise<AccessToken>;
  logout(options?: { signal: AbortSignal }): Promise<void>;
  status(): U2mStatus;
  token(login?: boolean, options?: { signal: AbortSignal }): Promise<AccessToken>;
}

/** Runtime values and factories exported by the generated binding module. */
export interface U2mBindings {
  U2mOptions: {
    create(options?: Partial<U2mOptions>): U2mOptions;
  };
  Storage: {
    Auto: number;
    Memory: number;
    File: number;
    Keyring: number;
  };
  createPersistentAuth(
    options: U2mOptions,
    storage?: number,
    asyncOptions?: { signal: AbortSignal },
  ): Promise<PersistentAuthLike>;
  createPersistentAuthWithStorage(
    options: U2mOptions,
    storage: StorageAdapter,
    asyncOptions?: { signal: AbortSignal },
  ): Promise<PersistentAuthLike>;
}

const BINDINGS_MODULE: string = import.meta.url.endsWith(".ts") ? "./bindings.ts" : "./bindings.js";

/** Load and initialize the generated native binding on demand. */
export async function loadBindings(): Promise<U2mBindings> {
  return (await import(BINDINGS_MODULE)) as U2mBindings;
}
