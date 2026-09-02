/**
 * Docker and Podman host-gateway discovery.
 *
 * @module
 */

import { networkInterfaces } from "node:os";
import { exec } from "@dbx-tools/core";
import { json, object, string } from "@dbx-tools/shared-core";

import type { ContainerEngine } from "./config.ts";

/**
 * Merge explicit binds with Docker/Podman gateways that are real local
 * interfaces. Missing engines and VM-only gateways are ignored; this function
 * never widens to a wildcard address.
 */
export async function resolveBindAddresses(
  configured: readonly string[],
  engine: ContainerEngine | undefined,
  execute: typeof exec.spawn = exec.spawn,
): Promise<string[]> {
  const addresses = new Set(configured);
  if (!engine) return [...addresses];
  const engines = engine === "auto" ? (["docker", "podman"] as const) : [engine];
  const local = localAddresses();
  for (const command of engines) {
    for (const gateway of await engineGateways(command, execute)) {
      if (local.has(gateway)) addresses.add(gateway);
    }
  }
  return [...addresses];
}

/** Snapshot every address currently assigned to the host plus loopback. */
export function localAddresses(): Set<string> {
  const result = new Set(["127.0.0.1", "::1"]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) result.add(entry.address);
  }
  return result;
}

async function engineGateways(
  engine: "docker" | "podman",
  execute: typeof exec.spawn,
): Promise<string[]> {
  const network = engine === "docker" ? "bridge" : "podman";
  const result = await execute(engine, ["network", "inspect", network], {
    stdout: "capture",
    stderr: "capture",
    check: false,
  }).catch(() => undefined);
  if (!result || result.exitCode !== 0) return [];
  const parsed: unknown = json.parse(result.stdout, undefined);
  if (!Array.isArray(parsed)) return [];
  const gateways: string[] = [];
  for (const item of parsed) collectGateways(item, gateways);
  return [...new Set(gateways)];
}

function collectGateways(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectGateways(item, output);
    return;
  }
  if (!object.isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (key.toLowerCase() === "gateway") {
      const gateway = string.trimToNull(nested);
      if (gateway) output.push(gateway);
    } else {
      collectGateways(nested, output);
    }
  }
}
