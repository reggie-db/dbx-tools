import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "@dbx-tools/shared-core";
import { plugin as tunnel } from "@dbx-tools/tunnel";
import tailwindcss from "@tailwindcss/vite";
import { createLogger, defineConfig } from "vite";

/**
 * Loaded by AppKit `server()` in development when `staticPath` is omitted.
 * AppKit merges React, type-generation, and middleware-mode HMR on top.
 *
 * `@` matches `tsconfig.json` `paths`. `server.allowedHosts` uses
 * `resolveAuthGateConfig` (the same gate resolution `dbx tunnel` flags call)
 * so Vite accepts the public Host header.
 */
const root = path.dirname(fileURLToPath(import.meta.url));
const tunnelHosts = tunnelAllowedHosts();

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      "@": path.join(root, "src"),
    },
  },
  ...(log.isLevelEnabled("debug")
    ? {}
    : { logLevel: "silent", customLogger: createLogger("silent") }),
  ...(tunnelHosts.length > 0 ? { server: { allowedHosts: tunnelHosts } } : {}),
});

/** Hostnames Vite should accept when a public tunnel is configured. */
function tunnelAllowedHosts(): string[] {
  const hosts = new Set<string>();
  for (const value of tunnel.resolveAuthGateConfig({}).publicDomains) {
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
