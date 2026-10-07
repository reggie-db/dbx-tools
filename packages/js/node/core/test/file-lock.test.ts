import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { acquireFileLock, withFileLock, type FileLockBackend } from "../src/file-lock.ts";

const require = createRequire(import.meta.url);

describe("withFileLock", () => {
  it("uses the portable file protocol by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dbx-file-lock-"));
    try {
      let backend: FileLockBackend | undefined;
      await withFileLock("default", () => undefined, {
        dir,
        onAcquire: ({ backend: acquired }) => {
          backend = acquired;
        },
      });
      assert.equal(backend, "file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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
      let waits = 0;
      const options = {
        dir,
        backends: ["file"] as const,
        onWait: () => {
          waits += 1;
        },
      };
      await Promise.all([
        withFileLock(
          "shared",
          async () => {
            order.push(1);
            await new Promise((r) => setTimeout(r, 40));
            order.push(2);
          },
          options,
        ),
        withFileLock(
          "shared",
          async () => {
            order.push(3);
            order.push(4);
          },
          options,
        ),
      ]);
      assert.match(order.join(","), /^(1,2,3,4|3,4,1,2)$/);
      assert.equal(waits, 1);
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

  it("coordinates the default protocol with a plain Node process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dbx-file-lock-"));
    const script = join(dir, "holder.cjs");
    try {
      await writeFile(
        script,
        `
const lockfile = require(process.argv[3]);
const target = process.argv[2];
const mode = process.argv[4];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const acquire = async () => {
  for (;;) {
    try {
      return await lockfile.lock(target, {
        realpath: false,
        stale: 10000,
        update: 5000,
        retries: 0,
      });
    } catch (error) {
      if (error?.code !== "ELOCKED") throw error;
      await sleep(25);
    }
  }
};
void (async () => {
  const release = await acquire();
  process.stdout.write("locked\\n");
  if (mode === "hold") {
    process.stdin.once("data", async () => {
      await release();
      process.exit(0);
    });
  } else {
    await release();
  }
})();
`,
      );

      let releaseParent!: () => void;
      let target = "";
      const parent = withFileLock(
        "cross-runtime",
        async () => {
          const [entry] = (await readdir(dir)).filter((name) => name.endsWith(".lock"));
          assert.ok(entry);
          target = join(dir, entry.slice(0, -".lock".length));
          await new Promise<void>((resolve) => {
            releaseParent = resolve;
          });
        },
        { dir },
      );
      while (!releaseParent) await new Promise((resolve) => setTimeout(resolve, 1));

      const modulePath = require.resolve("proper-lockfile");
      const waiter = spawn("node", [script, target, modulePath, "once"], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      let waiterOutput = "";
      waiter.stdout.setEncoding("utf8");
      waiter.stdout.on("data", (chunk) => {
        waiterOutput += chunk;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(waiterOutput, "");
      releaseParent();
      await parent;
      await new Promise<void>((resolve, reject) => {
        waiter.once("error", reject);
        waiter.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`Node waiter exited ${code}`)),
        );
      });
      assert.equal(waiterOutput, "locked\n");

      const holder = spawn("node", [script, target, modulePath, "hold"], {
        stdio: ["pipe", "pipe", "inherit"],
      });
      holder.stdout.setEncoding("utf8");
      await new Promise<void>((resolve, reject) => {
        holder.once("error", reject);
        holder.stdout.once("data", (chunk) => {
          assert.equal(chunk, "locked\n");
          resolve();
        });
      });
      await assert.rejects(
        withFileLock("cross-runtime", () => undefined, {
          dir,
          timeoutMs: 50,
        }),
        /Timed out waiting for file lock/,
      );
      holder.stdin.write("release\n");
      await new Promise<void>((resolve, reject) => {
        holder.once("error", reject);
        holder.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`Node holder exited ${code}`)),
        );
      });
      assert.equal(await withFileLock("cross-runtime", () => "ok", { dir }), "ok");
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
      if (!(await flockAvailable(dir))) return;
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
      if (!(await flockAvailable(dir))) return;
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

async function flockAvailable(dir: string): Promise<boolean> {
  try {
    await withFileLock("flock-probe", () => undefined, { dir, backends: ["flock"] });
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === "withFileLock: no lock backend available") {
      return false;
    }
    throw error;
  }
}

describe("acquireFileLock", () => {
  it("returns an idempotent explicit lease", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dbx-file-lock-"));
    try {
      const first = await acquireFileLock("explicit", { dir, timeoutMs: 250 });
      await assert.rejects(
        acquireFileLock("explicit", { dir, timeoutMs: 50 }),
        /Timed out waiting for file lock/,
      );
      await first.release();
      await first.release();
      const second = await acquireFileLock("explicit", { dir, timeoutMs: 250 });
      await second.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
