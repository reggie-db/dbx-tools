import { AuthError } from "./errors.ts";
import type { AccessToken, AuthOptions, CredentialStore, Token, TokenProvider } from "./types.ts";

/** Provider-neutral check-lock-check authentication and persistent token lifecycle. */
export class AuthClient {
  constructor(
    private readonly key: string,
    private readonly provider: TokenProvider,
    private readonly store: CredentialStore,
    private readonly options: AuthOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  storeName(): string {
    return this.store.name();
  }

  async login(): Promise<AccessToken> {
    return this.withLock(async () => {
      await this.store.prepareWrite();
      const token = validateToken(
        await this.provider.login(this.options.loginTimeoutSeconds * 1000),
      );
      await this.store.save(this.key, token);
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
    if (login === true) return this.login();
    if (login === false) return this.token();
    return this.tokenOrLogin();
  }

  forceRefresh(login = true): Promise<AccessToken> {
    return this.refreshRejected(undefined, login);
  }

  refreshRejectedToken(staleAccessToken: string, login = true): Promise<AccessToken> {
    return this.refreshRejected(staleAccessToken, login);
  }

  async logout(): Promise<void> {
    await this.withLock(() => this.store.remove(this.key));
  }

  private async loadToken(login: boolean): Promise<AccessToken> {
    const existing = await this.store.load(this.key);
    if (existing && this.canReuse(existing)) return publicToken(existing);
    return this.withLock(async () => {
      const current = await this.store.load(this.key);
      if (current && this.canReuse(current)) return publicToken(current);
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
        return publicToken(current);
      }
      return this.renew(current, login);
    });
  }

  private async renew(current: Token | undefined, login: boolean): Promise<AccessToken> {
    let token: Token;
    if (current) {
      try {
        token = await this.provider.refresh(current);
      } catch (error) {
        if (!login) throw error;
        token = await this.provider.login(this.options.loginTimeoutSeconds * 1000);
      }
    } else if (this.provider.canAuthenticateSilently()) {
      try {
        token = await this.provider.authenticate(this.options.loginTimeoutSeconds * 1000);
      } catch (error) {
        if (!login) throw error;
        token = await this.provider.login(this.options.loginTimeoutSeconds * 1000);
      }
    } else if (login) {
      token = await this.provider.login(this.options.loginTimeoutSeconds * 1000);
    } else {
      throw new AuthError(
        "oauth",
        "No stored credential is available and interactive login is disabled",
      );
    }
    token = validateToken(token, current);
    await this.store.prepareWrite();
    await this.store.save(this.key, token);
    return publicToken(token);
  }

  private canReuse(token: Token): boolean {
    if (!isValid(token, this.now())) return false;
    if (!token.expiry) return true;
    return (
      Date.parse(token.expiry) - this.now().getTime() > this.options.refreshBufferSeconds * 1000
    );
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const lease = await this.store.acquireLock(this.key, this.options.lockTimeoutSeconds * 1000);
    let failure: unknown;
    try {
      return await action();
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        await this.store.releaseLock(lease);
      } catch (releaseError) {
        if (failure === undefined) throw releaseError;
      }
    }
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
