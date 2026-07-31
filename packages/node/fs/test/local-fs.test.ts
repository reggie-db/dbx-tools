import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FileSystemError } from "@dbx-tools/shared-fs";
import { homeFS, LocalFileSystem, tmpFS } from "../src/local-fs.ts";
import { clearOsPathsCache } from "../src/os-path.ts";

async function tempFs(options?: { readOnly?: boolean; contained?: boolean }) {
  const root = await mkdtemp(path.join(tmpdir(), "dbx-local-fs-"));
  const fs = new LocalFileSystem({ root, ...options });
  await fs.init();
  return { fs, root };
}

describe("LocalFileSystem", () => {
  it("reads and writes text and binary", async () => {
    const { fs } = await tempFs();
    await fs.writeFile("note.txt", "hello");
    assert.equal(await fs.readFile("note.txt", { encoding: "utf8" }), "hello");

    const bytes = new Uint8Array([1, 2, 3]);
    await fs.writeFile("bin.dat", bytes);
    assert.deepEqual(await fs.readFile("bin.dat"), bytes);
  });

  it("appends, copies, moves, and deletes files", async () => {
    const { fs } = await tempFs();
    await fs.writeFile("a.txt", "a");
    await fs.appendFile("a.txt", "b");
    assert.equal(await fs.readFile("a.txt", { encoding: "utf8" }), "ab");

    await fs.copyFile("a.txt", "b.txt");
    assert.equal(await fs.readFile("b.txt", { encoding: "utf8" }), "ab");

    await fs.moveFile("b.txt", "c.txt");
    assert.equal(await fs.exists("b.txt"), false);
    assert.equal(await fs.readFile("c.txt", { encoding: "utf8" }), "ab");

    await fs.deleteFile("c.txt");
    assert.equal(await fs.exists("c.txt"), false);
  });

  it("creates directories and lists recursively with extension filters", async () => {
    const { fs } = await tempFs();
    await fs.mkdir("src", { recursive: true });
    await fs.writeFile("src/a.ts", "a");
    await fs.writeFile("src/b.js", "b");
    await fs.mkdir("src/nested", { recursive: true });
    await fs.writeFile("src/nested/c.ts", "c");

    const flat = await fs.readdir("src");
    assert.deepEqual(flat.map((e) => e.name).sort(), ["a.ts", "b.js", "nested"]);

    const nested = await fs.readdir("src", { recursive: true, extension: ".ts" });
    assert.deepEqual(nested.map((e) => e.name).sort(), ["a.ts", "nested", "nested/c.ts"]);
  });

  it("stats files and reports existence", async () => {
    const { fs } = await tempFs();
    await fs.writeFile("x.txt", "xyz");
    const info = await fs.stat("x.txt");
    assert.equal(info.type, "file");
    assert.equal(info.path, "x.txt");
    assert.equal(info.size, 3);
    assert.equal(await fs.exists("x.txt"), true);
    assert.equal(await fs.exists("missing.txt"), false);
  });

  it("refuses writes when read-only", async () => {
    const { fs } = await tempFs({ readOnly: true });
    await assert.rejects(
      () => fs.writeFile("x.txt", "nope"),
      (err: unknown) => err instanceof FileSystemError && err.code === "READ_ONLY",
    );
  });

  it("blocks path traversal when contained", async () => {
    const { fs } = await tempFs();
    assert.throws(
      () => fs.resolvePath("../outside.txt"),
      (err: unknown) => err instanceof FileSystemError && err.code === "PERMISSION_DENIED",
    );
  });

  it("does not follow a symlink escape when contained", async () => {
    const { fs, root } = await tempFs();
    const outside = await mkdtemp(path.join(tmpdir(), "dbx-local-fs-out-"));
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(root, "link"), "dir");
    await assert.rejects(
      () => fs.readFile("link/secret.txt"),
      (err: unknown) => err instanceof FileSystemError && err.code === "PERMISSION_DENIED",
    );
  });

  it("honors overwrite: false", async () => {
    const { fs } = await tempFs();
    await fs.writeFile("once.txt", "one");
    await assert.rejects(
      () => fs.writeFile("once.txt", "two", { overwrite: false }),
      (err: unknown) => err instanceof FileSystemError && err.code === "ALREADY_EXISTS",
    );
    assert.equal(await fs.readFile("once.txt", { encoding: "utf8" }), "one");
  });

  it("exposes an absolute root and local backend", async () => {
    const { fs, root } = await tempFs();
    assert.equal(fs.backend, "local");
    assert.equal(fs.root, root.replace(/\\/g, "/"));
    assert.match(fs.id, /^local-/);
  });

  it("creates parent directories on write", async () => {
    const { fs, root } = await tempFs();
    await fs.writeFile("deep/dir/file.txt", "ok");
    assert.equal(await readFile(path.join(root, "deep/dir/file.txt"), "utf8"), "ok");
  });

  it("removes directories recursively", async () => {
    const { fs } = await tempFs();
    await fs.writeFile("tree/a.txt", "a");
    await fs.writeFile("tree/nested/b.txt", "b");
    await fs.rmdir("tree", { recursive: true });
    assert.equal(await fs.exists("tree"), false);
  });

  it("auto-inits on first operation without an explicit init()", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dbx-local-fs-auto-"));
    const fs = new LocalFileSystem({ root });
    await fs.writeFile("auto.txt", "ready");
    assert.equal(await fs.readFile("auto.txt", { encoding: "utf8" }), "ready");
  });

  it("accepts backslash inputs as POSIX namespace paths", async () => {
    const { fs } = await tempFs();
    await fs.writeFile("dir\\nested.txt", "x");
    assert.equal(await fs.readFile("dir/nested.txt", { encoding: "utf8" }), "x");
  });
});

describe("homeFS / tmpFS", () => {
  it("roots a LocalFileSystem under home and temp", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "dbx-home-tmp-fs-"));
    const home = path.join(cwd, "home");
    const tmp = path.join(cwd, "tmp");
    clearOsPathsCache();
    try {
      const homeFs = homeFS("apps/demo", {
        os: { cwd, env: {}, homeDir: () => home, tmpDir: () => tmp },
      });
      await homeFs.init();
      assert.equal(homeFs.root, path.resolve(home, "apps/demo").replace(/\\/g, "/"));
      await homeFs.writeFile("note.txt", "home");
      assert.equal(await homeFs.readFile("note.txt", { encoding: "utf8" }), "home");

      const scratch = tmpFS("job-1", {
        os: { cwd, env: {}, homeDir: () => home, tmpDir: () => tmp },
      });
      await scratch.init();
      assert.equal(scratch.root, path.resolve(tmp, "job-1").replace(/\\/g, "/"));
      await scratch.writeFile("out.txt", "tmp");
      assert.equal(await scratch.readFile("out.txt", { encoding: "utf8" }), "tmp");
    } finally {
      clearOsPathsCache();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps absolute-looking roots under the base", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "dbx-home-fs-abs-"));
    const home = path.join(cwd, "home");
    clearOsPathsCache();
    try {
      const fs = homeFS("/escape/me", {
        os: { cwd, env: {}, homeDir: () => home, tmpDir: () => path.join(cwd, "tmp") },
      });
      assert.equal(fs.root, path.resolve(home, "escape/me").replace(/\\/g, "/"));
    } finally {
      clearOsPathsCache();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
