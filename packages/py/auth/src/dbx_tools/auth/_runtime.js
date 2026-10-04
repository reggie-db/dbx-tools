// GENERATED from @dbx-tools/auth for PythonMonkey. DO NOT EDIT.
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// packages/js/node/auth/src/_python-bridge.ts
var exports__python_bridge = {};
__export(exports__python_bridge, {
  createAuthClient: () => createAuthClient
});
module.exports = __toCommonJS(exports__python_bridge);

// packages/js/node/auth/src/errors.ts
class AuthError extends Error {
  kind;
  constructor(kind, message, options) {
    super(message, options);
    this.kind = kind;
    this.name = "AuthError";
  }
}

// packages/js/node/auth/src/lifecycle.ts
class AuthClient {
  key;
  provider;
  store;
  options;
  now;
  constructor(key, provider, store, options, now = () => new Date) {
    this.key = key;
    this.provider = provider;
    this.store = store;
    this.options = options;
    this.now = now;
  }
  storeName() {
    return this.store.name();
  }
  async login() {
    return this.withLock(async () => {
      await this.store.prepareWrite();
      const token = validateToken(await this.provider.login(this.options.loginTimeoutSeconds * 1000));
      await this.store.save(this.key, token);
      return publicToken(token);
    });
  }
  token() {
    return this.loadToken(false);
  }
  tokenOrLogin() {
    return this.loadToken(true);
  }
  async tokenWithLogin(login) {
    if (login === true)
      return this.login();
    if (login === false)
      return this.token();
    return this.tokenOrLogin();
  }
  forceRefresh(login = true) {
    return this.refreshRejected(undefined, login);
  }
  refreshRejectedToken(staleAccessToken, login = true) {
    return this.refreshRejected(staleAccessToken, login);
  }
  async logout() {
    await this.withLock(() => this.store.remove(this.key));
  }
  async loadToken(login) {
    const existing = await this.store.load(this.key);
    if (existing && this.canReuse(existing))
      return publicToken(existing);
    return this.withLock(async () => {
      const current = await this.store.load(this.key);
      if (current && this.canReuse(current))
        return publicToken(current);
      return this.renew(current, login);
    });
  }
  async refreshRejected(staleAccessToken, login) {
    return this.withLock(async () => {
      const current = await this.store.load(this.key);
      if (staleAccessToken && current?.accessToken && current.accessToken !== staleAccessToken && isValid(current, this.now())) {
        return publicToken(current);
      }
      return this.renew(current, login);
    });
  }
  async renew(current, login) {
    let token;
    if (current) {
      try {
        token = await this.provider.refresh(current);
      } catch (error) {
        if (!login)
          throw error;
        token = await this.provider.login(this.options.loginTimeoutSeconds * 1000);
      }
    } else if (this.provider.canAuthenticateSilently()) {
      token = await this.provider.authenticate(this.options.loginTimeoutSeconds * 1000);
    } else if (login) {
      token = await this.provider.login(this.options.loginTimeoutSeconds * 1000);
    } else {
      throw new AuthError("oauth", "No stored credential is available and interactive login is disabled");
    }
    token = validateToken(token, current);
    await this.store.prepareWrite();
    await this.store.save(this.key, token);
    return publicToken(token);
  }
  canReuse(token) {
    if (!isValid(token, this.now()))
      return false;
    if (!token.expiry)
      return true;
    return Date.parse(token.expiry) - this.now().getTime() > this.options.refreshBufferSeconds * 1000;
  }
  async withLock(action) {
    const lease = await this.store.acquireLock(this.key, this.options.lockTimeoutSeconds * 1000);
    let failure;
    try {
      return await action();
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        await this.store.releaseLock(lease);
      } catch (releaseError) {
        if (failure === undefined)
          throw releaseError;
      }
    }
  }
}
function publicToken(token) {
  return {
    accessToken: token.accessToken,
    tokenType: token.tokenType,
    ...token.expiry ? { expiry: token.expiry } : {},
    scopes: [...token.scopes]
  };
}
function validateToken(token, previous) {
  if (!token.accessToken.trim())
    throw new AuthError("oauth", "Token response did not contain an access token");
  return {
    accessToken: token.accessToken,
    tokenType: token.tokenType || "Bearer",
    refreshToken: token.refreshToken ?? previous?.refreshToken,
    expiry: token.expiry,
    scopes: token.scopes.length ? [...token.scopes] : [...previous?.scopes ?? []]
  };
}
function isValid(token, now) {
  return Boolean(token.accessToken) && (!token.expiry || Date.parse(token.expiry) > now.getTime());
}

// packages/js/node/auth/src/types.ts
var AUTH_DEFAULTS = {
  refreshBufferSeconds: 300,
  lockTimeoutSeconds: 30,
  loginTimeoutSeconds: 900
};
var AuthOptions = {
  create(options = {}) {
    return { ...AUTH_DEFAULTS, ...options };
  },
  defaults() {
    return Object.freeze({ ...AUTH_DEFAULTS });
  }
};

// packages/js/node/auth/src/_python-bridge.ts
function createAuthClient(key, provider, store, options = {}) {
  const client = new AuthClient(key, provider, store, AuthOptions.create(options));
  return {
    storeName: () => client.storeName(),
    login: () => client.login(),
    token: (login) => client.tokenWithLogin(login),
    forceRefresh: (login) => client.forceRefresh(login),
    refreshRejectedToken: (staleAccessToken, login) => client.refreshRejectedToken(staleAccessToken, login),
    logout: () => client.logout()
  };
}
