import { sleep } from "@dbx-tools/shared-core";
import type { LakeboxStatus } from "@dbx-tools/shared-lakebox";
import type { LakeboxClient, LakeboxEntry } from "./rest.ts";

const POLL_INTERVAL_MS = 1_000;
const LIFECYCLE_TIMEOUT_MS = 300_000;

/** Maps an upstream Lakebox status to the shared lifecycle state. */
export function normalizeLakeboxStatus(value: string): Exclude<LakeboxStatus, "missing"> {
  switch (value.trim().toLowerCase()) {
    case "starting":
    case "provisioning":
    case "pending":
      return "starting";
    case "running":
      return "running";
    case "stopping":
      return "stopping";
    case "stopped":
      return "stopped";
    case "failed":
    case "error":
      return "error";
    default:
      return "unknown";
  }
}

/** Parses an upstream duration such as `600s` into seconds. */
export function lakeboxIdleTimeoutSeconds(value: string | undefined): number | undefined {
  if (!value?.endsWith("s")) return undefined;
  const seconds = Number(value.slice(0, -1));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * Starts a Lakebox when needed and waits until it is running.
 *
 * @throws When the Lakebox does not reach running within five minutes.
 */
export async function ensureLakeboxRunning(
  api: LakeboxClient,
  current: LakeboxEntry,
  signal?: AbortSignal,
): Promise<LakeboxEntry> {
  let entry = current;
  const status = normalizeLakeboxStatus(entry.status);
  if (status === "running") return entry;
  if (status === "starting") return waitForLakeboxStatus(api, entry, "running", signal);
  if (status === "stopping") entry = await waitForLakeboxStatus(api, entry, "stopped", signal);
  return waitForLakeboxStatus(api, await api.start(entry.sandboxId, signal), "running", signal);
}

/**
 * Stops a Lakebox when needed and waits until it is stopped.
 *
 * @throws When the Lakebox does not reach stopped within five minutes.
 */
export async function ensureLakeboxStopped(
  api: LakeboxClient,
  current: LakeboxEntry,
  signal?: AbortSignal,
): Promise<LakeboxEntry> {
  let entry = current;
  const status = normalizeLakeboxStatus(entry.status);
  if (status === "stopped") return entry;
  if (status === "stopping") return waitForLakeboxStatus(api, entry, "stopped", signal);
  if (status === "starting") entry = await waitForLakeboxStatus(api, entry, "running", signal);
  return waitForLakeboxStatus(api, await api.stop(entry.sandboxId, signal), "stopped", signal);
}

async function waitForLakeboxStatus(
  api: LakeboxClient,
  current: LakeboxEntry,
  expected: "running" | "stopped",
  signal?: AbortSignal,
): Promise<LakeboxEntry> {
  const deadline = Date.now() + LIFECYCLE_TIMEOUT_MS;
  let entry = current;
  while (normalizeLakeboxStatus(entry.status) !== expected) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Lakebox ${entry.sandboxId} to become ${expected}`);
    }
    await sleep(POLL_INTERVAL_MS, signal);
    entry = await api.get(entry.sandboxId, signal);
  }
  return entry;
}
