import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hash } from "@dbx-tools/shared-core";
import { MemoryFileSystem } from "../src/memory-fs.ts";
import { normalizeFileSystemRoot } from "../src/base-fs.ts";

describe("normalizeFileSystemRoot", () => {
  it("keeps valid path segments and preserves a leading slash", () => {
    assert.equal(normalizeFileSystemRoot("/cool/wow"), "/cool/wow");
    assert.equal(normalizeFileSystemRoot(["/cool/wow"]), "/cool/wow");
  });

  it("splits strings on / and hashes invalid segments", () => {
    const invalid = "git:@''''wow";
    assert.equal(
      normalizeFileSystemRoot("path/git:@''''wow/test"),
      `path/${hash.fnvHash(invalid)}/test`,
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
