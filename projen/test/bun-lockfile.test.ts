/** `bun.lock` normalization rewrites only the detected private registry. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { normalizeBunLockfile, normalizeBunLockfileAt } from "../src/bun-lockfile.ts";

const MIRROR = "https://mirror.example.test/npm";
const LOCK = [
  "{",
  '  "packages": {',
  `    "zod": ["zod@4.1.0", "${MIRROR}/zod/-/zod-4.1.0.tgz", {}, "sha512-a"],`,
  `    "@scope/pkg": ["@scope/pkg@1.0.0", "${MIRROR}/@scope/pkg/-/pkg-1.0.0.tgz", {}, "sha512-b"],`,
  '    "left": ["left@1.0.0", "https://registry.npmjs.org/left/-/left-1.0.0.tgz", {}, "sha512-c"],',
  '    "other": ["other@1.0.0", "https://other.example.test/other/-/other-1.0.0.tgz", {}, "sha512-d"],',
  '    "ws": ["ws@workspace:packages/ws"],',
  "  }",
  "}",
  "",
].join("\n");

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("normalizeBunLockfile", () => {
  it("empties tarball URLs under the registry and leaves other URLs", () => {
    const result = normalizeBunLockfile(LOCK, [MIRROR]);
    assert.equal(result.rewritten, 2);
    assert.match(result.content, /"zod@4\.1\.0", "", \{\}, "sha512-a"/);
    assert.match(result.content, /"@scope\/pkg@1\.0\.0", "", \{\}, "sha512-b"/);
    assert.match(result.content, /registry\.npmjs\.org\/left/);
    assert.match(result.content, /other\.example\.test\/other/);
    assert.doesNotMatch(result.content, /mirror\.example\.test/);
  });

  it("rewrites to public npm tarballs on request", () => {
    const result = normalizeBunLockfile(LOCK, [`${MIRROR}/`], "npmjs");
    assert.match(
      result.content,
      /"@scope\/pkg@1\.0\.0", "https:\/\/registry\.npmjs\.org\/@scope\/pkg\/-\/pkg-1\.0\.0\.tgz"/,
    );
    assert.doesNotMatch(result.content, /mirror\.example\.test/);
  });

  it("is a no-op without a private registry", () => {
    assert.equal(normalizeBunLockfile(LOCK, []).content, LOCK);
  });
});

describe("normalizeBunLockfileAt", () => {
  const withLock = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "bun-lockfile-"));
    temps.push(dir);
    writeFileSync(join(dir, "bun.lock"), LOCK);
    return dir;
  };

  it("uses configured registries, honors check, and is idempotent", () => {
    const dir = withLock();
    const options = { mode: "off" as const, registries: [MIRROR] };
    assert.equal(normalizeBunLockfileAt(dir, options).changed, false);

    const auto = { registries: [MIRROR] };
    const checked = normalizeBunLockfileAt(dir, { ...auto, check: true });
    assert.equal(checked.changed, true);
    assert.equal(readFileSync(join(dir, "bun.lock"), "utf8"), LOCK);

    assert.equal(normalizeBunLockfileAt(dir, auto).changed, true);
    assert.doesNotMatch(readFileSync(join(dir, "bun.lock"), "utf8"), /mirror\.example\.test/);
    assert.equal(normalizeBunLockfileAt(dir, auto).changed, false);
  });
});
