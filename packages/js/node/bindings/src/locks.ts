import { randomUUID } from "node:crypto";

import {
  acquireFileLock as acquireCoreFileLock,
  type FileLockLease,
} from "@dbx-tools/core/file-lock";

import type { FileLockRequest } from "./types.ts";

const leases = new Map<string, FileLockLease>();

/** Acquire a path-keyed cross-process lease and return its opaque ID. */
export async function acquireFileLease(request: FileLockRequest): Promise<string> {
  const path = request.path.trim();
  if (!path) throw new Error("File lock path must not be empty");
  const lease = await acquireCoreFileLock(path, {
    dir: request.lockDirectory,
    timeoutMs: request.timeoutMs,
  });
  const id = randomUUID();
  leases.set(id, lease);
  return id;
}

/** Release an acquired path lease. Repeated release is safe. */
export async function releaseFileLease(id: string): Promise<void> {
  const lease = leases.get(id);
  if (!lease) return;
  leases.delete(id);
  await lease.release();
}

/** Run a Node callback while holding a path-keyed cross-process lock. */
export async function withFileLock<T>(
  path: string,
  action: () => T | Promise<T>,
  options: Omit<FileLockRequest, "path"> = {},
): Promise<T> {
  const lease = await acquireFileLease({ path, ...options });
  try {
    return await action();
  } finally {
    await releaseFileLease(lease);
  }
}

/** Reusable lease adapter for callback-free cross-language contracts. */
export class FileLeaseLocks {
  constructor(private readonly lockDirectory?: string) {}

  acquire(path: string, timeoutMs: number): Promise<string> {
    return acquireFileLease({ path, timeoutMs, lockDirectory: this.lockDirectory });
  }

  release(lease: string): Promise<void> {
    return releaseFileLease(lease);
  }
}
