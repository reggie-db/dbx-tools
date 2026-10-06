/**
 * Browser-safe Databricks upstream URLs for deterministic gateway routes.
 *
 * This module owns direct-route URL construction for browser, edge, and Node
 * consumers. Reuse {@link upstreamUrl} instead of duplicating Databricks model
 * serving paths in transports or user interfaces.
 *
 * @module
 */

import type { GatewayRoute } from "./contracts.ts";

/** Resolve the exact upstream URL for a deterministic direct route. */
export function upstreamUrl(host: string, route: GatewayRoute): string {
  switch (route.upstreamProtocol) {
    case "databricks-ai-gateway-codex":
      return url(host, "/ai-gateway/codex/v1/responses");
    case "databricks-responses":
      return url(host, "/serving-endpoints/responses");
    case "databricks-open-responses":
      return url(host, "/serving-endpoints/open-responses");
    case "databricks-chat":
      return url(host, "/serving-endpoints/chat/completions");
    case "databricks-anthropic":
      return url(host, "/serving-endpoints/anthropic/v1/messages");
    case "databricks-embeddings":
      return url(
        host,
        `/serving-endpoints/${encodeURIComponent(route.upstreamModel)}/invocations`,
      );
    case "ai-sdk":
      throw new Error("AI SDK routes do not use the direct Databricks transport");
  }
}

function url(host: string, path: string): string {
  return new URL(path, `${host.replace(/\/$/, "")}/`).toString();
}
