/** Request-scoped trace tags derived from the configured tunnel transport. */
import type { IncomingMessage } from "node:http";
import { net } from "@dbx-tools/shared-core";

import { resolveFrpConfig } from "./frp.ts";
import { resolveTunnelTransport } from "./interceptor.ts";
import { resolvePortrConfig } from "./portr.ts";

/** MLflow trace tag identifying the tunnel transport. */
export const TUNNEL_TRACE_TAG = "tunnel";
/** MLflow trace tag identifying the public tunnel subdomain. */
export const TUNNEL_SUBDOMAIN_TRACE_TAG = "tunnel_subdomain";

function requestHost(request: IncomingMessage): string | undefined {
  const host = request.headers.host?.trim().toLowerCase().split(":")[0];
  return host || undefined;
}

function matchesHost(request: IncomingMessage, expected: string): boolean {
  return requestHost(request) === expected.trim().toLowerCase().split(":")[0];
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const remoteAddress = request.socket.remoteAddress?.trim();
  if (!remoteAddress) return false;
  const normalized = remoteAddress.startsWith("::ffff:")
    ? remoteAddress.slice("::ffff:".length)
    : remoteAddress;
  return Boolean(net.ipInCidr(normalized, "127.0.0.0/8") || net.ipInCidr(normalized, "::1/128"));
}

/**
 * Return trace tags when one request arrived through the configured Portr or FRP host.
 * Non-tunnel requests return an empty record.
 */
export function requestTunnelTraceTags(request: IncomingMessage): Readonly<Record<string, string>> {
  if (!isLoopbackRequest(request)) return {};
  const transport = resolveTunnelTransport();
  if (transport === "portr" || transport === "both") {
    const config = resolvePortrConfig({ port: 0 });
    if (config) {
      const publicDomain = `${config.subdomain}.${config.server}`;
      if (matchesHost(request, publicDomain)) {
        return {
          [TUNNEL_TRACE_TAG]: "portr",
          [TUNNEL_SUBDOMAIN_TRACE_TAG]: config.subdomain,
        };
      }
    }
  }
  if (transport === "frp" || transport === "both") {
    const config = resolveFrpConfig({ port: 0 });
    if (config && matchesHost(request, config.publicDomain)) {
      return {
        [TUNNEL_TRACE_TAG]: "frp",
        [TUNNEL_SUBDOMAIN_TRACE_TAG]: config.publicDomain.split(".")[0] ?? config.proxyName,
      };
    }
  }
  return {};
}
