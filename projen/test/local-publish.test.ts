import assert from "node:assert/strict";
import { basename, dirname } from "node:path";
import { describe, it } from "node:test";
import { localPublishTaskPath, resolveLocalRegistry } from "../tasks/local-publish.ts";

describe("local release publication", () => {
  it("disables local npm publication explicitly", () => {
    assert.equal(resolveLocalRegistry("false"), undefined);
    assert.equal(resolveLocalRegistry(""), undefined);
  });

  it("keeps an explicit local npm registry unchanged", () => {
    assert.equal(resolveLocalRegistry("http://127.0.0.1:4873"), "http://127.0.0.1:4873");
  });

  it("resolves flattened publish tasks as siblings", () => {
    const npm = localPublishTaskPath("publish.ts");
    const python = localPublishTaskPath("publish-python.ts");
    assert.equal(dirname(npm), dirname(python));
    assert.equal(basename(npm), "publish.ts");
    assert.equal(basename(python), "publish-python.ts");
  });
});
