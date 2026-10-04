import { authLogger } from "./_logging.ts";
import type { Token, TokenProvider } from "./types.ts";

const logger = authLogger("pat");

/** Non-refreshing provider for a configured Databricks personal access token. */
export class DatabricksPersonalAccessTokenProvider implements TokenProvider {
  constructor(private readonly accessToken: string) {}

  authenticate(): Promise<Token> {
    return Promise.resolve(this.token());
  }

  login(): Promise<Token> {
    return Promise.resolve(this.token());
  }

  refresh(): Promise<Token> {
    return Promise.resolve(this.token());
  }

  canAuthenticateSilently(): boolean {
    return true;
  }

  private token(): Token {
    logger.debug("using configured personal access token");
    return {
      accessToken: this.accessToken,
      tokenType: "Bearer",
      scopes: [],
    };
  }
}
