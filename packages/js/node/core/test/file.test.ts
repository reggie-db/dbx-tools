import assert from "node:assert/strict";
import { join, parse, resolve } from "node:path";
import { describe, it } from "node:test";

import { file } from "../index.ts";

describe("relativePathWithin", () => {
  const root = resolve("boundary");

  it("returns an empty path for the boundary itself", () => {
    assert.equal(file.relativePathWithin(root, root), "");
    assert.equal(file.relativePathWithin(root, join(root, "child", "..")), "");
  });

  it("returns normalized host-relative descendants", () => {
    assert.equal(file.relativePathWithin(root, join(root, "child", "file")), join("child", "file"));
    assert.equal(file.relativePathWithin(root, join(root, "child", "..", "file")), "file");
    assert.equal(file.relativePathWithin("boundary", join("boundary", "child")), "child");
  });

  it("accepts names beginning with two dots", () => {
    assert.equal(
      file.relativePathWithin(root, join(root, "..cache", "file")),
      join("..cache", "file"),
    );
    assert.equal(file.relativePathWithin(root, join(root, "...")), "...");
  });

  it("rejects the parent, siblings, and sibling prefixes", () => {
    assert.equal(file.relativePathWithin(root, resolve(root, "..")), undefined);
    assert.equal(file.relativePathWithin(root, resolve(root, "..", "sibling")), undefined);
    assert.equal(file.relativePathWithin(root, `${root}-sibling`), undefined);
    assert.equal(
      file.relativePathWithin(root, resolve(root, "child", "..", "..", "outside")),
      undefined,
    );
  });

  it("handles a filesystem root without adding an extra separator", () => {
    const filesystemRoot = parse(root).root;
    assert.equal(file.relativePathWithin(filesystemRoot, filesystemRoot), "");
    assert.equal(file.relativePathWithin(filesystemRoot, join(filesystemRoot, "child")), "child");
  });

  it("rejects different Windows drives", { skip: process.platform !== "win32" }, () => {
    assert.equal(file.relativePathWithin("C:\\boundary", "D:\\boundary\\child"), undefined);
  });
});

describe("cachedRecord", () => {
  it("caches parsed records, including empty records", () => {
    let calls = 0;
    const key = `test:${crypto.randomUUID()}`;
    const first = file.cachedRecord(key, () => {
      calls += 1;
      return {};
    });
    const second = file.cachedRecord(key, () => {
      calls += 1;
      return { changed: true };
    });
    assert.deepEqual(first, {});
    assert.equal(second, first);
    assert.equal(calls, 1);
  });

  it("caches an undefined result", () => {
    let calls = 0;
    const key = `test:${crypto.randomUUID()}`;
    assert.equal(
      file.cachedRecord(key, () => {
        calls += 1;
        return undefined;
      }),
      undefined,
    );
    assert.equal(
      file.cachedRecord(key, () => {
        calls += 1;
        return { found: true };
      }),
      undefined,
    );
    assert.equal(calls, 1);
  });
});
