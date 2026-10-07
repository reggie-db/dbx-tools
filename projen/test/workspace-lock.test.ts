import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { asyncUtils } from "@dbx-tools/shared-core";
import { withWorkspaceMutationLock } from "../src/workspace-lock.ts";

it("does not acquire the lock when check fails before wait", async () => {
  const root = mkdtempSync(join(tmpdir(), "dbx-tools-workspace-lock-"));
  let holderDone = false;
  try {
    const holder = withWorkspaceMutationLock(root, async () => {
      await asyncUtils.sleep(80);
      holderDone = true;
    });
    await asyncUtils.sleep(10);
    let ran = false;
    const skipped = await withWorkspaceMutationLock(
      root,
      () => {
        ran = true;
      },
      { check: () => false },
    );
    assert.equal(ran, false);
    assert.equal(skipped, undefined);
    assert.equal(holderDone, false);
    await holder;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("logs prolonged waits every five seconds until acquisition", async () => {
  const root = mkdtempSync(join(tmpdir(), "dbx-tools-workspace-lock-"));
  let release!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const holder = withWorkspaceMutationLock(root, async () => {
    markStarted();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await started;

  const originalWrite = process.stderr.write;
  const originalSetInterval = globalThis.setInterval;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  // Accelerate only the wait logger; the file lock continues using its normal timeout polling.
  globalThis.setInterval = ((callback: () => void) =>
    originalSetInterval(callback, 20)) as typeof setInterval;
  let waiter: Promise<unknown> | undefined;
  try {
    waiter = withWorkspaceMutationLock(root, () => undefined);
    await asyncUtils.sleep(10);
    assert.doesNotMatch(output, /waiting for workspace mutation lock/);

    await asyncUtils.sleep(55);
    const waiting = output.match(/waiting for workspace mutation lock/g) ?? [];
    const elapsed = output.match(/elapsedMs:\s*\d+/g) ?? [];
    assert.ok(waiting.length >= 2, output);
    assert.equal(elapsed.length, waiting.length, output);

    release();
    await Promise.all([holder, waiter]);
    const acquiredOutput = output;
    await asyncUtils.sleep(25);
    assert.equal(output, acquiredOutput);
  } finally {
    release();
    try {
      await Promise.all([holder, waiter]);
    } finally {
      process.stderr.write = originalWrite;
      globalThis.setInterval = originalSetInterval;
      rmSync(root, { recursive: true, force: true });
    }
  }
});

it("re-checks after acquire and skips the callback when work is gone", async () => {
  const root = mkdtempSync(join(tmpdir(), "dbx-tools-workspace-lock-"));
  let needed = true;
  let ran = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  try {
    const holder = withWorkspaceMutationLock(
      root,
      async () => {
        ran += 1;
        markStarted();
        await asyncUtils.sleep(40);
        needed = false;
      },
      { check: () => needed },
    );
    await started;
    await Promise.all([
      holder,
      withWorkspaceMutationLock(
        root,
        () => {
          ran += 1;
        },
        { check: () => needed },
      ),
    ]);
    assert.equal(ran, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
