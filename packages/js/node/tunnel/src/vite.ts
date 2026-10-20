/**
 * Vite host configuration derived from the tunnel auth-gate owner.
 *
 * @module
 */
import { resolveAuthGateConfig, type AuthGateConfig } from "./plugin.ts";

/** Hostnames Vite should accept for configured public tunnel domains. */
export function tunnelAllowedHosts(config: AuthGateConfig = {}): string[] {
  const hosts = new Set<string>();
  for (const value of resolveAuthGateConfig(config).publicDomains) {
    const host = hostname(value);
    if (host) hosts.add(host);
  }
  return [...hosts];
}

function hostname(value: string): string | undefined {
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname;
  } catch {
    return undefined;
  }
}
