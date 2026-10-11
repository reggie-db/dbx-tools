import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { compiledPublishTargetExists } from "../tasks/publish.ts";

let outdir: string;

before(() => {
  outdir = mkdtempSync(join(tmpdir(), "publish-target-"));
  mkdirSync(join(outdir, "lib/src/nested/deeper"), { recursive: true });
  writeFileSync(join(outdir, "lib/index.js"), "");
  writeFileSync(join(outdir, "lib/src/nested/deeper/index.js"), "");
});

after(() => {
  rmSync(outdir, { recursive: true, force: true });
});

describe("compiled publish target validation", () => {
  it("checks exact compiled targets", () => {
    assert.equal(compiledPublishTargetExists(outdir, "./lib/index.js"), true);
    assert.equal(compiledPublishTargetExists(outdir, "./lib/index.d.ts"), false);
  });

  it("validates the compiled root for optional export wildcards", () => {
    assert.equal(compiledPublishTargetExists(outdir, "./lib/src/*/index.js"), true);
    assert.equal(compiledPublishTargetExists(outdir, "./missing/*/index.js"), false);
  });
});
