import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as posixPath from "../src/posix-path.ts";

describe("posixPath", () => {
  it("converts backslashes and host separators", () => {
    assert.equal(posixPath.toPosix("C:\\Users\\x"), "C:/Users/x");
    assert.equal(posixPath.toHost("C:/Users/x", "\\"), "C:\\Users\\x");
    assert.equal(posixPath.toHost("s3://bucket/key", "\\"), "s3://bucket\\key");
    assert.equal(posixPath.toHost("/var/data", "/"), "/var/data");
  });

  it("normalizes roots", () => {
    assert.equal(posixPath.normalizeRoot("/var/data/"), "/var/data");
    assert.equal(posixPath.normalizeRoot("C:\\Users\\x\\"), "C:/Users/x");
    assert.equal(posixPath.normalizeRoot("s3://bucket/prefix/"), "s3://bucket/prefix");
    assert.equal(posixPath.normalizeRoot("/"), "/");
    assert.equal(posixPath.normalizeRoot("C:/"), "C:/");
  });

  it("joins and normalizes namespace paths", () => {
    assert.equal(posixPath.join("/var/data", "a", "b"), "/var/data/a/b");
    assert.equal(posixPath.join("C:/root", "a\\b"), "C:/root/a/b");
    assert.deepEqual(posixPath.normalize("a/../b/./c"), { ok: true, path: "/b/c" });
    assert.deepEqual(posixPath.normalize("a\\b\\..\\c"), { ok: true, path: "/a/c" });
    assert.deepEqual(posixPath.normalize("../x"), { ok: false, escape: true });
  });

  it("computes dirname, basename, and containment", () => {
    assert.equal(posixPath.dirname("/a/b/c"), "/a/b");
    assert.equal(posixPath.dirname("/a"), "/");
    assert.equal(posixPath.basename("/a/b/c"), "c");
    assert.equal(posixPath.relative("/var/data", "/var/data/a/b"), "a/b");
    assert.equal(posixPath.relative("/var/data", "/other"), undefined);
    assert.equal(posixPath.isWithinRoot("/var/data", "/var/data/a"), true);
    assert.equal(posixPath.isWithinRoot("/var/data", "/var"), false);
  });
});
