import * as oauth from "oauth4webapi";

import { AuthError } from "./_errors.ts";
import { authLogger, failureMetadata, tokenMetadata } from "./_logging.ts";
import type { Token, TokenProvider } from "./_types.ts";

const logger = authLogger("service-principal");

/** Client-credentials inputs and transport options for Databricks OAuth. */
export interface DatabricksServicePrincipalConfig {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  groupId?: string;
  fetch?: typeof globalThis.fetch;
  allowInsecureRequests?: boolean;
}

/** Databricks service-principal provider backed by client credentials. */
export class DatabricksServicePrincipalProvider implements TokenProvider {
  private readonly authorizationServer: oauth.AuthorizationServer;
  private readonly client: oauth.Client;
  private readonly requestOptions: oauth.HttpRequestOptions<string, URLSearchParams>;

  constructor(private readonly config: DatabricksServicePrincipalConfig) {
    this.authorizationServer = {
      issuer: new URL(config.tokenEndpoint).origin,
      token_endpoint: config.tokenEndpoint,
    };
    this.client = { client_id: config.clientId };
    this.requestOptions = {
      ...(config.fetch ? { [oauth.customFetch]: config.fetch as typeof globalThis.fetch } : {}),
      ...(config.allowInsecureRequests ? { [oauth.allowInsecureRequests]: true } : {}),
    };
  }

  authenticate(): Promise<Token> {
    return this.acquire();
  }

  login(): Promise<Token> {
    return this.acquire();
  }

  refresh(): Promise<Token> {
    return this.acquire();
  }

  canAuthenticateSilently(): boolean {
    return true;
  }

  private async acquire(): Promise<Token> {
    logger.debug("requesting service-principal token", {
      tokenOrigin: new URL(this.config.tokenEndpoint).origin,
      scopeCount: this.config.scopes.length,
      hasGroupId: Boolean(this.config.groupId),
      allowInsecureRequests: Boolean(this.config.allowInsecureRequests),
    });
    try {
      const response = await oauth.clientCredentialsGrantRequest(
        this.authorizationServer,
        this.client,
        oauth.ClientSecretBasic(this.config.clientSecret),
        {
          scope: [...new Set(this.config.scopes)].sort().join(" "),
          ...(this.config.groupId ? { assume_group: this.config.groupId } : {}),
        },
        this.requestOptions,
      );
      const value = await oauth.processClientCredentialsResponse(
        this.authorizationServer,
        this.client,
        response,
      );
      const token = {
        accessToken: value.access_token,
        tokenType: value.token_type.toLowerCase() === "bearer" ? "Bearer" : value.token_type,
        ...(value.expires_in !== undefined
          ? { expiry: new Date(Date.now() + value.expires_in * 1000).toISOString() }
          : {}),
        scopes: value.scope?.split(/\s+/).filter(Boolean) ?? [...this.config.scopes],
      };
      logger.debug("received service-principal token", { token: tokenMetadata(token) });
      return token;
    } catch (cause) {
      logger.debug("service-principal token request failed", {
        error: failureMetadata(cause),
      });
      throw new AuthError("oauth", "Databricks service-principal authentication failed", {
        cause,
      });
    }
  }
}
