import { authLogger } from "./_logging.ts";
import { AuthError } from "./errors.ts";
import {
  createPersistentAuth,
  type DatabricksAuthDependencies,
  PersistentAuth,
} from "./databricks-auth.ts";
import type { DatabricksAuthOptions } from "./types.ts";
import { DEFAULT_ACCESS_TOKEN_HEADER, WORKSPACE_ID_HEADER } from "./types.ts";

const logger = authLogger("http");

/** Options for one Databricks JSON API request. */
export interface DatabricksRequestOptions {
  method?: string;
  body?: unknown;
  headers?: Headers | Record<string, string> | [string, string][];
  login?: boolean;
  signal?: AbortSignal;
}

/** Dependency-light Databricks JSON client with one rejected-token refresh. */
export class DatabricksClient {
  private constructor(
    readonly auth: PersistentAuth,
    private readonly fetcher: typeof globalThis.fetch,
  ) {}

  static async create(
    options: DatabricksAuthOptions = { preferUserToMachine: true },
    dependencies: DatabricksAuthDependencies = {},
  ): Promise<DatabricksClient> {
    const client = new DatabricksClient(
      await createPersistentAuth(options, undefined, dependencies),
      dependencies.fetch ?? globalThis.fetch,
    );
    logger.debug("created Databricks HTTP client", {
      profile: client.profile(),
      host: client.host(),
      hasWorkspaceId: Boolean(client.workspaceId()),
    });
    return client;
  }

  profile(): string {
    return this.auth.status().profile;
  }

  host(): string {
    return this.auth.status().host;
  }

  principal(): string {
    return this.auth.principal();
  }

  workspaceId(): string | undefined {
    return this.auth.workspaceId();
  }

  async request(path: string, options: DatabricksRequestOptions = {}): Promise<unknown> {
    const url = new URL(path, `${this.host().replace(/\/$/, "")}/`).toString();
    const method = options.method ?? (options.body === undefined ? "GET" : "POST");
    const requestUrl = new URL(url);
    logger.debug("sending Databricks API request", {
      method,
      origin: requestUrl.origin,
      path: requestUrl.pathname,
      hasBody: options.body !== undefined,
      login: options.login ?? "auto",
    });
    let authHeaders = await this.auth.authenticate(options.login);
    let response = await this.send(url, method, authHeaders, options);
    logger.debug("received Databricks API response", {
      method,
      path: requestUrl.pathname,
      status: response.status,
      attempt: 1,
    });
    if (response.status === 401) {
      logger.debug("refreshing rejected Databricks API credential", {
        method,
        path: requestUrl.pathname,
      });
      await this.auth.refreshRejectedToken(
        accessTokenFromHeaders(authHeaders),
        options.login ?? true,
      );
      authHeaders = await this.auth.authenticate(false);
      response = await this.send(url, method, authHeaders, options);
      logger.debug("received Databricks API response", {
        method,
        path: requestUrl.pathname,
        status: response.status,
        attempt: 2,
      });
    }
    const text = await response.text();
    if (!response.ok)
      throw new AuthError(
        "http",
        `Databricks API ${path} returned HTTP ${response.status}: ${text}`,
      );
    if (!text) {
      logger.debug("Databricks API response had no body", {
        method,
        path: requestUrl.pathname,
      });
      return undefined;
    }
    try {
      const value = JSON.parse(text);
      logger.debug("parsed Databricks API JSON response", {
        method,
        path: requestUrl.pathname,
      });
      return value;
    } catch (cause) {
      throw new AuthError("http", `Databricks API ${path} did not return JSON`, { cause });
    }
  }

  private send(
    url: string,
    method: string,
    authHeaders: Record<string, string>,
    options: DatabricksRequestOptions,
  ): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.delete(DEFAULT_ACCESS_TOKEN_HEADER);
    headers.delete(WORKSPACE_ID_HEADER);
    for (const [name, value] of Object.entries(authHeaders)) headers.set(name, value);
    headers.set("accept", "application/json");
    if (options.body !== undefined) headers.set("content-type", "application/json");
    return this.fetcher(url, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: options.signal,
    });
  }
}

function accessTokenFromHeaders(headers: Record<string, string>): string {
  const authorization = headers[DEFAULT_ACCESS_TOKEN_HEADER];
  const separator = authorization?.indexOf(" ") ?? -1;
  if (separator < 1 || !authorization?.slice(separator + 1).trim()) {
    throw new AuthError("http", "Authentication headers did not contain an access token");
  }
  return authorization.slice(separator + 1).trim();
}
