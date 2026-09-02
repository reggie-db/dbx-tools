/**
 * Docker and Podman host-gateway discovery.
 *
 * @module
 */

import { networkInterfaces } from "node:os";
import { exec } from "@dbx-tools/core";
import { error, json, log, object, string } from "@dbx-tools/shared-core";

import type { ContainerEngine } from "./config.ts";

const logger = log.logger("token-broker/network");
const ENGINE_INSPECT_TIMEOUT_MS = 5_000;

/**
 * Merge explicit binds with Docker/Podman gateways that are real local
 * interfaces. Automatic discovery ignores missing engines and VM-only
 * gateways; an explicitly selected engine reports probe failures. Every probe
 * is bounded and this function never widens to a wildcard address.
 */
export async function resolveBindAddresses(
  configured: readonly string[],
  engine: ContainerEngine | undefined,
  execute: typeof exec.spawnSync = exec.spawnSync,
): Promise<string[]> {
  const addresses = new Set(configured);
  if (!engine) return [...addresses];
  const engines = engine === "auto" ? (["docker", "podman"] as const) : [engine];
  const local = localAddresses();
  for (const command of engines) {
    for (const gateway of engineGateways(command, execute, engine !== "auto")) {
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

function engineGateways(
  engine: "docker" | "podman",
  execute: typeof exec.spawnSync,
  required: boolean,
): string[] {
  const network = engine === "docker" ? "bridge" : "podman";
  let result: ReturnType<typeof exec.spawnSync>;
  try {
    result = execute(engine, ["network", "inspect", network], {
      stdin: "ignore",
      stdout: "capture",
      stderr: "capture",
      check: false,
      timeout: ENGINE_INSPECT_TIMEOUT_MS,
    });
  } catch (cause) {
    if (required) throw cause;
    logger.warn("container gateway discovery failed", {
      engine,
      error: error.errorMessage(cause),
    });
    return [];
  }
  if (result.exitCode === 127 && !required) return [];
  if (result.exitCode !== 0) {
    const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
    if (required) throw new Error(`${engine} gateway discovery failed: ${detail}`);
    logger.warn("container gateway discovery failed", { engine, error: detail });
    return [];
  }
  const parsed: unknown = json.parse(result.stdout, undefined);
  if (!Array.isArray(parsed)) {
    const message = `${engine} gateway discovery returned invalid JSON`;
    if (required) throw new TypeError(message);
    logger.warn("container gateway discovery failed", { engine, error: message });
    return [];
  }
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
