import { AuthError } from "./errors.ts";
import { authLogger, credentialId, failureMetadata, tokenMetadata } from "./_logging.ts";
import type { AccessToken, AuthOptions, CredentialStore, Token, TokenProvider } from "./types.ts";

const logger = authLogger("lifecycle");

/** Provider-neutral check-lock-check authentication and persistent token lifecycle. */
export class TokenLifecycle {
  constructor(
    private readonly key: string,
    private readonly provider: TokenProvider,
    private readonly store: CredentialStore,
    private readonly options: AuthOptions,
    private readonly now: () => Date = () => new Date(),
  ) {
    logger.debug("created authentication lifecycle", {
      credential: credentialId(key),
      storage: store.name(),
      refreshBufferMs: options.refreshBufferMs,
      lockTimeoutMs: options.lockTimeoutMs,
      loginTimeoutMs: options.loginTimeoutMs,
      silentProvider: provider.canAuthenticateSilently(),
    });
  }

  storeName(): string {
    return this.store.name();
  }

  async login(): Promise<AccessToken> {
    logger.debug("interactive login requested", this.context());
    return this.withLock(async () => {
      await this.store.prepareWrite();
      const token = validateToken(
        await this.provider.login(this.options.loginTimeoutMs),
      );
      await this.store.save(this.key, token);
      logger.debug("interactive login stored credential", {
        ...this.context(),
        token: tokenMetadata(token, this.now()),
      });
      return publicToken(token);
    });
  }

  token(): Promise<AccessToken> {
    return this.loadToken(false);
  }

  tokenOrLogin(): Promise<AccessToken> {
    return this.loadToken(true);
  }

  async tokenWithLogin(login?: boolean): Promise<AccessToken> {
    logger.debug("token requested", { ...this.context(), login: login ?? "auto" });
    if (login === true) return this.login();
    if (login === false) return this.token();
    return this.tokenOrLogin();
  }

  forceRefresh(login = true): Promise<AccessToken> {
    logger.debug("forced refresh requested", { ...this.context(), login });
    return this.refreshRejected(undefined, login);
  }

  refreshRejectedToken(staleAccessToken: string, login = true): Promise<AccessToken> {
    logger.debug("rejected token refresh requested", { ...this.context(), login });
    return this.refreshRejected(staleAccessToken, login);
  }

  async logout(): Promise<void> {
    logger.debug("logout requested", this.context());
    await this.withLock(() => this.store.remove(this.key));
    logger.debug("stored credential removed", this.context());
  }

  private async loadToken(login: boolean): Promise<AccessToken> {
    const existing = await this.store.load(this.key);
    const reusable = Boolean(existing && this.canReuse(existing));
    logger.debug("checked credential cache", {
      ...this.context(),
      login,
      reusable,
      token: tokenMetadata(existing, this.now()),
    });
    if (existing && reusable) return publicToken(existing);
    return this.withLock(async () => {
      const current = await this.store.load(this.key);
      const currentReusable = Boolean(current && this.canReuse(current));
      logger.debug("rechecked credential cache after lock", {
        ...this.context(),
        reusable: currentReusable,
        token: tokenMetadata(current, this.now()),
      });
      if (current && currentReusable) return publicToken(current);
      return this.renew(current, login);
    });
  }

  private async refreshRejected(
    staleAccessToken: string | undefined,
    login: boolean,
  ): Promise<AccessToken> {
    return this.withLock(async () => {
      const current = await this.store.load(this.key);
      if (
        staleAccessToken &&
        current?.accessToken &&
        current.accessToken !== staleAccessToken &&
        isValid(current, this.now())
      ) {
        logger.debug("reused replacement for rejected credential", {
          ...this.context(),
          token: tokenMetadata(current, this.now()),
        });
        return publicToken(current);
      }
      return this.renew(current, login);
    });
  }

  private async renew(current: Token | undefined, login: boolean): Promise<AccessToken> {
    let token: Token;
    if (current) {
      logger.debug("refreshing stored credential", {
        ...this.context(),
        loginFallback: login,
        token: tokenMetadata(current, this.now()),
      });
      try {
        token = await this.provider.refresh(current);
      } catch (error) {
        logger.debug("credential refresh failed", {
          ...this.context(),
          loginFallback: login,
          error: failureMetadata(error),
        });
        if (!login) throw error;
        logger.debug("falling back to interactive login", this.context());
        token = await this.provider.login(this.options.loginTimeoutMs);
      }
    } else if (this.provider.canAuthenticateSilently()) {
      logger.debug("attempting silent credential acquisition", {
        ...this.context(),
        loginFallback: login,
      });
      try {
        token = await this.provider.authenticate(this.options.loginTimeoutMs);
      } catch (error) {
        logger.debug("silent credential acquisition failed", {
          ...this.context(),
          loginFallback: login,
          error: failureMetadata(error),
        });
        if (!login) throw error;
        logger.debug("falling back to interactive login", this.context());
        token = await this.provider.login(this.options.loginTimeoutMs);
      }
    } else if (login) {
      logger.debug("provider requires interactive login", this.context());
      token = await this.provider.login(this.options.loginTimeoutMs);
    } else {
      throw new AuthError(
        "oauth",
        "No stored credential is available and interactive login is disabled",
      );
    }
    token = validateToken(token, current);
    logger.debug("credential acquisition completed", {
      ...this.context(),
      token: tokenMetadata(token, this.now()),
    });
    await this.store.prepareWrite();
    await this.store.save(this.key, token);
    logger.debug("credential saved", this.context());
    return publicToken(token);
  }

  private canReuse(token: Token): boolean {
    if (!isValid(token, this.now())) return false;
    if (!token.expiry) return true;
    return (
      Date.parse(token.expiry) - this.now().getTime() > this.options.refreshBufferMs
    );
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    logger.debug("waiting for credential lock", this.context());
    // Omit the timeout (wait indefinitely) unless a positive cap is configured.
    // The holder may run for minutes; the caller owns the overall request budget
    // and the lock is always released when `action` settles (success or error).
    const lockTimeoutMs = this.options.lockTimeoutMs > 0 ? this.options.lockTimeoutMs : undefined;
    const lease = await this.store.acquireLock(this.key, lockTimeoutMs);
    logger.debug("credential lock acquired", this.context());
    let failure: unknown;
    try {
      return await action();
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        await this.store.releaseLock(lease);
        logger.debug("credential lock released", this.context());
      } catch (releaseError) {
        logger.debug("credential lock release failed", {
          ...this.context(),
          error: failureMetadata(releaseError),
        });
        if (failure === undefined) throw releaseError;
      }
    }
  }

  private context(): Record<string, unknown> {
    return { credential: credentialId(this.key), storage: this.store.name() };
  }
}

export function publicToken(token: Token): AccessToken {
  return {
    accessToken: token.accessToken,
    tokenType: token.tokenType,
    ...(token.expiry ? { expiry: token.expiry } : {}),
    scopes: [...token.scopes],
  };
}

export function validateToken(token: Token, previous?: Token): Token {
  if (!token.accessToken.trim())
    throw new AuthError("oauth", "Token response did not contain an access token");
  return {
    accessToken: token.accessToken,
    tokenType: token.tokenType || "Bearer",
    refreshToken: token.refreshToken ?? previous?.refreshToken,
    expiry: token.expiry,
    scopes: token.scopes.length ? [...token.scopes] : [...(previous?.scopes ?? [])],
  };
}

function isValid(token: Token, now: Date): boolean {
  return Boolean(token.accessToken) && (!token.expiry || Date.parse(token.expiry) > now.getTime());
}
