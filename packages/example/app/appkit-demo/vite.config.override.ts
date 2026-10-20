import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLevelEnabled } from "@dbx-tools/shared-core";
import { resolveAuthGateConfig } from "@dbx-tools/tunnel";
import { createLogger, defineConfig } from "vite";

/**
 * Extend the generated AppKit Vite configuration with demo tunnel behavior.
 */
const root = path.dirname(fileURLToPath(import.meta.url));
const tunnelHosts = tunnelAllowedHosts();

export default defineConfig({
  resolve: {
    alias: {
      "@": path.join(root, "src"),
    },
  },
  ...(isLevelEnabled("debug") ? {} : { logLevel: "silent", customLogger: createLogger("silent") }),
  ...(tunnelHosts.length > 0 ? { server: { allowedHosts: tunnelHosts } } : {}),
});

/** Hostnames Vite should accept when a public tunnel is configured. */
function tunnelAllowedHosts(): string[] {
  const hosts = new Set<string>();
  for (const value of resolveAuthGateConfig({}).publicDomains) {
    const host = hostnameFrom(value);
    if (host) hosts.add(host);
  }
  return [...hosts];
}

function hostnameFrom(value: string): string | undefined {
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname;
  } catch {
    return undefined;
  }
}
