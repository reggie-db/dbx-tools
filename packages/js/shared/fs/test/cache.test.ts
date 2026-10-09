import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cache, type CacheValue, type FileSystemCache } from "../src/fs.ts";
import { MemoryFileSystem } from "../src/memory-fs.ts";

class TestCache implements FileSystemCache {
  readonly invalidations: string[] = [];
  readonly loads: string[] = [];
  private readonly values = new Map<string, CacheValue>();

  constructor(private readonly asyncKeys = false) {}

  read<T extends CacheValue>(key: string, load: () => T | Promise<T>): T | Promise<T> {
    if (this.values.has(key)) return this.values.get(key) as T;
    this.loads.push(key);
    const value = load();
    if (value instanceof Promise) {
      return value.then((resolved) => {
        this.values.set(key, resolved);
        return resolved;
      });
    }
    this.values.set(key, value);
    return value;
  }

  invalidate(key: string): void {
    this.invalidations.push(key);
    this.values.delete(key);
  }

  keys(): Iterable<string> | AsyncIterable<string> {
    if (this.asyncKeys) {
      const keys = [...this.values.keys()];
      return (async function* () {
        yield* keys;
      })();
    }
    return this.values.keys();
  }
}

describe("cache()", () => {
  it("caches exists, readdir, and stat by default", async () => {
    const source = new MemoryFileSystem({ root: "/cached" });
    await source.writeFile("note.txt", "one");
    const storage = new TestCache();
    const filesystem = cache(source, storage);

    assert.equal(await filesystem.exists("note.txt"), true);
    assert.equal(await filesystem.exists("note.txt"), true);
    assert.equal((await filesystem.stat("note.txt")).size, 3);
    assert.equal((await filesystem.stat("note.txt")).size, 3);
    assert.equal((await filesystem.readdir(".")).length, 1);
    assert.equal((await filesystem.readdir(".")).length, 1);

    assert.equal(storage.loads.length, 3);
    assert.ok(storage.loads.every((key) => /^[a-z0-9]+_\//.test(key)));
    assert.ok(storage.loads.some((key) => key.endsWith("_/cached/note.txt")));
  });

  it("invalidates cached paths after mutations", async () => {
    const source = new MemoryFileSystem({ root: "/cached" });
    await source.writeFile("note.txt", "one");
    const storage = new TestCache(true);
    const first = cache(source, storage);
    const second = cache(source, storage);

    assert.equal((await first.stat("note.txt")).size, 3);
    assert.equal((await first.stat("note.txt")).size, 3);
    await second.writeFile("note.txt", "updated");
    assert.equal((await first.stat("note.txt")).size, 7);

    assert.equal(storage.loads.length, 2);
    assert.equal(storage.invalidations.length, 1);
  });

  it("invalidates ancestors and descendants for directory mutations", async () => {
    const source = new MemoryFileSystem({ root: "/cached" });
    await source.writeFile("old/nested/note.txt", "one");
    await source.writeFile("unrelated.txt", "keep");
    const storage = new TestCache();
    const filesystem = cache(source, storage);

    await filesystem.readdir(".");
    await filesystem.readdir("old");
    await filesystem.stat("old/nested/note.txt");
    await filesystem.stat("unrelated.txt");
    await filesystem.rmdir("old", { recursive: true });

    assert.ok(storage.invalidations.some((key) => key.endsWith("_/cached")));
    assert.ok(storage.invalidations.some((key) => key.endsWith("_/cached/old")));
    assert.ok(storage.invalidations.some((key) => key.endsWith("_/cached/old/nested/note.txt")));
    assert.ok([...storage.keys()].some((key) => key.endsWith("_/cached/unrelated.txt")));
  });

  it("invalidates both directory trees when a directory is moved", async () => {
    const source = new MemoryFileSystem({ root: "/cached" });
    await source.writeFile("old/nested/note.txt", "one");
    await source.mkdir("new");
    source.moveFile = async () => {};
    const storage = new TestCache();
    const filesystem = cache(source, storage);

    await filesystem.stat("old/nested/note.txt");
    await filesystem.stat("new");
    await filesystem.moveFile("old", "new");

    assert.ok(storage.invalidations.some((key) => key.endsWith("_/cached/old/nested/note.txt")));
    assert.ok(storage.invalidations.some((key) => key.endsWith("_/cached/new")));
  });

  it("caches additional reads only when configured and delegates concrete members", async () => {
    const source = new MemoryFileSystem({ root: "/cached" });
    await source.writeFile("note.txt", "one");
    const storage = new TestCache();
    const filesystem = cache(source, storage, {
      operations: ["readFile"],
    });

    assert.equal(await filesystem.readFile("note.txt", { encoding: "utf8" }), "one");
    assert.equal(await filesystem.readFile("note.txt", { encoding: "utf8" }), "one");
    assert.equal(storage.loads.length, 1);
    await filesystem.stat("note.txt");
    await filesystem.stat("note.txt");
    assert.equal(storage.loads.length, 1);

    filesystem.clear();
    assert.equal(await filesystem.exists("note.txt"), false);
  });
});
