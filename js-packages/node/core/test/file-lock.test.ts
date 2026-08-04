import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { withFileLock, type FileLockBackend } from "../src/file-lock.ts";

describe("withFileLock", () => {
  it("runs the callback and releases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dbx-file-lock-"));
    try {
      let ran = false;
      const value = await withFileLock(
        "solo",
        async () => {
          ran = true;
          return 7;
        },
        { dir, backends: ["file"] },
      );
      assert.equal(value, 7);
      assert.equal(ran, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent file-lock holders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dbx-file-lock-"));
    try {
      const order: number[] = [];
      await Promise.all([
        withFileLock(
          "shared",
          async () => {
            order.push(1);
            await new Promise((r) => setTimeout(r, 40));
            order.push(2);
          },
          { dir, backends: ["file"] },
        ),
        withFileLock(
          "shared",
          async () => {
            order.push(3);
            order.push(4);
          },
          { dir, backends: ["file"] },
        ),
      ]);
      assert.match(order.join(","), /^(1,2,3,4|3,4,1,2)$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("polls forever by default and supports an optional timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dbx-file-lock-"));
    try {
      let release!: () => void;
      const held = withFileLock(
        "timeout",
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        { dir, backends: ["file"] },
      );
      while (!release) await new Promise((resolve) => setTimeout(resolve, 1));

      await assert.rejects(
        withFileLock("timeout", () => undefined, {
          dir,
          backends: ["file"],
          timeoutMs: 25,
        }),
        /Timed out waiting for file lock/,
      );

      release();
      await held;
      assert.equal(
        await withFileLock("timeout", () => "acquired", {
          dir,
          backends: ["file"],
        }),
        "acquired",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls through to file when flock is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dbx-file-lock-"));
    try {
      let backend: FileLockBackend | undefined;
      const value = await withFileLock("file-fallback", () => "ok", {
        dir,
        backends: ["flock", "file"],
        onAcquire: (a) => {
          backend = a.backend;
        },
      });
      assert.equal(value, "ok");
      assert.ok(backend === "flock" || backend === "file");
      if (process.platform === "win32" || !process.versions.bun) {
        assert.equal(backend, "file");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prefers flock under bun on unix when available", async () => {
    if (process.platform === "win32" || !process.versions.bun) return;

    const dir = await mkdtemp(join(tmpdir(), "dbx-file-lock-"));
    try {
      let backend: FileLockBackend | undefined;
      await withFileLock("flock-check", () => undefined, {
        dir,
        backends: ["flock", "file"],
        onAcquire: (a) => {
          backend = a.backend;
        },
      });
      assert.equal(backend, "flock");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("waits on a held flock instead of falling through to file", async () => {
    if (process.platform === "win32" || !process.versions.bun) return;

    const dir = await mkdtemp(join(tmpdir(), "dbx-file-lock-"));
    try {
      let release!: () => void;
      const first = withFileLock(
        "held-flock",
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        { dir, backends: ["flock", "file"] },
      );
      while (!release) await new Promise((resolve) => setTimeout(resolve, 1));

      const selected: FileLockBackend[] = [];
      await assert.rejects(
        withFileLock("held-flock", () => undefined, {
          dir,
          backends: ["flock", "file"],
          timeoutMs: 25,
          onAcquire: ({ backend }) => selected.push(backend),
        }),
        /Timed out waiting for file lock/,
      );
      assert.deepEqual(selected, ["flock"]);

      release();
      await first;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
