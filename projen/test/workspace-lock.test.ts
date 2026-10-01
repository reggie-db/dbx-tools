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
