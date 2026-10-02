import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { asyncUtils } from "@dbx-tools/shared-core";
import { withWorkspaceMutationLock } from "../src/workspace-lock.ts";

it("serializes generated workspace mutations for one repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "dbx-tools-workspace-lock-"));
  let active = 0;
  let maximum = 0;
  const mutation = async (): Promise<void> => {
    active += 1;
    maximum = Math.max(maximum, active);
    await asyncUtils.sleep(25);
    active -= 1;
  };
  try {
    await Promise.all([
      withWorkspaceMutationLock(root, mutation),
      withWorkspaceMutationLock(root, mutation),
    ]);
    assert.equal(maximum, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
