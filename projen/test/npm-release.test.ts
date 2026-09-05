import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";

import {
  npmReleaseMatches,
  readNpmArchiveIdentity,
  type NpmReleaseIdentity,
} from "../tasks/publish-npm.ts";

let outdir: string;
let archive: string;
let identity: NpmReleaseIdentity;

before(() => {
  outdir = mkdtempSync(join(tmpdir(), "npm-release-"));
  const packageDir = join(outdir, "package");
  mkdirSync(packageDir);
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify({
      name: "@fixture/native",
      version: "1.2.3",
      repository: "git+https://github.com/example/fixture.git",
    })}\n`,
  );
  archive = join(outdir, "fixture.tgz");
  const packed = spawnSync("tar", ["-czf", archive, "-C", outdir, "package"]);
  assert.equal(packed.status, 0);
  identity = readNpmArchiveIdentity(archive);
});

after(() => {
  rmSync(outdir, { recursive: true, force: true });
});

describe("npm release recovery", () => {
  it("reads and matches an exact staged archive", () => {
    assert.equal(identity.name, "@fixture/native");
    assert.equal(identity.version, "1.2.3");
    assert.match(identity.integrity!, /^sha512-/);
    assert.equal(
      npmReleaseMatches(identity, {
        ...identity,
        repository: "https://github.com/example/fixture",
      }),
      true,
    );
  });

  it("publishes an absent version", () => {
    assert.equal(npmReleaseMatches(identity, undefined), false);
  });

  it("rejects an existing version with different content", () => {
    assert.throws(
      () => npmReleaseMatches(identity, { ...identity, integrity: "sha512-different" }),
      /integrity does not match/,
    );
  });

  it("rejects an existing version from another repository", () => {
    assert.throws(
      () =>
        npmReleaseMatches(identity, {
          ...identity,
          repository: "https://github.com/example/other",
        }),
      /repository does not match/,
    );
  });
});
