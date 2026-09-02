/**
 * Scope-aware in-memory token cache and refresh coordinator.
 *
 * @module
 */

import { processLock } from "@dbx-tools/core";
import { error, log, object } from "@dbx-tools/shared-core";

import { canonicalScopes, type TokenProviderName } from "./config.ts";
import type { AccessToken, TokenProvider } from "./provider.ts";

const logger = log.logger("token-broker");

export interface TokenBrokerOptions {
  /** Provider implementations available to requests. */
  providers: readonly TokenProvider[];
  /** Provider used when the request omits one. */
  defaultProvider: TokenProviderName;
  /** Scope set used when the request omits scopes. */
  defaultScopes: readonly string[];
  /** Maximum scope set any client may request. */
  allowedScopes: readonly string[];
  /** Remaining lifetime that makes a cached token stale. */
  refreshSkewSeconds: number;
  /** Injectable clock. */
  now?: () => number;
  /** Injectable timer scheduler. */
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
}

/** Provider and scope selection for one access-token request. */
export interface TokenRequest {
  /** Provider override. */
  provider?: TokenProviderName;
  /** Requested scopes; empty uses the broker default. */
  scopes?: readonly string[];
}

/**
 * In-memory access-token owner for one broker process.
 *
 * Cache identity is provider plus canonical scope set. Refresh uses the shared
 * process lock and rechecks after lock acquisition, so concurrent callers never
 * pile up provider requests. A failed proactive refresh leaves the prior token
 * in memory and does not replace it with an error.
 */
export class TokenBroker {
  private readonly providers: Map<TokenProviderName, TokenProvider>;
  private readonly tokens = new Map<string, AccessToken>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  private readonly schedule: NonNullable<TokenBrokerOptions["schedule"]>;

  constructor(private readonly options: TokenBrokerOptions) {
    this.providers = new Map(options.providers.map((provider) => [provider.name, provider]));
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? setTimeout;
  }

  /** Return a fresh-enough cached token or acquire exactly one replacement. */
  async accessToken(request: TokenRequest = {}): Promise<AccessToken> {
    const providerName = request.provider ?? this.options.defaultProvider;
    const provider = this.providers.get(providerName);
    if (!provider) throw new TypeError(`Token provider is not configured: ${providerName}`);
    const scopes = canonicalScopes(
      request.scopes && request.scopes.length > 0 ? request.scopes : this.options.defaultScopes,
    );
    this.assertAllowedScopes(scopes);
    const key = object.toStableKey([providerName, scopes]);
    const cached = this.tokens.get(key);
    if (this.isFresh(cached)) return cached;

    return processLock.withProcessLock(["token-broker", providerName, scopes], async () => {
      const current = this.tokens.get(key);
      if (this.isFresh(current)) return current;
      const refreshed = await provider.acquire(scopes);
      this.tokens.set(key, refreshed);
      this.scheduleRefresh(key, providerName, scopes, refreshed);
      return refreshed;
    });
  }

  /** Cancel proactive refresh timers owned by this broker. */
  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private isFresh(token: AccessToken | undefined): token is AccessToken {
    return Boolean(token && token.expiresAt - this.now() > this.options.refreshSkewSeconds * 1000);
  }

  private assertAllowedScopes(scopes: readonly string[]): void {
    const allowed = new Set(this.options.allowedScopes);
    const denied = scopes.filter((scope) => !allowed.has(scope));
    if (denied.length > 0) {
      throw new TypeError(`Requested Google scopes are not allowed: ${denied.join(", ")}`);
    }
  }

  private scheduleRefresh(
    key: string,
    provider: TokenProviderName,
    scopes: readonly string[],
    token: AccessToken,
  ): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const delay = Math.max(
      1,
      token.expiresAt - this.now() - this.options.refreshSkewSeconds * 1000,
    );
    const timer = this.schedule(() => {
      this.timers.delete(key);
      void this.accessToken({ provider, scopes }).catch((cause) => {
        logger.warn("proactive refresh failed", {
          provider,
          scopes,
          error: error.errorMessage(cause),
        });
      });
    }, delay);
    timer.unref?.();
    this.timers.set(key, timer);
  }
}
