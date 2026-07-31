import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FileSystemError } from "../src/base-fs.ts";
import { MemoryFileSystem } from "../src/memory-fs.ts";

describe("MemoryFileSystem", () => {
  it("writes nested files by creating parents automatically", async () => {
    const fs = new MemoryFileSystem();
    await fs.writeFile("deep/dir/file.txt", "hello");
    assert.equal(await fs.readFile("deep/dir/file.txt", { encoding: "utf8" }), "hello");
    assert.equal(await fs.exists("deep/dir"), true);
  });

  it("appends, copies, and moves without native try* hooks", async () => {
    const fs = new MemoryFileSystem();
    await fs.writeFile("a.txt", "a");
    await fs.appendFile("a.txt", "b");
    assert.equal(await fs.readFile("a.txt", { encoding: "utf8" }), "ab");

    await fs.copyFile("a.txt", "nested/b.txt");
    assert.equal(await fs.readFile("nested/b.txt", { encoding: "utf8" }), "ab");

    await fs.moveFile("nested/b.txt", "nested/c.txt");
    assert.equal(await fs.exists("nested/b.txt"), false);
    assert.equal(await fs.readFile("nested/c.txt", { encoding: "utf8" }), "ab");
  });

  it("lists recursively with extension filters and removes trees", async () => {
    const fs = new MemoryFileSystem();
    await fs.writeFile("src/a.ts", "a");
    await fs.writeFile("src/b.js", "b");
    await fs.writeFile("src/nested/c.ts", "c");

    const nested = await fs.readdir("src", { recursive: true, extension: ".ts" });
    assert.deepEqual(nested.map((e) => e.name).sort(), ["a.ts", "nested", "nested/c.ts"]);

    await fs.rmdir("src", { recursive: true });
    assert.equal(await fs.exists("src"), false);
  });

  it("blocks path escapes and honors read-only", async () => {
    const fs = new MemoryFileSystem();
    assert.throws(
      () => fs.resolvePath("../outside"),
      (err: unknown) => err instanceof FileSystemError && err.code === "PERMISSION_DENIED",
    );

    const locked = new MemoryFileSystem({ readOnly: true });
    await assert.rejects(
      () => locked.writeFile("x.txt", "nope"),
      (err: unknown) => err instanceof FileSystemError && err.code === "READ_ONLY",
    );
  });

  it("auto-inits without an explicit init()", async () => {
    const fs = new MemoryFileSystem();
    await fs.writeFile("auto.txt", "ready");
    assert.equal(await fs.readFile("auto.txt", { encoding: "utf8" }), "ready");
  });

  it("clears contents while keeping the root", async () => {
    const fs = new MemoryFileSystem();
    await fs.writeFile("a.txt", "a");
    fs.clear();
    assert.equal(await fs.exists("a.txt"), false);
    assert.equal(fs.root, "/memory");
    await fs.writeFile("b.txt", "b");
    assert.equal(await fs.readFile("b.txt", { encoding: "utf8" }), "b");
  });

  it("exposes a memory backend and stable id", async () => {
    const fs = new MemoryFileSystem({ root: "/tmp/virtual" });
    assert.equal(fs.backend, "memory");
    assert.equal(fs.root, "/tmp/virtual");
    assert.match(fs.id, /^memory-/);
  });
});
