/**
 * Server-side networking helpers that need Node builtins, layered over the
 * browser-safe URL / IP toolkit in `@dbx-tools/shared-core`'s `net` module: DNS
 * resolution ({@link resolveHostIps}, `node:dns`) and public-IP discovery
 * ({@link getPublicIp}).
 */

import { lookup } from "node:dns/promises";
import { functionModule, net } from "@dbx-tools/shared-core";

import { createFetchError } from "./http";

/**
 * This process's outbound public IP, cached for 5 minutes. Asks Cloudflare's
 * `cdn-cgi/trace` first and falls back to ipify. Useful for allowlisting or for
 * reasoning about egress from a Databricks App.
 */
export const getPublicIp = functionModule.memoize(
  async () => {
    const cloudflareResponse = await fetch("https://cloudflare.com/cdn-cgi/trace");
    if (cloudflareResponse.ok) {
      const trace = await cloudflareResponse.text();
      const ipKey = "ip=";
      const ip = trace
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith(ipKey))
        ?.slice(ipKey.length);
      if (ip) return ip;
    }
    const ipifyResponse = await fetch("https://api.ipify.org?format=json");
    if (!ipifyResponse.ok) {
      throw await createFetchError(ipifyResponse);
    }
    const ipifyData = (await ipifyResponse.json()) as { ip?: string };
    const ip = ipifyData?.ip;
    if (ip) return ip;
    throw new Error("Could not determine public IP");
  },
  { ttlMs: 1000 * 60 * 5 },
);

/**
 * Resolve the host of `input` to its IP address(es) via the OS resolver
 * (`dns.lookup` with `all: true`, so both A and AAAA records are returned when
 * the host is dual-stacked). Accepts any `net.UrlLike` - a bare hostname, a full
 * URL, or a `{ url }` wrapper - and returns the deduplicated list of literal
 * addresses. Never throws: an unparseable input, an IP-literal host (returned
 * as-is without a DNS round-trip), or a resolution failure all yield the
 * appropriate list or `[]`.
 *
 * `dns.lookup` (not `resolve4` / `resolve6`) is used so `/etc/hosts` and the
 * platform resolver order are honored, matching what an outbound connection to
 * the host would actually use.
 */
export async function resolveHostIps(input: net.UrlLike): Promise<string[]> {
  const host = net.urlBuilder(input)?.hostname;
  if (!host) return [];
  // WHATWG `URL.hostname` brackets IPv6 literals; strip before parsing.
  const literal = net.parseIp(host.replace(/^\[|\]$/g, ""));
  if (literal) return [host.replace(/^\[|\]$/g, "")];
  try {
    const results = await lookup(host, { all: true });
    return [...new Set(results.map((r) => r.address))];
  } catch {
    return [];
  }
}
