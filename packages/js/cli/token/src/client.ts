/**
 * Broker client for short-lived provider access tokens.
 *
 * @module
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { json, string } from "@dbx-tools/shared-core";

import type { BrokerAuthMode, TokenProviderName } from "./config.ts";

/** Connection, authorization, provider, and scope inputs for one broker call. */
export interface BrokerClientOptions {
  /** Broker base URL. */
  url: string;
  /** Provider requested from the broker. */
  provider: TokenProviderName;
  /** Explicit scopes; empty asks the server to use its defaults. */
  scopes: readonly string[];
  /** Client authentication mode expected by the server. */
  auth: BrokerAuthMode;
  /** Shared password or signed client JWT. */
  credential: string;
}

/** Request and return only the short-lived provider access-token string. */
export async function requestAccessToken(options: BrokerClientOptions): Promise<string> {
  const url = new URL("/v1/access-token", options.url);
  const body = JSON.stringify({ provider: options.provider, scopes: options.scopes });
  const authorization =
    options.auth === "jwt"
      ? `Bearer ${options.credential}`
      : `Basic ${Buffer.from(`token:${options.credential}`).toString("base64")}`;
  const response = await requestJson(url, body, authorization);
  const accessToken = string.trimToNull(response.access_token);
  if (!accessToken) {
    throw new Error(string.trimToNull(response.error) ?? "Broker returned no access token");
  }
  return accessToken;
}

async function requestJson(
  url: URL,
  body: string,
  authorization: string,
): Promise<Record<string, unknown>> {
  const secure = url.protocol === "https:";
  const request = secure ? httpsRequest : httpRequest;
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (incoming) => {
        let source = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => (source += chunk));
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 500, body: source }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
  const parsed = json.parseRecord(response.body) ?? {};
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      string.trimToNull(parsed.error) ?? `Broker request failed with ${response.status}`,
    );
  }
  return parsed;
}
