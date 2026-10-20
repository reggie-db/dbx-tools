import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { withWorkspaceMutationLock } from "../src/workspace-lock.ts";

/** Create an explicitly released synchronization point for lock tests. */
function _deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it("does not acquire the lock when check fails before wait", async () => {
  const root = mkdtempSync(join(tmpdir(), "dbx-tools-workspace-lock-"));
  const acquired = _deferred();
  const release = _deferred();
  let holderDone = false;
  const holder = withWorkspaceMutationLock(root, async () => {
    acquired.resolve();
    await release.promise;
    holderDone = true;
  });
  try {
    await acquired.promise;
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
  } finally {
    release.resolve();
    await holder;
    rmSync(root, { recursive: true, force: true });
  }
});

it("logs prolonged waits every five seconds until acquisition", async () => {
  const root = mkdtempSync(join(tmpdir(), "dbx-tools-workspace-lock-"));
  const started = _deferred();
  const release = _deferred();
  const scheduled = _deferred();
  const holder = withWorkspaceMutationLock(root, async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;

  const originalWrite = process.stdout.write;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let output = "";
  let logWait: (() => void) | undefined;
  let timerCleared = false;
  const timer = { unref() {} } as unknown as ReturnType<typeof setInterval>;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  globalThis.setInterval = ((callback: () => void, delay?: number) => {
    assert.equal(delay, 5_000);
    logWait = callback;
    scheduled.resolve();
    return timer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((candidate: ReturnType<typeof setInterval>) => {
    assert.equal(candidate, timer);
    timerCleared = true;
  }) as typeof clearInterval;
  let waiter: Promise<unknown> | undefined;
  try {
    waiter = withWorkspaceMutationLock(root, () => undefined);
    await scheduled.promise;
    assert.doesNotMatch(output, /waiting for workspace mutation lock/);

    logWait!();
    logWait!();
    const waiting = output.match(/waiting for workspace mutation lock/g) ?? [];
    const elapsed = output.match(/elapsedMs:\s*\d+/g) ?? [];
    assert.equal(waiting.length, 2, output);
    assert.equal(elapsed.length, waiting.length, output);

    release.resolve();
    await Promise.all([holder, waiter]);
    assert.equal(timerCleared, true);
  } finally {
    release.resolve();
    try {
      await Promise.all([holder, waiter]);
    } finally {
      process.stdout.write = originalWrite;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
      rmSync(root, { recursive: true, force: true });
    }
  }
});

it("re-checks after acquire and skips the callback when work is gone", async () => {
  const root = mkdtempSync(join(tmpdir(), "dbx-tools-workspace-lock-"));
  const started = _deferred();
  const release = _deferred();
  const waiterChecked = _deferred();
  let needed = true;
  let ran = 0;
  const holder = withWorkspaceMutationLock(root, async () => {
    ran += 1;
    started.resolve();
    await release.promise;
  });
  try {
    await started.promise;
    const waiter = withWorkspaceMutationLock(
      root,
      () => {
        ran += 1;
      },
      {
        check: () => {
          waiterChecked.resolve();
          return needed;
        },
      },
    );
    await waiterChecked.promise;
    needed = false;
    release.resolve();
    await Promise.all([holder, waiter]);
    assert.equal(ran, 1);
  } finally {
    release.resolve();
    await holder;
    rmSync(root, { recursive: true, force: true });
  }
});
