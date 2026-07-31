import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryFileSystem } from "@dbx-tools/shared-fs";
import { FileExistsError, FileNotFoundError, WorkspaceReadOnlyError } from "@mastra/core/workspace";

import { filesystems, scratchFilesystem } from "../src/filesystems.ts";

describe("filesystems()", () => {
  it("wraps a shared-fs FileSystem as a Mastra filesystem", async () => {
    const memory = new MemoryFileSystem({ root: "/workspace" });
    const mount = filesystems(memory, { id: "test-fs" });

    assert.equal(mount.id, "test-fs");
    assert.equal(mount.provider, "memory");
    assert.equal(mount.basePath, "/workspace");
    assert.equal(mount.readOnly, false);

    await mount._init();
    await mount.writeFile("/notes/hello.txt", "hi");
    assert.equal(await mount.readFile("/notes/hello.txt", { encoding: "utf8" }), "hi");

    const binary = await mount.readFile("/notes/hello.txt");
    assert.ok(Buffer.isBuffer(binary));
    assert.equal(binary.toString("utf8"), "hi");

    assert.equal(await mount.exists("/notes/hello.txt"), true);
    assert.equal((await mount.stat("/notes/hello.txt")).type, "file");
    assert.deepEqual(
      (await mount.readdir("/notes")).map((entry) => entry.name),
      ["hello.txt"],
    );

    await mount.appendFile("/notes/hello.txt", "!");
    assert.equal(await mount.readFile("/notes/hello.txt", { encoding: "utf8" }), "hi!");

    await mount.copyFile("/notes/hello.txt", "/notes/copy.txt");
    await mount.moveFile("/notes/copy.txt", "/notes/moved.txt");
    assert.equal(await mount.exists("/notes/copy.txt"), false);
    assert.equal(await mount.readFile("/notes/moved.txt", { encoding: "utf8" }), "hi!");

    await mount.deleteFile("/notes/moved.txt");
    assert.equal(await mount.exists("/notes/moved.txt"), false);

    await mount._destroy();
  });

  it("maps shared-fs errors onto Mastra filesystem errors", async () => {
    const mount = filesystems(new MemoryFileSystem());
    await mount._init();

    await assert.rejects(() => mount.readFile("/missing.txt"), FileNotFoundError);

    await mount.writeFile("/once.txt", "a", { overwrite: false });
    await assert.rejects(
      () => mount.writeFile("/once.txt", "b", { overwrite: false }),
      FileExistsError,
    );
  });

  it("honors readOnly mounts", async () => {
    const memory = new MemoryFileSystem();
    await memory.init();
    await memory.writeFile("seed.txt", "seed");

    const mount = filesystems(memory, { readOnly: true });
    await mount._init();

    assert.equal(await mount.readFile("/seed.txt", { encoding: "utf8" }), "seed");
    await assert.rejects(() => mount.writeFile("/nope.txt", "x"), WorkspaceReadOnlyError);
  });

  it("scratchFilesystem is a fresh writable tmpFS mount", async () => {
    const a = scratchFilesystem();
    const b = scratchFilesystem();
    assert.notEqual(a.basePath, b.basePath);
    assert.match(a.basePath, /mastra-/);

    await a._init();
    await a.writeFile("/note.txt", "hi");
    assert.equal(await a.readFile("/note.txt", { encoding: "utf8" }), "hi");
    await a._destroy();
  });
});
