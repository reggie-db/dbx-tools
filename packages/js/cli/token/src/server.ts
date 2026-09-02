/**
 * Local HTTP/mTLS token broker server.
 *
 * @module
 */

import { readFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP } from "node:net";
import type { TLSSocket } from "node:tls";
import { error, json, log, net, string } from "@dbx-tools/shared-core";

import { AuthorizationError, authorizeClient } from "./auth.ts";
import type { TokenBroker } from "./broker.ts";
import type { ResolvedTokenConfig, TokenProviderName } from "./config.ts";
import type { BrokerTlsMaterial } from "./tls.ts";

const logger = log.logger("token-broker/server");
const MAX_BODY_BYTES = 64 * 1024;

export interface TokenServer {
  /** Reachable listener URLs. */
  urls: string[];
  /** Stop every listener and broker refresh timer. */
  close(): Promise<void>;
}

/**
 * Start one listener per bind address over plain HTTP or mandatory-client-cert
 * HTTPS. Plain HTTP is loopback-only regardless of password/JWT mode, preventing
 * reusable credentials from crossing a container or LAN bridge in clear text.
 */
export async function startTokenServer(
  broker: TokenBroker,
  config: ResolvedTokenConfig,
  binds: readonly string[],
  tls?: BrokerTlsMaterial,
): Promise<TokenServer> {
  if (config.tls === "none" && binds.some((bind) => !isLoopback(bind))) {
    throw new TypeError("Plain HTTP token broker must bind only to loopback");
  }
  if (config.tls === "mtls" && !tls) throw new TypeError("mTLS configuration is required");
  const credentials =
    config.tls === "mtls" && tls
      ? {
          ca: await readFile(tls.ca),
          cert: await readFile(tls.cert),
          key: tls.keyPem,
          requestCert: true,
          rejectUnauthorized: true,
        }
      : undefined;
  const servers: ReturnType<typeof createHttpServer>[] = [];
  const allowedHosts = new Set([...config.allowedHosts, ...binds].map(normalizeHost));
  const handler = (request: IncomingMessage, response: ServerResponse) =>
    void handleRequest(broker, config, allowedHosts, request, response);
  try {
    for (const bind of binds) {
      const server = credentials
        ? createHttpsServer(credentials, handler)
        : createHttpServer(handler);
      await listen(server, config.port, bind);
      servers.push(server);
    }
  } catch (cause) {
    await Promise.all(servers.map(closeServer));
    throw cause;
  }
  const scheme = config.tls === "mtls" ? "https" : "http";
  const urls = binds.map((bind) => `${scheme}://${urlHost(bind)}:${config.port}`);
  logger.info("ready", { urls, auth: authSummary(config) });
  return {
    urls,
    close: async () => {
      broker.close();
      await Promise.all(servers.map(closeServer));
    },
  };
}

function authSummary(config: ResolvedTokenConfig): string {
  return config.tls === "mtls" ? `mtls+${config.auth}` : config.auth;
}

async function handleRequest(
  broker: TokenBroker,
  config: ResolvedTokenConfig,
  allowedHosts: ReadonlySet<string>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const host = normalizeHost(request.headers.host ?? "");
    if (!allowedHosts.has(host)) {
      sendJson(response, 421, { error: "host is not allowed" });
      return;
    }
    const path = new URL(request.url ?? "/", "http://broker.local").pathname;
    if (request.method === "GET" && path === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method !== "POST" || path !== "/v1/access-token") {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    const grant = await authorizeClient({
      mode: config.auth,
      authorization: string.trimToNull(request.headers.authorization) ?? undefined,
      password: config.password,
      signingSecret: config.signingSecret,
      certificateName: certificateName(request),
    });
    const body = await requestBody(request);
    const provider = tokenProvider(body.provider ?? config.provider);
    const requestedScopes = Array.isArray(body.scopes)
      ? body.scopes.filter((scope): scope is string => typeof scope === "string")
      : [];
    const scopes = requestedScopes.length > 0 ? requestedScopes : config.scopes;
    if (grant.providers.length > 0 && !grant.providers.includes(provider)) {
      throw new AuthorizationError(`Client is not allowed to use provider ${provider}`);
    }
    if (grant.scopes) {
      const granted = new Set(grant.scopes);
      const denied = scopes.filter((scope) => !granted.has(scope));
      if (denied.length > 0) {
        throw new AuthorizationError("Client is not allowed to use requested scopes");
      }
    }
    const token = await broker.accessToken({ provider, scopes });
    sendJson(response, 200, {
      access_token: token.accessToken,
      token_type: token.tokenType,
      expires_at: new Date(token.expiresAt).toISOString(),
      expires_in: Math.max(0, Math.floor((token.expiresAt - Date.now()) / 1000)),
      scopes: token.scopes,
    });
  } catch (cause) {
    const status =
      cause instanceof AuthorizationError ? 401 : cause instanceof TypeError ? 400 : 503;
    sendJson(response, status, { error: error.errorMessage(cause) });
  }
}

function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let source = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      source += chunk;
      if (Buffer.byteLength(source) > MAX_BODY_BYTES) {
        reject(new TypeError("request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(json.parseRecord(source) ?? {}));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

function certificateName(request: IncomingMessage): string | undefined {
  const socket = request.socket as TLSSocket;
  if (typeof socket.getPeerCertificate !== "function") return undefined;
  const certificate = socket.getPeerCertificate();
  return string.trimToNull(certificate.subject?.CN) ?? undefined;
}

function tokenProvider(value: unknown): TokenProviderName {
  if (value === "google") return value;
  throw new TypeError("Unsupported token provider");
}

function normalizeHost(value: string): string {
  const host = value.trim().toLowerCase();
  const ipv6End = host.indexOf("]");
  if (host.startsWith("[") && ipv6End > 1) return host.slice(1, ipv6End);
  return host.split(":")[0] ?? "";
}

function isLoopback(host: string): boolean {
  const normalized = normalizeHost(host);
  return net.isLoopbackHost(`http://${urlHost(normalized)}`);
}

function urlHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

function listen(
  server: ReturnType<typeof createHttpServer>,
  port: number,
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((cause) => (cause ? reject(cause) : resolve()));
  });
}
