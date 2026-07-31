import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hash } from "@dbx-tools/shared-core";
import { normalizeFileSystemRoot } from "../src/base-fs.ts";
import { MemoryFileSystem } from "../src/memory-fs.ts";

describe("normalizeFileSystemRoot", () => {
  it("keeps valid path segments and preserves a leading slash", () => {
    assert.equal(normalizeFileSystemRoot("/cool/wow"), "/cool/wow");
    assert.equal(normalizeFileSystemRoot(["/cool/wow"]), "/cool/wow");
  });

  it("keeps segments that are unusual but legal on a real backend", () => {
    // Deny-list, not allow-list: hashing one of these would silently point the
    // filesystem at a directory that does not exist.
    assert.equal(
      normalizeFileSystemRoot("/Workspace/Users/me@corp.com/My Notes"),
      "/Workspace/Users/me@corp.com/My Notes",
    );
    assert.equal(normalizeFileSystemRoot("path/git:@''''wow/test"), "path/git:@''''wow/test");
    assert.equal(normalizeFileSystemRoot("/data/rapports été (2024)"), "/data/rapports été (2024)");
  });

  it("splits on / and drops no-op . segments", () => {
    assert.equal(normalizeFileSystemRoot("a/./b"), "a/b");
    assert.equal(normalizeFileSystemRoot("//a//b//"), "/a/b");
  });

  it("hashes segments that cannot be a path component", () => {
    // `..` would traverse above the root; a control character is rejected by
    // every backend. Both stay visible as a hash rather than being dropped.
    assert.equal(normalizeFileSystemRoot(["/root", ".."]), `/root/${hash.fnvHash("..")}`);
    assert.equal(
      normalizeFileSystemRoot(["/root", "a\u0000b"]),
      `/root/${hash.fnvHash("a\u0000b")}`,
    );
  });

  it("stringifies primitives and hashes objects when joining", () => {
    const user = { id: 42, name: "ada" };
    const digest = hash.fnvHash(user);
    assert.equal(
      normalizeFileSystemRoot(["/path/segment", user, true, 1]),
      `/path/segment/${digest}/true/1`,
    );
  });

  it("hashes nested arrays as a single segment", () => {
    const nested = [1, { a: 2 }];
    assert.equal(normalizeFileSystemRoot(["/root", nested]), `/root/${hash.fnvHash(nested)}`);
  });

  it("defaults to / when omitted", () => {
    assert.equal(normalizeFileSystemRoot(), "/");
  });
});

describe("MemoryFileSystem composite roots", () => {
  it("accepts a segmented root", async () => {
    const scope = { tenant: "acme" };
    const fs = new MemoryFileSystem({ root: ["/data", scope, false] });
    assert.equal(fs.root, `/data/${hash.fnvHash(scope)}/false`);
    await fs.writeFile("note.txt", "hi");
    assert.equal(await fs.readFile("note.txt", { encoding: "utf8" }), "hi");
  });
});
