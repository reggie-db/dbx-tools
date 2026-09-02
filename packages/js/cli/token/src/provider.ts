/**
 * Provider-neutral access-token contracts.
 *
 * @module
 */

import type { TokenProviderName } from "./config.ts";

/** One provider token and the cache metadata the broker needs. */
export interface AccessToken {
  /** Opaque provider bearer token. */
  accessToken: string;
  /** OAuth token type. */
  tokenType: "Bearer";
  /** Conservative epoch-millisecond expiry. */
  expiresAt: number;
  /** Canonical scopes used to acquire the token. */
  scopes: string[];
}

/** Extensible token-acquisition boundary implemented by each provider. */
export interface TokenProvider {
  /** Stable provider selector. */
  readonly name: TokenProviderName;
  /** Acquire a short-lived token for one canonical scope set. */
  acquire(scopes: readonly string[]): Promise<AccessToken>;
}
