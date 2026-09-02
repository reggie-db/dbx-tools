/**
 * Broker client for short-lived provider access tokens.
 *
 * @module
 */

import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { json, string } from "@dbx-tools/shared-core";

import type { BrokerAuthMode, TokenProviderName } from "./config.ts";
import type { TlsPaths } from "./tls.ts";

/** Connection, authorization, provider, and scope inputs for one broker call. */
export interface BrokerClientOptions {
  /** Broker base URL. */
  url: string;
  /** Provider requested from the broker. */
  provider: TokenProviderName;
  /** Explicit scopes; empty asks the server to use its defaults. */
  scopes: readonly string[];
  /** Application auth mode expected by the server. */
  auth: BrokerAuthMode;
  /** Password-mode secret. */
  password?: string;
  /** JWT-mode bearer token. */
  clientToken?: string;
  /** mTLS client bundle for HTTPS requests. */
  tls?: TlsPaths;
}

/** Request and return only the short-lived provider access-token string. */
export async function requestAccessToken(options: BrokerClientOptions): Promise<string> {
  const url = new URL("/v1/access-token", options.url);
  const body = JSON.stringify({ provider: options.provider, scopes: options.scopes });
  const authorization =
    options.auth === "jwt"
      ? options.clientToken
        ? `Bearer ${options.clientToken}`
        : undefined
      : options.auth === "password" && options.password
        ? `Basic ${Buffer.from(`token:${options.password}`).toString("base64")}`
        : undefined;
  const response = await requestJson(url, body, authorization, options.tls);
  const accessToken = string.trimToNull(response.access_token);
  if (!accessToken) {
    throw new Error(string.trimToNull(response.error) ?? "Broker returned no access token");
  }
  return accessToken;
}

async function requestJson(
  url: URL,
  body: string,
  authorization: string | undefined,
  tls: TlsPaths | undefined,
): Promise<Record<string, unknown>> {
  const secure = url.protocol === "https:";
  const request = secure ? httpsRequest : httpRequest;
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    void Promise.all([
      tls?.ca ? readFile(tls.ca) : undefined,
      tls?.cert ? readFile(tls.cert) : undefined,
      tls?.key ? readFile(tls.key) : undefined,
    ])
      .then(([ca, cert, key]) => {
        const outgoing = request(
          url,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
              ...(authorization ? { authorization } : {}),
            },
            ...(secure ? { ca, cert, key, servername: url.hostname } : {}),
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
      })
      .catch(reject);
  });
  const parsed = json.parseRecord(response.body) ?? {};
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      string.trimToNull(parsed.error) ?? `Broker request failed with ${response.status}`,
    );
  }
  return parsed;
}
